import { google } from "googleapis";
import { createHmac } from "crypto";
import { prisma } from "../lib/prisma";
import { inboxService } from "./inbox.service";

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
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
      accessToken: tokens.access_token!,
      refreshToken: tokens.refresh_token ?? null,
      expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    },
    update: {
      accessToken: tokens.access_token!,
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
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
    access_token: (token as any).accessToken,
    refresh_token: (token as any).refreshToken,
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

  // Fetch up to 100 recent threads (90 days)
  const afterTs = Math.floor((Date.now() - 90 * 86400_000) / 1000);
  const listRes = await gmail.users.threads.list({
    userId: "me",
    maxResults: 100,
    q: `after:${afterTs} -category:promotions -category:social`,
  });

  const threads = listRes.data.threads ?? [];
  console.log(`[syncThreads] ${threads.length} threads from Gmail`);

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
        format: "metadata",
        metadataHeaders: ["Subject", "From", "To", "Cc", "Date"],
      });

      const msgs = detail.data.messages ?? [];
      if (!msgs.length) continue;

      const firstMsg = msgs[0];
      const lastMsg = msgs[msgs.length - 1];
      const headers = firstMsg.payload?.headers ?? [];
      const getHeader = (name: string) =>
        headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null;

      const subject = getHeader("Subject");
      const fromRaw = getHeader("From") ?? "";
      const toRaw = getHeader("To") ?? "";
      const ccRaw = getHeader("Cc") ?? "";
      const dateStr = getHeader("Date");

      const fromEmail = extractEmails(fromRaw)[0] ?? null;
      const allEmails = [
        ...extractEmails(fromRaw),
        ...extractEmails(toRaw),
        ...extractEmails(ccRaw),
      ];

      // Match first non-self email against contacts
      let matched: { id: string; name: string } | null = null;
      let matchedEmail: string | null = null;
      for (const email of allEmails) {
        if (myEmails.has(email)) continue;
        if (emailMap.has(email)) {
          matched = emailMap.get(email)!;
          matchedEmail = email;
          break;
        }
      }

      const lastDate = dateStr ? new Date(dateStr) : new Date();

      rows.push({
        threadId: t.id,
        subject,
        snippet: lastMsg.snippet ?? null,
        contactId: matched?.id ?? null,
        contactEmail: matchedEmail,
        fromEmail,
        lastDate: isNaN(lastDate.getTime()) ? new Date() : lastDate,
        messageCount: msgs.length,
      });
    } catch (err) {
      console.warn(`[syncThreads] skipped thread ${t.id}:`, (err as Error).message);
    }
  }

  console.log(`[syncThreads] saving ${rows.length} threads...`);
  const threadIds = rows.map((r) => r.threadId);
  await (prisma as any).gmailThread.deleteMany({ where: { threadId: { in: threadIds } } });
  await (prisma as any).gmailThread.createMany({ data: rows, skipDuplicates: true });

  // Mirror to unified InboxMessage — include unmatched threads so inbox isn't empty
  for (const row of rows) {
    const senderEmail = row.contactEmail ?? row.fromEmail ?? null;
    await inboxService.upsert({
      platform: "email",
      externalId: row.threadId,
      userId,
      contactId: row.contactId ?? null,
      contactName: senderEmail ?? "Unknown",
      senderId: row.contactId ? undefined : senderEmail ?? undefined,
      preview: row.subject ?? row.snippet ?? "",
      body: row.snippet ?? "",
      receivedAt: row.lastDate,
      needsReply: row.messageCount === 1,
    });
  }

  await (prisma as any).gmailToken.update({
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

import nodemailer from "nodemailer";

// Reusable transporter for sending emails via Gmail SMTP (App Password)
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

/**
 * Send an email using the configured transporter.
 * @param params - to, subject, text and optional html.
 */
export async function sendEmail(params: {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
}) {
  const { to, subject, text, html } = params;
  try {
    const info = await transporter.sendMail({
      from: `"Suby Contacts" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      text,
      html,
    });
    console.log("[sendEmail] Message sent:", info.messageId);
    return info;
  } catch (error) {
    console.error("[sendEmail] Failed to send email:", error);
    throw error;
  }
}
