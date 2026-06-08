import crypto from "crypto";
import { prisma } from "../lib/prisma";
import { inboxService } from "./inbox.service";

const CLIENT_ID = process.env.DISCORD_CLIENT_ID || "";
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const REDIRECT_URI = `${process.env.AUTH_BASE_URL || "http://localhost:4002"}/api/discord/callback`;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3005";

// Permissions: VIEW_CHANNEL + READ_MESSAGE_HISTORY + SEND_MESSAGES
const BOT_PERMISSIONS = "68608";

const g = global as any;

function signState(userId: string): string {
  const nonce = crypto.randomBytes(8).toString("hex");
  const payload = `${userId}:${nonce}`;
  const sig = crypto.createHmac("sha256", CLIENT_SECRET || "dev").update(payload).digest("hex");
  return Buffer.from(`${payload}:${sig}`).toString("base64url");
}

function verifyState(state: string): string {
  try {
    const decoded = Buffer.from(state, "base64url").toString();
    const lastColon = decoded.lastIndexOf(":");
    const payload = decoded.slice(0, lastColon);
    const sig = decoded.slice(lastColon + 1);
    const expected = crypto.createHmac("sha256", CLIENT_SECRET || "dev").update(payload).digest("hex");
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      throw new Error("bad sig");
    }
    const userId = payload.split(":")[0];
    if (!userId) throw new Error("no userId");
    return userId;
  } catch {
    throw new Error("Discord OAuth state invalid");
  }
}

async function findContactForDiscord(author: { id: string; username: string; globalName?: string | null }) {
  if (!author) return null;
  const discordUserId = author.id;
  const username = author.username;
  const globalName = author.globalName;

  const plat = await (prisma as any).platform.findFirst({
    where: {
      OR: [
        { type: "discord", platformId: discordUserId },
        { type: "discord", platformId: { equals: username, mode: "insensitive" } },
        ...(globalName ? [{ type: "discord", platformId: { equals: globalName, mode: "insensitive" } }] : []),
        { contact: { name: { contains: username.split(" ")[0], mode: "insensitive" } } },
      ],
    },
    include: { contact: true },
  });

  return plat?.contact ?? null;
}

