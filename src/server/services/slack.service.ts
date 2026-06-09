import crypto from "crypto";
import { prisma } from "../lib/prisma";
import { inboxService } from "./inbox.service";
import { encrypt, decrypt } from "../lib/encryption";

const CLIENT_ID = process.env.SLACK_CLIENT_ID || "";
const CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET || "";
const REDIRECT_URI = `${process.env.AUTH_BASE_URL || "http://localhost:4002"}/api/slack/callback`;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN || "";
// bot scopes: minimal bot presence
const BOT_SCOPES = ["channels:read"];
// user scopes: DM access + user lookup (users:read needed to resolve names)
const USER_SCOPES = ["im:read", "im:history", "mpim:read", "mpim:history", "chat:write", "users:read"];

const g = global as any;
// Cache my own Slack user ID per token to avoid calling auth.test on every message
const mySlackIdCache = new Map<string, string>();

function buildState(userId: string): string {
  const payload = JSON.stringify({ userId, ts: Date.now() });
  const sig = crypto.createHmac("sha256", process.env.BETTER_AUTH_SECRET || "secret")
    .update(payload).digest("hex");
  return Buffer.from(JSON.stringify({ payload, sig })).toString("base64url");
}

function verifyState(state: string): { userId: string } {
  const { payload, sig } = JSON.parse(Buffer.from(state, "base64url").toString());
  const expected = crypto.createHmac("sha256", process.env.BETTER_AUTH_SECRET || "secret")
    .update(payload).digest("hex");
  if (sig !== expected) throw new Error("Invalid state");
  const { userId } = JSON.parse(payload);
  if (Date.now() - JSON.parse(payload).ts > 10 * 60_000) throw new Error("State expired");
  return { userId };
}

