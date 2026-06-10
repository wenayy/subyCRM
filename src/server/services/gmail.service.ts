import { google } from "googleapis";
import { createHmac } from "crypto";
import { prisma } from "../lib/prisma";
import { inboxService } from "./inbox.service";
import { encrypt, decrypt } from "../lib/encryption";

// gmail.modify covers read + send + label changes. gmail.readonly is a subset of this
// so existing tokens are still valid for reading; users only need to re-authorize once
// to gain send access.
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const REDIRECT_URI = `${process.env.AUTH_BASE_URL || "http://localhost:4002"}/api/gmail/callback`;
const STATE_SECRET = process.env.BETTER_AUTH_SECRET || "suby-gmail-state-secret";

function oauthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    REDIRECT_URI,
  );
}

export function buildState(userId: string): string {
  const payload = `${userId}:${Date.now()}`;
  const sig = createHmac("sha256", STATE_SECRET).update(payload).digest("hex");
  return Buffer.from(`${payload}:${sig}`).toString("base64url");
}

export function verifyState(state: string): string | null {
  try {
    const decoded = Buffer.from(state, "base64url").toString("utf8");
    const parts = decoded.split(":");
    if (parts.length !== 3) return null;
    const [userId, ts, sig] = parts;
    if (Date.now() - parseInt(ts) > 15 * 60_000) return null;
    const expected = createHmac("sha256", STATE_SECRET).update(`${userId}:${ts}`).digest("hex");
    if (sig !== expected) return null;
    return userId;
  } catch {
    return null;
  }
}

export function buildAuthUrl(userId: string): string {
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    scope: GMAIL_SCOPE,
    prompt: "consent",
    state: buildState(userId),
  });
}

export async function exchangeCode(code: string) {
  const { tokens } = await oauthClient().getToken(code);
  return tokens;
}

export async function saveTokens(
  userId: string,
  tokens: { access_token?: string | null; refresh_token?: string | null; expiry_date?: number | null },
) {
  await (prisma as any).gmailToken.upsert({
    where: { userId },
    create: {
      userId,
      accessToken: encrypt(tokens.access_token!),
      refreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
      expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    },
    update: {
      accessToken: encrypt(tokens.access_token!),
      ...(tokens.refresh_token ? { refreshToken: encrypt(tokens.refresh_token) } : {}),
      expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    },
  });
}

export async function getStatus(userId: string) {
  const token = await (prisma as any).gmailToken.findUnique({ where: { userId } });
  return { connected: !!token, lastSync: (token as any)?.lastSyncAt?.toISOString() ?? null };
}

async function authedClient(userId: string) {
  const token = await (prisma as any).gmailToken.findUnique({ where: { userId } });
  if (!token) throw new Error("Gmail not connected");

  const client = oauthClient();
  client.setCredentials({
    access_token: decrypt((token as any).accessToken),
    refresh_token: (token as any).refreshToken ? decrypt((token as any).refreshToken) : null,
    expiry_date: (token as any).expiresAt?.getTime(),
  });

  client.on("tokens", async (fresh) => {
    if (fresh.access_token) await saveTokens(userId, fresh);
  });

  return client;
}

function extractEmails(raw: string): string[] {
  return [...raw.matchAll(/[\w.+%-]+@[\w.-]+\.[a-z]{2,}/gi)].map((m) => m[0].toLowerCase());
}

// Recursively find text/plain content from a message payload
function extractPlainText(payload: any): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const t = extractPlainText(part);
      if (t) return t;
    }
  }
  return "";
}