function startBot() {
  if (g.__discordClient || !BOT_TOKEN) return;

  import("discord.js").then(({ Client, GatewayIntentBits, Events, ChannelType, Partials }) => {
    const client = new Client({
      intents: [
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      // Required for bots to receive DM events in discord.js v14
      partials: [Partials.Channel, Partials.Message],
    });

    client.once(Events.ClientReady, (c) => {
      console.log(`[discord] Bot ready: ${c.user.tag}`);
    });

    client.on(Events.MessageCreate, async (message) => {
      try {
        if (message.author.bot) return;
        // Only process DMs to the bot — ignore all server/guild channel messages
        if (message.channel.type !== ChannelType.DM) return;
        const text = message.content?.trim();
        if (!text) return;
        const displayName = message.author.globalName ?? message.author.username;
        
        const contact = await findContactForDiscord({
          id: message.author.id,
          username: message.author.username,
          globalName: message.author.globalName,
        });

        // Look up userId from the discord token record
        const discordTokenRec = await (prisma as any).discordToken.findFirst();
        const botUserId = discordTokenRec?.userId ?? "default";
        await inboxService.upsert({
          platform: "discord",
          externalId: message.id,
          userId: botUserId,
          contactId: contact?.id ?? null,
          contactName: contact?.name ?? displayName,
          senderId: message.channelId,
          preview: text.slice(0, 120),
          body: text,
          receivedAt: message.createdAt,
          needsReply: true,
        });
      } catch { /* ignore */ }
    });

    client.login(BOT_TOKEN)
      .then(() => { g.__discordClient = client; })
      .catch((err) => { console.error("[discord] Bot login failed:", err.message); });
  }).catch((err) => console.error("[discord] Failed to load discord.js:", err));
}

async function triggerImport(userId: string) {
  try {
    const { queues } = await import("../lib/queues");
    const job = await prisma.importJob.create({
      data: { userId, source: "discord_api", status: "running", startedAt: new Date() },
    });
    await queues.discordImport.add("discord-import", { userId, importJobId: job.id });
    console.log(`[discord] Auto-import queued for user ${userId}`);
  } catch { /* non-fatal */ }
}

export const discordService = {
  buildAuthUrl(userId: string): string {
    if (!CLIENT_ID) throw new Error("DISCORD_CLIENT_ID not configured in .env.local");
    const state = signState(userId);
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "bot identify",
      permissions: BOT_PERMISSIONS,
      state,
    });
    return `https://discord.com/oauth2/authorize?${params}`;
  },

  async handleCallback(code: string, state: string): Promise<void> {
    const userId = verifyState(state);

    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });
    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error("[discord-callback] token exchange failed:", err);
      throw new Error(`Discord token exchange failed: ${err}`);
    }
    const tokenData = await tokenRes.json() as { access_token: string };

    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const discordUser = await userRes.json() as { id: string; username: string; global_name?: string };
    const username = discordUser.global_name ?? discordUser.username;

    await (prisma as any).discordToken.upsert({
      where: { userId },
      create: { userId, discordUserId: discordUser.id, username },
      update: { discordUserId: discordUser.id, username },
    });

    startBot();
    void triggerImport(userId);
  },

  async getStatus(userId: string) {
    const rec = await (prisma as any).discordToken.findUnique({ where: { userId } }).catch(() => null);
    if (!rec) return { connected: false, lastSync: null };
    return {
      connected: true,
      lastSync: rec.lastSyncAt?.toISOString() ?? null,
      username: rec.username ?? undefined,
    };
  },

  async disconnect(userId: string) {
    await (prisma as any).discordToken.deleteMany({ where: { userId } });
  },

  async autoReconnect() {
    if (g.__discordClient || !BOT_TOKEN) return;
    const rec = await (prisma as any).discordToken.findFirst().catch(() => null);
    if (!rec) return;
    console.log("[discord] Auto-reconnecting bot…");
    startBot();
    void triggerImport(rec.userId);
  },

  async legacyConnect(userId: string, botToken: string) {
    const res = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bot ${botToken}` },
    });
    if (!res.ok) throw new Error("Invalid bot token");
    const me = await res.json() as { id: string; username: string };
    await (prisma as any).discordToken.upsert({
      where: { userId },
      create: { userId, botToken, discordUserId: me.id, username: me.username },
      update: { botToken, discordUserId: me.id, username: me.username },
    });
    startBot();
    void triggerImport(userId);
    return { username: me.username };
  },

  get callbackRedirect() { return `${FRONTEND_URL}/dashboard/settings?discord=connected`; },
  get callbackErrorRedirect() { return `${FRONTEND_URL}/dashboard/settings?discord=error`; },

  async sync(userId: string): Promise<{ synced: number }> {
    // Discord doesn't expose bot DM history via API — messages arrive live via MessageCreate.
    // Sync just marks the timestamp so the Settings page shows "Last synced".
    await (prisma as any).discordToken.update({ where: { userId }, data: { lastSyncAt: new Date() } });
    return { synced: 0 };
  },

  async sendMessage(userId: string, channelId: string, text: string): Promise<void> {
    const rec = await (prisma as any).discordToken.findUnique({ where: { userId } });
    const botToken = rec?.botToken || process.env.DISCORD_BOT_TOKEN;
    if (!botToken) throw new Error("Discord not connected — no bot token");
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: text }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { message?: string };
      throw new Error(`Discord send failed: ${err.message ?? res.status}`);
    }
  },

  async importContacts(userId: string): Promise<{ imported: number; updated: number; skipped: number }> {
    if (!BOT_TOKEN) throw new Error("DISCORD_BOT_TOKEN not configured");

    // Use REST API directly — avoids gateway intent issues with the DM-only live bot
    const headers = { Authorization: `Bot ${BOT_TOKEN}` };
    let imported = 0, updated = 0, skipped = 0;
    const discordUsers = new Map<string, { id: string; username: string; globalName?: string | null }>();

    // Fetch all guilds the bot is in
    const guildsRes = await fetch("https://discord.com/api/v10/users/@me/guilds", { headers });
    if (!guildsRes.ok) throw new Error(`Discord API error fetching guilds: ${await guildsRes.text()}`);
    const guilds = await guildsRes.json() as Array<{ id: string; name: string }>;

    for (const guild of guilds) {
      // Fetch members via REST (works without gateway GuildMembers intent)
      const membersRes = await fetch(`https://discord.com/api/v10/guilds/${guild.id}/members?limit=1000`, { headers });
      if (membersRes.ok) {
        const members = await membersRes.json() as Array<{ user: { id: string; username: string; global_name?: string | null; bot?: boolean }; nick?: string | null }>;
        for (const m of members) {
          if (m.user.bot) continue;
          discordUsers.set(m.user.id, {
            id: m.user.id,
            username: m.user.username,
            globalName: m.nick ?? m.user.global_name ?? m.user.username,
          });
        }
      } else {
        console.warn(`[discord-import] Members REST failed for ${guild.name}: ${membersRes.status} — falling back to channel messages`);
        // Fallback: scan recent channel messages for authors
        const chRes = await fetch(`https://discord.com/api/v10/guilds/${guild.id}/channels`, { headers });
        if (!chRes.ok) continue;
        const channels = await chRes.json() as Array<{ id: string; type: number }>;
        for (const ch of channels.filter((c) => c.type === 0).slice(0, 5)) {
          const msgRes = await fetch(`https://discord.com/api/v10/channels/${ch.id}/messages?limit=100`, { headers });
          if (!msgRes.ok) continue;
          const msgs = await msgRes.json() as Array<{ author: { id: string; username: string; global_name?: string | null; bot?: boolean } }>;
          for (const msg of msgs) {
            if (msg.author.bot) continue;
            if (!discordUsers.has(msg.author.id)) {
              discordUsers.set(msg.author.id, {
                id: msg.author.id,
                username: msg.author.username,
                globalName: msg.author.global_name ?? msg.author.username,
              });
            }
          }
        }
      }
    }

    for (const dUser of discordUsers.values()) {
      try {
        const username = dUser.username;
        const globalName = dUser.globalName ?? username;
        const discordUserId = dUser.id;

        const contact = await findContactForDiscord({
          id: dUser.id,
          username: dUser.username,
          globalName: dUser.globalName,
        });

        if (contact) {
          const updates: Record<string, any> = {};
          if (contact.userId === "default") updates.userId = userId;
          if (Object.keys(updates).length) {
            await prisma.contact.update({ where: { id: contact.id }, data: updates });
          }
          updated++;
          continue;
        }

        await prisma.contact.create({
          data: {
            userId,
            name: globalName,
            lastContactDate: null,
            firstContactDate: null,
            type: "other",
            domain: "other",
            relationshipStrength: "cold",
            platforms: {
              create: [{
                type: "discord",
                platformId: discordUserId,
                displayName: globalName,
                profileUrl: null,
              }]
            }
          }
        });
        imported++;
      } catch (err) {
        console.error(`[discord-import] Failed to import user ${dUser.username}:`, err);
        skipped++;
      }
    }

    await (prisma as any).discordToken.updateMany({
      where: { userId },
      data: { lastSyncAt: new Date() }
    }).catch(() => null);

    return { imported, updated, skipped };
  },
};
