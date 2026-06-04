import crypto from "crypto";
import { prisma } from "../lib/prisma";
import { inboxService } from "./inbox.service";
import { TwitterApi } from "twitter-api-v2";

const CONSUMER_KEY = process.env.X_CONSUMER_KEY || "";
const CONSUMER_SECRET = process.env.X_CONSUMER_SECRET || "";
const CALLBACK_URI = `${process.env.AUTH_BASE_URL || "http://localhost:4002"}/api/x/callback`;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3005";

// In-memory: oauth_token → { userId, tokenSecret }
const oauthPending = new Map<string, { userId: string; tokenSecret: string }>();

export const xService = {
  async buildAuthUrl(userId: string): Promise<string> {
    if (!CONSUMER_KEY || !CONSUMER_SECRET) throw new Error("X_CONSUMER_KEY / X_CONSUMER_SECRET not configured in .env.local");
    const client = new TwitterApi({
      appKey: CONSUMER_KEY,
      appSecret: CONSUMER_SECRET,
    });
    const authLink = await client.generateAuthLink(CALLBACK_URI, { linkMode: "authorize" });
    oauthPending.set(authLink.oauth_token, { userId, tokenSecret: authLink.oauth_token_secret });
    return authLink.url;
  },

  async handleCallback(oauthToken: string, oauthVerifier: string): Promise<void> {
    const pending = oauthPending.get(oauthToken);
    if (!pending) throw new Error("X OAuth state expired or invalid");
    oauthPending.delete(oauthToken);

    const client = new TwitterApi({
      appKey: CONSUMER_KEY,
      appSecret: CONSUMER_SECRET,
      accessToken: oauthToken,
      accessSecret: pending.tokenSecret,
    });

    const { accessToken, accessSecret, screenName } = await client.login(oauthVerifier);

    await (prisma as any).xToken.upsert({
      where: { userId: pending.userId },
      create: { userId: pending.userId, accessToken: `${CONSUMER_KEY}:${CONSUMER_SECRET}:${accessToken}`, accessTokenSecret: accessSecret, screenName },
      update: { accessToken: `${CONSUMER_KEY}:${CONSUMER_SECRET}:${accessToken}`, accessTokenSecret: accessSecret, screenName },
    });
    xService.sync(pending.userId).catch(console.error);
  },

  get callbackRedirect() { return `${FRONTEND_URL}/dashboard/settings?x=connected`; },
  get callbackErrorRedirect() { return `${FRONTEND_URL}/dashboard/settings?x=error`; },

  async getStatus(userId: string) {
    const rec = await (prisma as any).xToken.findUnique({ where: { userId } });
    const hasEnvCreds = !!(CONSUMER_KEY && CONSUMER_SECRET);
    if (!rec) return { connected: false, lastSync: null, hasEnvCreds };
    return { connected: true, lastSync: rec.lastSyncAt?.toISOString() ?? null, screenName: rec.screenName, hasEnvCreds };
  },

  async saveCredentials(userId: string, data: {
    accessToken: string;
    accessTokenSecret: string;
    apiKey: string;
    apiSecret: string;
  }) {
    try {
      const client = new TwitterApi({
        appKey: data.apiKey,
        appSecret: data.apiSecret,
        accessToken: data.accessToken,
        accessSecret: data.accessTokenSecret,
      });

      const me = await client.v2.me();
      if (!me.data) throw new Error("Could not fetch user details from X");

      await (prisma as any).xToken.upsert({
        where: { userId },
        create: {
          userId,
          accessToken: `${data.apiKey}:${data.apiSecret}:${data.accessToken}`,
          accessTokenSecret: data.accessTokenSecret,
          screenName: me.data.username,
        },
        update: {
          accessToken: `${data.apiKey}:${data.apiSecret}:${data.accessToken}`,
          accessTokenSecret: data.accessTokenSecret,
          screenName: me.data.username,
        },
      });
      return { screenName: me.data.username };
    } catch (err: any) {
      if (err.status === 403) {
        throw new Error("X API access failed. Note: The free X developer API tier does not allow access to this feature. A Basic or higher developer tier is required.");
      }
      throw new Error(err.message || "Failed to verify credentials with X");
    }
  },

  async disconnect(userId: string) {
    await (prisma as any).xToken.deleteMany({ where: { userId } });
  },

  async sync(userId: string): Promise<{ synced: number }> {
    const rec = await (prisma as any).xToken.findUnique({ where: { userId } });
    if (!rec) throw new Error("X not connected");

    const [apiKey, apiSecret, accessToken] = rec.accessToken.split(":");
    const accessTokenSecret = rec.accessTokenSecret;

    try {
      const client = new TwitterApi({
        appKey: apiKey,
        appSecret: apiSecret,
        accessToken,
        accessSecret: accessTokenSecret,
      });

      // Fetch DMs via v2 listDmEvents with sender expansions
      const eventsTimeline = await client.v2.listDmEvents({
        "dm_event.fields": ["id", "text", "created_at", "sender_id", "dm_conversation_id"],
        event_types: ["MessageCreate"],
        expansions: ["sender_id"],
        "user.fields": ["username", "name"]
      });

      let synced = 0;
      const events = eventsTimeline.events ?? [];
      const users = eventsTimeline.includes?.users ?? [];
      const usernameMap = new Map<string, string>();
      for (const u of users) {
        usernameMap.set(u.id, u.username);
      }

      for (const event of events) {
        const text = event.text;
        if (!text) continue;
        const senderId = event.sender_id ?? "unknown";
        const createdAt = event.created_at ? new Date(event.created_at) : new Date();

        const username = usernameMap.get(senderId);
        const isFromMe = !!(username && rec.screenName && username.toLowerCase() === rec.screenName.toLowerCase());

        // Find CRM contact matching either the senderId or the username
        const plat = await prisma.platform.findFirst({
          where: {
            type: "x",
            OR: [
              { platformId: senderId },
              ...(username ? [{ platformId: { equals: username, mode: "insensitive" } }] : []),
            ],
          },
          include: { contact: true },
        });

        // Only show DMs from contacts who have an X platform entry
        if (!plat) {
          console.log(`[x] Ignoring message from non-CRM user: ${username || senderId}`);
          continue;
        }

        await inboxService.upsert({
          platform: "x",
          externalId: event.id,
          userId,
          contactId: plat.contact.id,
          contactName: plat.contact.name,
          senderId,
          preview: text.slice(0, 120),
          body: text,
          receivedAt: createdAt,
          needsReply: !isFromMe,
          fromMe: isFromMe,
        });
        synced++;
      }

      await (prisma as any).xToken.update({ where: { userId }, data: { lastSyncAt: new Date() } });
      return { synced };
    } catch (err: any) {
      console.error("[x-sync-error]", err);
      if (err.status === 402 || err.status === 403) {
        throw new Error("X DM access requires the Basic plan ($100/month) on developer.twitter.com. The free tier does not include DM reading. Upgrade your app's plan to use this feature.");
      }
      throw new Error(err.message || "Failed to sync DMs with X");
    }
  },
};