// Strip quoted reply blocks and decode HTML entities
function cleanEmailText(raw: string): string {
  let text = raw
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

  // Remove "On [date], [name] <email> wrote:" block and everything after it
  text = text.replace(/(\r?\n)?On .{10,300}wrote:\s*\r?\n[\s\S]*/m, "");
  // Remove lines starting with ">" (quoted lines)
  text = text.split("\n").filter((l) => !l.trimStart().startsWith(">")).join("\n");
  // Collapse excessive blank lines
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

export async function syncThreads(userId: string): Promise<number> {
  console.log("[syncThreads] starting for user", userId);
  const client = await authedClient(userId);
  const gmail = google.gmail({ version: "v1", auth: client });

  // Build contact email map (scoped to this user)
  const contacts = await prisma.contact.findMany({
    where: { userId },
    include: { platforms: { where: { type: "email" } } },
  });
  const emailMap = new Map<string, { id: string; name: string }>();
  for (const c of contacts) {
    for (const p of c.platforms) {
      emailMap.set(p.platformId.toLowerCase(), { id: c.id, name: c.name });
    }
  }

  const myEmails = new Set(
    (process.env.AUTH_ALLOWED_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
  );

  // Fetch all threads from the last 90 days (paginate to catch everything)
  const afterTs = Math.floor((Date.now() - 90 * 86400_000) / 1000);
  const threads: { id?: string | null }[] = [];
  let pageToken: string | undefined;
  do {
    const listRes = await gmail.users.threads.list({
      userId: "me",
      maxResults: 500,
      q: `after:${afterTs} -category:promotions -category:social`,
      ...(pageToken ? { pageToken } : {}),
    });
    threads.push(...(listRes.data.threads ?? []));
    pageToken = listRes.data.nextPageToken ?? undefined;
  } while (pageToken);
  console.log(`[syncThreads] ${threads.length} threads from Gmail`);

  // All thread IDs from Gmail — used for deletion check later
  const gmailThreadIdSet = new Set(threads.map((t) => t.id).filter(Boolean) as string[]);

  // gmailThread table rows (one per thread, for legacy contact page)
  const rows: {
    threadId: string; subject: string | null; snippet: string | null;
    contactId: string | null; contactEmail: string | null;
    fromEmail: string | null; lastDate: Date; messageCount: number;
  }[] = [];

  for (const t of threads) {
    if (!t.id) continue;
    try {
      const detail = await gmail.users.threads.get({
        userId: "me",
        id: t.id,
        format: "full",   // full gives us decoded bodies, not just snippet
      });

      const msgs = detail.data.messages ?? [];
      if (!msgs.length) continue;

      const firstMsg = msgs[0];
      const lastMsg = msgs[msgs.length - 1];

      const getHeader = (msg: any, name: string) =>
        (msg.payload?.headers ?? []).find((h: any) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null;

      const subject = getHeader(firstMsg, "Subject");
      const fromRaw  = getHeader(firstMsg, "From") ?? "";
      const toRaw    = getHeader(firstMsg, "To") ?? "";
      const ccRaw    = getHeader(firstMsg, "Cc") ?? "";
      const dateStr  = getHeader(firstMsg, "Date");

      const fromEmail = extractEmails(fromRaw)[0] ?? null;
      const allEmails = [...extractEmails(fromRaw), ...extractEmails(toRaw), ...extractEmails(ccRaw)];

      // Match first non-self email against contacts
      let matched: { id: string; name: string } | null = null;
      let matchedEmail: string | null = null;
      for (const email of allEmails) {
        if (myEmails.has(email)) continue;
        if (emailMap.has(email)) { matched = emailMap.get(email)!; matchedEmail = email; break; }
      }

      const threadLastDate = dateStr ? new Date(dateStr) : new Date();
      rows.push({
        threadId: t.id, subject,
        snippet: lastMsg.snippet ?? null,
        contactId: matched?.id ?? null, contactEmail: matchedEmail, fromEmail,
        lastDate: isNaN(threadLastDate.getTime()) ? new Date() : threadLastDate,
        messageCount: msgs.length,
      });

      // ── Per-message inbox records ─────────────────────────────────────────────
      // Each individual email becomes its own inbox message so the full thread is visible.
      // externalId = "${threadId}:${messageId}" — threadId prefix is used for reply routing.
      for (const message of msgs) {
        const msgId = message.id;
        if (!msgId) continue;

        const msgFromRaw = getHeader(message, "From") ?? "";
        const msgDateStr = getHeader(message, "Date");
        const msgDate = msgDateStr ? new Date(msgDateStr) : (isNaN(threadLastDate.getTime()) ? new Date() : threadLastDate);
        const msgFromEmail = extractEmails(msgFromRaw)[0] ?? null;
        const msgFromMe = myEmails.has(msgFromEmail?.toLowerCase() ?? "");

        // Contact match: re-check per message (for threads with multiple participants)
        const msgToRaw  = getHeader(message, "To")  ?? "";
        const msgCcRaw  = getHeader(message, "Cc")  ?? "";
        const msgAllEmails = [...extractEmails(msgFromRaw), ...extractEmails(msgToRaw), ...extractEmails(msgCcRaw)];
        let msgMatched = matched;
        let msgMatchedEmail = matchedEmail;
        if (!msgMatched) {
          for (const e of msgAllEmails) {
            if (myEmails.has(e)) continue;
            if (emailMap.has(e)) { msgMatched = emailMap.get(e)!; msgMatchedEmail = e; break; }
          }
        }

        // Extract and clean the body
        let body = extractPlainText(message.payload);
        if (!body) body = message.snippet ?? "";
        body = cleanEmailText(body);

        const contactEmail = msgMatchedEmail ?? (msgFromMe ? null : msgFromEmail);

        await inboxService.upsert({
          platform: "email",
          externalId: `${t.id}:${msgId}`,
          userId,
          contactId: msgMatched?.id ?? null,
          contactName: contactEmail ?? msgMatched?.name ?? "Unknown",
          senderId: msgMatched ? undefined : (contactEmail ?? undefined),
          preview: subject ?? body.slice(0, 120),
          body,
          receivedAt: isNaN(msgDate.getTime()) ? new Date() : msgDate,
          fromMe: msgFromMe,
        });
      }

      // Remove old thread-level record (externalId = threadId without ":") now that
      // we store per-message records instead
      await (prisma as any).inboxMessage.deleteMany({
        where: { userId, platform: "email", externalId: t.id },
      });

    } catch (err) {
      console.warn(`[syncThreads] skipped thread ${t.id}:`, (err as Error).message);
    }
  }

  console.log(`[syncThreads] saving ${rows.length} thread metadata rows...`);
  const threadIds = rows.map((r) => r.threadId);
  await (prisma as any).gmailThread.deleteMany({ where: { threadId: { in: threadIds } } });
  await (prisma as any).gmailThread.createMany({ data: rows, skipDuplicates: true });

  // ── Sync deletions ────────────────────────────────────────────────────────────
  // Remove inbox records whose thread no longer exists in Gmail (deleted / trashed).
  // externalId format is "${threadId}:${messageId}" — extract the threadId prefix.
  const afterDate = new Date(Date.now() - 90 * 86400_000);
  const existing = await (prisma as any).inboxMessage.findMany({
    where: {
      userId, platform: "email", receivedAt: { gte: afterDate },
      NOT: { externalId: { startsWith: "sent-" } },
    },
    select: { id: true, externalId: true },
  });
  const toDeleteIds = (existing as { id: string; externalId: string }[])
    .filter(({ externalId }) => {
      const threadId = externalId.includes(":") ? externalId.split(":")[0] : externalId;
      return !gmailThreadIdSet.has(threadId);
    })
    .map(({ id }) => id);

  if (toDeleteIds.length > 0) {
    await (prisma as any).inboxMessage.deleteMany({ where: { id: { in: toDeleteIds } } });
    console.log(`[syncThreads] removed ${toDeleteIds.length} deleted/trashed message(s) from inbox`);
    const { broadcastInboxEvent } = await import("./sse.service");
    broadcastInboxEvent("conversations_changed", {});
  }

  // Clean up gmailThread records that no longer exist in Gmail
  await (prisma as any).gmailThread.deleteMany({
    where: {
      lastDate: { gte: afterDate },
      NOT: { threadId: { in: Array.from(gmailThreadIdSet) } },
    },
  });

  await (prisma as any).gmailToken.updateMany({
    where: { userId },
    data: { lastSyncAt: new Date() },
  });

  console.log(`[syncThreads] done`);
  return rows.length;
}

export async function getThreads(contactId?: string) {
  return (prisma as any).gmailThread.findMany({
    where: contactId ? { contactId } : {},
    orderBy: { lastDate: "desc" },
    take: 100,
  });
}

// Send a reply via the user's connected Gmail OAuth account.
// Using the Gmail API (not SMTP) means the email is sent from the user's own
// address and the threadId keeps it in the right conversation thread.
export async function sendEmailViaGmailApi(
  userId: string,
  params: { to: string; subject: string; text: string; threadId?: string }
): Promise<void> {
  console.log(`[gmail] sendEmailViaGmailApi userId=${userId} to=${params.to} threadId=${params.threadId ?? "none"}`);
  let client: Awaited<ReturnType<typeof authedClient>>;
  try {
    client = await authedClient(userId);
  } catch {
    throw new Error("Gmail not connected — go to Settings → Gmail to reconnect.");
  }

  const gmail = google.gmail({ version: "v1", auth: client });

  const emailLines = [
    `To: ${params.to}`,
    `Subject: ${params.subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    params.text,
  ];
  const raw = Buffer.from(emailLines.join("\r\n")).toString("base64url");

  try {
    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw, threadId: params.threadId },
    });
    console.log(`[gmail] sent ok messageId=${res.data.id}`);
  } catch (err: any) {
    console.error(`[gmail] send error code=${err?.code} message=${err?.message}`);
    // 403 insufficient scopes means the stored token was issued with gmail.readonly — the
    // user must re-authorize. Delete the bad token so Settings shows "Not connected" and
    // the next connect flow issues a fresh token with gmail.modify scope.
    if (err?.code === 403 || err?.message?.includes("insufficient")) {
      await (prisma as any).gmailToken.deleteMany({ where: { userId } }).catch(() => {});
      throw new Error("Gmail needs re-authorization to send email. Go to Settings → Gmail and reconnect to grant send permission.");
    }
    throw err;
  }
}
