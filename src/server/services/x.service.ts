import crypto from "crypto";
import { prisma } from "../lib/prisma";
import { inboxService } from "./inbox.service";
import { TwitterApi } from "twitter-api-v2";

const TWITTER_BEARER = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

async function twitterFetch(path: string, authToken: string, ct0: string) {
  return fetch(`https://twitter.com${path}`, {
    headers: {
      authorization: `Bearer ${TWITTER_BEARER}`,
      cookie: `auth_token=${authToken}; ct0=${ct0}`,
      "x-csrf-token": ct0,
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-active-user": "yes",
      "x-twitter-client-language": "en",
      accept: "application/json",
      "accept-language": "en-US,en;q=0.9",
      referer: "https://twitter.com/messages",
      origin: "https://twitter.com",
    },
  });
}

const CONSUMER_KEY = process.env.X_CONSUMER_KEY || "";
const CONSUMER_SECRET = process.env.X_CONSUMER_SECRET || "";
const CALLBACK_URI = `${process.env.AUTH_BASE_URL || "http://localhost:4002"}/api/x/callback`;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

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
    if (!rec) return { connected: false, lastSync: null, hasEnvCreds, hasCookie: false };
    const hasCookie = !!(rec.cookieAuthToken && rec.cookieCt0);
    return { connected: !!(rec.screenName || hasCookie), lastSync: rec.lastSyncAt?.toISOString() ?? null, screenName: rec.screenName, hasEnvCreds, hasCookie };
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

  async saveCookie(userId: string, authToken: string, ct0: string): Promise<{ screenName: string }> {
    // Save first so the record exists
    await (prisma as any).xToken.upsert({
      where: { userId },
      create: { userId, accessToken: "", accessTokenSecret: "", cookieAuthToken: authToken, cookieCt0: ct0 },
      update: { cookieAuthToken: authToken, cookieCt0: ct0 },
    });

    // Use account/settings.json — works with session cookies and clearly returns screen_name
    let screenName = "";
    let myUserId = "";
    try {
      const settingsRes = await twitterFetch("/i/api/1.1/account/settings.json", authToken, ct0);
      if (settingsRes.ok) {
        const settings = await settingsRes.json() as any;
        screenName = settings.screen_name ?? "";
      } else if (settingsRes.status === 401 || settingsRes.status === 403) {
        await (prisma as any).xToken.deleteMany({ where: { userId } });
        throw new Error("Invalid cookies — Twitter rejected them. Make sure you copied auth_token and ct0 from twitter.com.");
      }
    } catch (err: any) {
      if (err.message?.includes("Invalid cookies")) throw err;
      console.warn("[x] saveCookie settings check failed:", err.message);
    }

    // If settings didn't give us a screen name, fall back to inbox — get myUserId from
    // conversations where read_event_id is set (only we can mark our own read receipts)
    if (!screenName) {
      try {
        const inboxRes = await twitterFetch(
          "/i/api/1.1/dm/inbox_initial_state.json?filter_by_folder=default&dm_users=false",
          authToken, ct0,
        );
        if (inboxRes.ok) {
          const data = await inboxRes.json() as any;
          const state = data.inbox_initial_state ?? {};
          const usersMap: Record<string, any> = state.users ?? {};
          const convs: Record<string, any> = state.conversations ?? {};
          // Find myUserId: in each conversation, one participant has read_event_id set (that's us)
          for (const conv of Object.values(convs) as any[]) {
            if (conv.read_event_id && conv.participants?.length === 2) {
              // Twitter sets read_event_id on the conversation — but doesn't tell us which participant
              // Use a different signal: find the participant NOT in usersMap (they're us — Twitter
              // often omits the current user from the users expansion)
              for (const p of conv.participants) {
                if (!usersMap[p.user_id]) {
                  myUserId = p.user_id;
                  break;
                }
              }
              if (myUserId) break;
            }
          }
        }
      } catch { /* ignore */ }
    }

    if (screenName || myUserId) {
      await (prisma as any).xToken.update({
        where: { userId },
        data: {
          ...(screenName ? { screenName } : {}),
          ...(myUserId ? { myUserId } : {}),
        },
      });
    }

    return { screenName: screenName || "connected" };
  },

  async syncWithCookie(userId: string): Promise<{ synced: number }> {
    const rec = await (prisma as any).xToken.findUnique({ where: { userId } });
    if (!rec?.cookieAuthToken || !rec?.cookieCt0) throw new Error("X cookies not saved");

    const { cookieAuthToken: authToken, cookieCt0: ct0, myUserId } = rec;
    const cutoff = rec.lastSyncAt ? new Date(rec.lastSyncAt).getTime() : Date.now() - 7 * 24 * 60 * 60 * 1000;

    const inboxRes = await twitterFetch(
      "/i/api/1.1/dm/inbox_initial_state.json?filter_by_folder=default&dm_users=false&include_groups=true&include_inbox_timelines=true&supports_reactions=true&include_conversation_info=true",
      authToken, ct0,
    );
    if (!inboxRes.ok) {
      if (inboxRes.status === 401 || inboxRes.status === 403) {
        await (prisma as any).xToken.update({ where: { userId }, data: { cookieAuthToken: null, cookieCt0: null } });
        throw new Error("X cookies expired — please reconnect");
      }
      throw new Error(`X inbox fetch failed: ${inboxRes.status}`);
    }

    const data = await inboxRes.json() as any;
    const state = data.inbox_initial_state ?? {};
    const usersMap: Record<string, any> = state.users ?? {};
    const entries: any[] = state.entries ?? [];

    let synced = 0;
    for (const entry of entries) {
      const md = entry.message?.data?.message_data;
      if (!md?.text || !md.id) continue;

      const createdAt = new Date(Number(md.time));
      if (createdAt.getTime() < cutoff) continue;

      const senderId: string = md.sender_id ?? "";
      const isFromMe = senderId === myUserId;
      const otherUserId = isFromMe ? md.recipient_id : senderId;
      const otherUser = usersMap[otherUserId];
      const screenName: string | undefined = otherUser?.screen_name;

      let contactId: string | null = null;
      let contactName: string = otherUser?.name ?? screenName ?? otherUserId;

      if (screenName || otherUserId) {
        const platform = await prisma.platform.findFirst({
          where: {
            type: "x",
            OR: [
              ...(screenName ? [{ platformId: screenName }] : []),
              { platformId: otherUserId },
            ],
          },
        });
        if (platform) {
          contactId = platform.contactId;
          const contact = await prisma.contact.findUnique({ where: { id: contactId } });
          if (contact) contactName = contact.name;
        }
      }

      await inboxService.upsert({
        platform: "x",
        externalId: md.id,
        userId,
        contactId,
        contactName,
        senderId: otherUserId,
        preview: md.text.slice(0, 120),
        body: md.text,
        receivedAt: createdAt,
        needsReply: !isFromMe,
        fromMe: isFromMe,
      });
      synced++;
    }

    await (prisma as any).xToken.update({ where: { userId }, data: { lastSyncAt: new Date() } });
    return { synced };
  },

  async sync(userId: string): Promise<{ synced: number }> {
    const rec = await (prisma as any).xToken.findUnique({ where: { userId } });
    if (!rec) throw new Error("X not connected");

    // Prefer cookie-based sync (no API plan needed)
    if (rec.cookieAuthToken && rec.cookieCt0) {
      return xService.syncWithCookie(userId);
    }
    // Fall back to official API (requires $100/mo Basic plan)

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