async function slackFetch<T>(path: string, token: string, params?: Record<string, string>): Promise<T> {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  const res = await fetch(`https://slack.com/api${path}${qs}`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const json = await res.json() as { ok: boolean; error?: string } & T;
  if (!json.ok) throw new Error(`Slack API error: ${json.error}`);
  return json;
}

async function startSocket() {
  if (g.__slackSocket || !SLACK_APP_TOKEN) return;

  try {
    const { SocketModeClient } = await import("@slack/socket-mode");
    const client = new SocketModeClient({ appToken: SLACK_APP_TOKEN, logLevel: "warn" as any });

    client.on("message", async ({ event, ack }: any) => {
      await ack();
      try {
        // Only DMs, no bot messages, no subtypes (edits/deletes)
        if (event.bot_id || event.subtype || !event.text || event.channel_type !== "im") return;

        const slackUserId = event.user as string;
        const channelId = event.channel as string;
        const text = event.text as string;
        const ts = event.ts as string;

        // Find which CRM user owns this Slack connection
        const tokenRec = await (prisma as any).slackToken.findFirst();
        if (!tokenRec) return;
        const { userId, accessToken: token } = { ...tokenRec, accessToken: decrypt(tokenRec.accessToken) };

        // Resolve my own Slack ID (cached per token)
        if (!mySlackIdCache.has(token)) {
          const auth = await slackFetch<{ user_id: string }>("/auth.test", token).catch(() => ({ user_id: "" }));
          if (auth.user_id) mySlackIdCache.set(token, auth.user_id);
        }
        const mySlackId = mySlackIdCache.get(token) ?? "";
        const fromMe = slackUserId === mySlackId;

        // Resolve display name + email for this Slack user
        const userRes = await slackFetch<{ user: { real_name?: string; name: string; profile?: { email?: string } } }>(
          "/users.info", token, { user: slackUserId },
        ).catch(() => null);
        const slackUser = userRes?.user;
        const displayName = slackUser?.real_name || slackUser?.name || slackUserId;
        const email = slackUser?.profile?.email;

        // Find CRM contact — match by Slack user ID or email only; no name fallback
        // (name matching caused cross-platform contamination, e.g. "wee waai" → "weenay")
        const plat = await (prisma as any).platform.findFirst({
          where: {
            OR: [
              { type: "slack", platformId: slackUserId },
              ...(email ? [{ type: "email", platformId: { equals: email, mode: "insensitive" } }] : []),
            ],
          },
          include: { contact: true },
        });

        await inboxService.upsert({
          platform: "slack",
          externalId: `${channelId}-${ts}`,
          userId,
          contactId: plat?.contact.id ?? null,
          contactName: plat?.contact.name ?? displayName,
          senderId: channelId,
          preview: text.slice(0, 120),
          body: text,
          receivedAt: new Date(parseFloat(ts) * 1000),
          needsReply: !fromMe,
          fromMe,
        });

        console.log(`[slack-socket] ${fromMe ? "OUT" : "IN"} from ${displayName}: ${text.slice(0, 60)}`);
      } catch (err) {
        console.error("[slack-socket] Error processing message:", err);
      }
    });

    await client.start();
    g.__slackSocket = client;
    console.log("[slack] Socket Mode connected — real-time DMs active");
  } catch (err) {
    console.error("[slack] Socket Mode failed to start:", err);
  }
}

export const slackService = {
  buildAuthUrl(userId: string): string {
    if (!CLIENT_ID) throw new Error("SLACK_CLIENT_ID not set");
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      scope: BOT_SCOPES.join(","),
      user_scope: USER_SCOPES.join(","),
      redirect_uri: REDIRECT_URI,
      state: buildState(userId),
    });
    return `https://slack.com/oauth/v2/authorize?${params}`;
  },

  async handleCallback(code: string, state: string): Promise<void> {
    const { userId } = verifyState(state);
    const res = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT_URI }),
    });
    const data = await res.json() as { ok: boolean; access_token?: string; team?: { id: string; name: string }; authed_user?: { access_token?: string } };
    if (!data.ok) throw new Error("Slack OAuth failed");
    const token = data.authed_user?.access_token ?? data.access_token ?? "";
    await (prisma as any).slackToken.upsert({
      where: { userId },
      create: { userId, accessToken: encrypt(token), teamId: data.team?.id, teamName: data.team?.name },
      update: { accessToken: encrypt(token), teamId: data.team?.id, teamName: data.team?.name },
    });
    // Start real-time socket (no-op if already running)
    void startSocket();
    // Auto-sync messages in background (non-fatal)
    slackService.sync(userId).catch((err) => console.error("[slack] auto-sync failed:", err));
    try {
      const { queues } = await import("../lib/queues");
      const job = await prisma.importJob.create({
        data: { userId, source: "slack_api", status: "running", startedAt: new Date() },
      });
      await queues.slackImport.add("slack-import", { userId, importJobId: job.id });
      console.log(`[slack] Auto-import queued for user ${userId}`);
    } catch { /* non-fatal */ }
  },

  async getStatus(userId: string) {
    const rec = await (prisma as any).slackToken.findUnique({ where: { userId } });
    if (!rec) return { connected: false, lastSync: null };
    return { connected: true, lastSync: rec.lastSyncAt?.toISOString() ?? null, teamName: rec.teamName };
  },

  async disconnect(userId: string) {
    await (prisma as any).slackToken.deleteMany({ where: { userId } });
  },

  async sync(userId: string): Promise<{ synced: number }> {
    const rec = await (prisma as any).slackToken.findUnique({ where: { userId } });
    if (!rec) throw new Error("Slack not connected");
    const token = decrypt(rec.accessToken);
    let synced = 0;

    // Get the current user's Slack ID so we can mark outgoing messages correctly
    const authRes = await slackFetch<{ user_id: string }>("/auth.test", token).catch(() => ({ user_id: "" }));
    const mySlackId = authRes.user_id;

    // Get all DM channels (im = 1:1 DM, mpim = group DM)
    const convRes = await slackFetch<{ channels: Array<{ id: string; user?: string }> }>(
      "/conversations.list", token, { types: "im,mpim", limit: "100" },
    ).catch(() => ({ channels: [] }));

    // Get user info map
    const usersRes = await slackFetch<{ members: Array<{ id: string; real_name?: string; name: string; profile?: { email?: string } }> }>(
      "/users.list", token, { limit: "500" },
    ).catch(() => ({ members: [] }));
    const userMap = new Map(usersRes.members.map((u) => [u.id, u]));

    for (const ch of convRes.channels) {
      try {
        const histRes = await slackFetch<{ messages: Array<{ ts: string; text: string; user?: string }> }>(
          "/conversations.history", token, { channel: ch.id, limit: "50" },
        );
        for (const msg of histRes.messages) {
          if (!msg.text || !msg.user) continue;

          // For DM channels, the other user is stored in ch.user; for group DMs use msg.user
          const otherUserId = ch.user && ch.user !== mySlackId ? ch.user : msg.user;
          const slackUser = userMap.get(otherUserId) ?? userMap.get(msg.user);
          const displayName = slackUser?.real_name || slackUser?.name || otherUserId;
          const email = slackUser?.profile?.email;
          const fromMe = msg.user === mySlackId;

          // Find CRM contact — match by Slack user ID or email only; no name fallback
          const plat = await (prisma as any).platform.findFirst({
            where: {
              OR: [
                { type: "slack", platformId: otherUserId },
                ...(email ? [{ type: "email", platformId: { equals: email, mode: "insensitive" } }] : []),
              ],
            },
            include: { contact: true },
          });

          await inboxService.upsert({
            platform: "slack",
            externalId: `${ch.id}-${msg.ts}`,
            userId,
            contactId: plat?.contact.id ?? null,
            contactName: plat?.contact.name ?? displayName,
            senderId: ch.id, // channel ID — used by reply to post back
            preview: msg.text.slice(0, 120),
            body: msg.text,
            receivedAt: new Date(parseFloat(msg.ts) * 1000),
            needsReply: !fromMe,
            fromMe,
          });
          synced++;
        }
      } catch { /* skip channel on error */ }
    }

    await (prisma as any).slackToken.update({ where: { userId }, data: { lastSyncAt: new Date() } });
    return { synced };
  },

  async sendMessage(userId: string, channelId: string, text: string): Promise<void> {
    const rec = await (prisma as any).slackToken.findUnique({ where: { userId } });
    if (!rec) throw new Error("Slack not connected");
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${decrypt(rec.accessToken)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: channelId, text }),
    }).then(async (r) => {
      const data = await r.json() as { ok: boolean; error?: string };
      if (!data.ok) throw new Error(`Slack send failed: ${data.error}`);
    });
  },

  async importContacts(userId: string): Promise<{ imported: number; updated: number; skipped: number }> {
    const rec = await (prisma as any).slackToken.findUnique({ where: { userId } });
    if (!rec) throw new Error("Slack not connected");
    const token = decrypt(rec.accessToken);

    const usersRes = await slackFetch<{
      members: Array<{ id: string; name: string; real_name?: string; is_bot: boolean; deleted: boolean; profile?: { email?: string; display_name?: string } }>;
    }>("/users.list", token, { limit: "500" }).catch(() => ({ members: [] }));

    let imported = 0, updated = 0, skipped = 0;

    for (const member of usersRes.members) {
      if (member.is_bot || member.deleted) continue;
      const displayName = member.profile?.display_name || member.real_name || member.name;
      const email = member.profile?.email;
      const slackId = member.id;

      try {
        // Check if already in CRM by Slack ID or email
        const existing = await (prisma as any).platform.findFirst({
          where: {
            OR: [
              { type: "slack", platformId: slackId },
              ...(email ? [{ type: "email", platformId: { equals: email, mode: "insensitive" } }] : []),
            ],
          },
          include: { contact: true },
        });

        if (existing) {
          const updates: Record<string, any> = {};
          if (existing.contact.userId === "default") updates.userId = userId;
          if (Object.keys(updates).length) {
            await prisma.contact.update({ where: { id: existing.contact.id }, data: updates });
          }
          // Ensure Slack platform entry exists
          const hasSlack = await (prisma as any).platform.findFirst({
            where: { type: "slack", platformId: slackId, contactId: existing.contact.id },
          });
          if (!hasSlack) {
            await (prisma as any).platform.create({
              data: { contactId: existing.contact.id, type: "slack", platformId: slackId, displayName },
            });
          }
          updated++;
          continue;
        }

        await prisma.contact.create({
          data: {
            userId,
            name: displayName,
            type: "other",
            domain: "other",
            relationshipStrength: "cold",
            platforms: {
              create: [
                { type: "slack" as const, platformId: slackId, displayName },
                ...(email ? [{ type: "email" as const, platformId: email, displayName }] : []),
              ],
            },
          },
        });
        imported++;
      } catch {
        skipped++;
      }
    }

    return { imported, updated, skipped };
  },

  async autoReconnect() {
    if (g.__slackSocket || !SLACK_APP_TOKEN) return;
    const rec = await (prisma as any).slackToken.findFirst().catch(() => null);
    if (!rec) return;
    console.log("[slack] Auto-reconnecting socket...");
    void startSocket();
  },
};
