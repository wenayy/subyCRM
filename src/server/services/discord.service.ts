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

  import("discord.js").then(({ Client, GatewayIntentBits, Events }) => {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMembers,
      ],
    });

    client.once(Events.ClientReady, (c) => {
      console.log(`[discord] Bot ready: ${c.user.tag}`);
    });

    client.on(Events.MessageCreate, async (message) => {
      try {
        if (message.author.bot) return;
        const text = message.content?.trim();
        if (!text) return;
        const displayName = message.author.globalName ?? message.author.username;
        
        const contact = await findContactForDiscord({
          id: message.author.id,
          username: message.author.username,
          globalName: message.author.globalName,
        });

        // Privacy filter: skip message if not from a CRM contact
        if (!contact) {
          console.log(`[discord] Ignoring message from non-CRM user: ${displayName}`);
          return;
        }

        // Look up userId from the discord token record
        const discordTokenRec = await (prisma as any).discordToken.findFirst();
        const botUserId = discordTokenRec?.userId ?? "default";
        await inboxService.upsert({
          platform: "discord",
          externalId: message.id,
          userId: botUserId,
          contactId: contact.id,
          contactName: contact.name,
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
    return { username: me.username };
  },

  get callbackRedirect() { return `${FRONTEND_URL}/dashboard/settings?discord=connected`; },
  get callbackErrorRedirect() { return `${FRONTEND_URL}/dashboard/settings?discord=error`; },

  async sync(userId: string): Promise<{ synced: number }> {
    const token = BOT_TOKEN;
    if (!token) throw new Error("DISCORD_BOT_TOKEN not configured");

    const guildsRes = await fetch("https://discord.com/api/v10/users/@me/guilds", {
      headers: { Authorization: `Bot ${token}` },
    });
    if (!guildsRes.ok) throw new Error(`Discord API error: ${await guildsRes.text()}`);
    const guilds = await guildsRes.json() as Array<{ id: string; name: string }>;

    let synced = 0;
    for (const guild of guilds.slice(0, 5)) {
      try {
        const chRes = await fetch(`https://discord.com/api/v10/guilds/${guild.id}/channels`, {
          headers: { Authorization: `Bot ${token}` },
        });
        if (!chRes.ok) continue;
        const channels = await chRes.json() as Array<{ id: string; type: number }>;

        for (const channel of channels.filter((c) => c.type === 0).slice(0, 3)) {
          try {
            const msgRes = await fetch(`https://discord.com/api/v10/channels/${channel.id}/messages?limit=20`, {
              headers: { Authorization: `Bot ${token}` },
            });
            if (!msgRes.ok) continue;
            const messages = await msgRes.json() as Array<{ id: string; content: string; author: { id: string; username: string; global_name?: string }; timestamp: string }>;
            for (const msg of messages) {
              if (!msg.content.trim()) continue;
              const displayName = msg.author.global_name ?? msg.author.username;
              
              const contact = await findContactForDiscord({
                id: msg.author.id,
                username: msg.author.username,
                globalName: msg.author.global_name,
              });

              // Privacy filter: skip message if not from a CRM contact
              if (!contact) {
                continue;
              }

              await inboxService.upsert({
                platform: "discord",
                externalId: msg.id,
                userId,
                contactId: contact.id,
                contactName: contact.name,
                preview: msg.content.slice(0, 120),
                body: msg.content,
                receivedAt: new Date(msg.timestamp),
                needsReply: false,
              });
              synced++;
            }
          } catch { /* skip channel */ }
        }
      } catch { /* skip guild */ }
    }

    await (prisma as any).discordToken.update({ where: { userId }, data: { lastSyncAt: new Date() } });
    return { synced };
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
    let client = g.__discordClient;
    if (!client) {
      if (!BOT_TOKEN) throw new Error("DISCORD_BOT_TOKEN not configured");
      const { Client, GatewayIntentBits } = await import("discord.js");
      client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.GuildMembers,
        ],
      });
      await client.login(BOT_TOKEN);
      g.__discordClient = client;
    }

    if (!client.readyAt) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Discord client ready timeout")), 10000);
        client.once("ready", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }

    let imported = 0, updated = 0, skipped = 0;
    const discordUsers = new Map<string, { id: string; username: string; globalName?: string | null; lastActive?: Date }>();

    try {
      const guilds = await client.guilds.fetch();
      for (const guildOAuth2 of guilds.values()) {
        try {
          const guild = await guildOAuth2.fetch();
          
          try {
            const members = await guild.members.fetch({ limit: 1000 });
            for (const member of members.values()) {
              if (member.user.bot) continue;
              discordUsers.set(member.user.id, {
                id: member.user.id,
                username: member.user.username,
                globalName: member.user.globalName ?? member.displayName,
              });
            }
          } catch (memberErr) {
            console.warn(`[discord-import] Failed to fetch members for guild ${guild.name}:`, memberErr);
          }

          const channels = await guild.channels.fetch();
          const textChannels = channels.filter((c: any) => c && c.type === 0);
          for (const channel of textChannels.values()) {
            try {
              const messages = await channel.messages.fetch({ limit: 50 });
              for (const msg of messages.values()) {
                if (msg.author.bot) continue;
                const existingUser = discordUsers.get(msg.author.id);
                const msgDate = msg.createdAt;
                if (!existingUser || !existingUser.lastActive || msgDate > existingUser.lastActive) {
                  discordUsers.set(msg.author.id, {
                    id: msg.author.id,
                    username: msg.author.username,
                    globalName: msg.author.globalName ?? msg.member?.displayName,
                    lastActive: msgDate,
                  });
                }
              }
            } catch (msgErr) {
              // skip channel
            }
          }
        } catch (guildErr) {
          console.warn(`[discord-import] Failed to process guild ${guildOAuth2.name}:`, guildErr);
        }
      }
    } catch (err) {
      console.error("[discord-import] Failed to fetch guilds:", err);
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
          if (dUser.lastActive) {
            if (!contact.lastContactDate || dUser.lastActive > contact.lastContactDate) {
              await prisma.contact.update({
                where: { id: contact.id },
                data: { lastContactDate: dUser.lastActive }
              });
            }
          }
          updated++;
          continue;
        }

        await prisma.contact.create({
          data: {
            name: globalName,
            lastContactDate: dUser.lastActive ?? null,
            firstContactDate: dUser.lastActive ?? null,
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
