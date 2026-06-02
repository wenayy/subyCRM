import crypto from "crypto";
import { prisma } from "../lib/prisma";
import { inboxService } from "./inbox.service";

const CLIENT_ID = process.env.LINKEDIN_CLIENT_ID || "";
const CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET || "";
const REDIRECT_URI = `${process.env.AUTH_BASE_URL || "http://localhost:4002"}/api/linkedin/callback`;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3005";

// Sign userId into state so hot-reloads don't wipe the pending Map
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
    throw new Error("LinkedIn OAuth state invalid or expired");
  }
}

export const linkedinService = {
  buildAuthUrl(userId: string): string {
    if (!CLIENT_ID) throw new Error("LINKEDIN_CLIENT_ID not configured in .env.local");
    const state = signState(userId);
    const params = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: "openid profile email",
      state,
    });
    return `https://www.linkedin.com/oauth/v2/authorization?${params}`;
  },

  async handleCallback(code: string, state: string): Promise<void> {
    const userId = verifyState(state);

    const tokenRes = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
      }),
    });
    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error("[linkedin] token exchange failed:", errText);
      throw new Error(`LinkedIn token exchange failed: ${errText}`);
    }
    const tokenData = await tokenRes.json() as { access_token: string };

    // Try OpenID Connect userinfo first, fall back to legacy /v2/me
    let profileId: string | null = null;
    let displayName: string | null = null;

    const userInfoRes = await fetch("https://api.linkedin.com/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (userInfoRes.ok) {
      const p = await userInfoRes.json() as { sub?: string; name?: string; given_name?: string; family_name?: string };
      profileId = p.sub ?? null;
      displayName = p.name ?? ([p.given_name, p.family_name].filter(Boolean).join(" ") || null);
    } else {
      console.warn("[linkedin] /v2/userinfo failed, trying legacy /v2/me");
      const legacyRes = await fetch(
        "https://api.linkedin.com/v2/me?projection=(id,localizedFirstName,localizedLastName)",
        { headers: { Authorization: `Bearer ${tokenData.access_token}` } },
      );
      if (legacyRes.ok) {
        const p = await legacyRes.json() as { id?: string; localizedFirstName?: string; localizedLastName?: string };
        profileId = p.id ?? null;
        displayName = [p.localizedFirstName, p.localizedLastName].filter(Boolean).join(" ") || null;
      }
    }

    await (prisma as any).linkedInToken.upsert({
      where: { userId },
      create: { userId, accessToken: tokenData.access_token, profileId, profileName: displayName },
      update: { accessToken: tokenData.access_token, profileId, profileName: displayName },
    });
  },

  async getStatus(userId: string) {
    const rec = await (prisma as any).linkedInToken.findUnique({ where: { userId } }).catch(() => null);
    if (!rec) return { connected: false, profileName: null };
    return { connected: true, profileName: rec.profileName };
  },

  async disconnect(userId: string) {
    await (prisma as any).linkedInToken.deleteMany({ where: { userId } });
  },

  async saveCookie(userId: string, liAtCookie: string): Promise<void> {
    // Validate cookie works before saving by calling Voyager API
    const testRes = await fetch(
      "https://www.linkedin.com/voyager/api/me",
      {
        headers: {
          cookie: `li_at=${liAtCookie}`,
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "x-restli-protocol-version": "2.0.0",
          "x-li-lang": "en_US",
        },
      }
    );
    if (!testRes.ok) {
      throw new Error(`LinkedIn cookie validation failed (${testRes.status}) — make sure you copied the li_at cookie correctly`);
    }
    const profile = await testRes.json() as any;
    const profileId = profile?.miniProfile?.entityUrn?.replace("urn:li:fs_miniProfile:", "") ?? null;
    const firstName = profile?.miniProfile?.firstName ?? "";
    const lastName = profile?.miniProfile?.lastName ?? "";
    const displayName = [firstName, lastName].filter(Boolean).join(" ") || null;

    await (prisma as any).linkedInToken.upsert({
      where: { userId },
      create: { userId, accessToken: "", liAtCookie, profileId, profileName: displayName },
      update: { liAtCookie, profileId, profileName: displayName },
    });
    console.log(`[linkedin] Cookie saved for userId=${userId}, profile: ${displayName}`);
  },

  async syncMessages(userId: string): Promise<{ synced: number }> {
    const rec = await (prisma as any).linkedInToken.findUnique({ where: { userId } });
    if (!rec?.liAtCookie) {
      console.log(`[linkedin-sync] userId=${userId} — no li_at cookie, skipping`);
      return { synced: 0 };
    }

    const headers = {
      cookie: `li_at=${rec.liAtCookie}`,
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "x-restli-protocol-version": "2.0.0",
      "x-li-lang": "en_US",
      accept: "application/vnd.linkedin.normalized+json+2.1",
    };

    // Fetch conversation list
    const convRes = await fetch(
      "https://www.linkedin.com/voyager/api/messaging/conversations?keyVersion=LEGACY_INBOX&q=inbox",
      { headers }
    );
    if (!convRes.ok) {
      if (convRes.status === 401 || convRes.status === 403) {
        console.warn(`[linkedin-sync] userId=${userId} — cookie expired (${convRes.status})`);
        // Clear the invalid cookie so the user knows they need to re-enter it
        await (prisma as any).linkedInToken.update({
          where: { userId },
          data: { liAtCookie: null },
        });
      }
      throw new Error(`LinkedIn conversations fetch failed: ${convRes.status}`);
    }

    const convData = await convRes.json() as any;
    const conversations: any[] = convData?.elements ?? [];

    let synced = 0;
    const cutoff = rec.lastSyncAt ? new Date(rec.lastSyncAt).getTime() : Date.now() - 7 * 24 * 60 * 60 * 1000;

    for (const conv of conversations) {
      try {
        const convId: string = conv.entityUrn?.replace("urn:li:fs_conversation:", "") ?? conv.id;
        if (!convId) continue;

        // Get last message from the conversation element itself (no extra API call needed)
        const lastActivityAt: number = conv.lastActivityAt ?? 0;
        const events: any[] = conv["*events"]
          ? [] // events are in a separate call — fetch them
          : conv.events ?? [];

        // Fetch events (messages) for this conversation
        const eventsRes = await fetch(
          `https://www.linkedin.com/voyager/api/messaging/conversations/${encodeURIComponent(convId)}/events?keyVersion=LEGACY_INBOX`,
          { headers }
        );
        if (!eventsRes.ok) continue;
        const eventsData = await eventsRes.json() as any;
        const messages: any[] = eventsData?.elements ?? [];

        // Identify the other participant (not ourself)
        const participants: any[] = conv.participants ?? [];
        const otherParticipant = participants.find(
          (p: any) => p.miniProfile?.entityUrn !== `urn:li:fs_miniProfile:${rec.profileId}`
        ) ?? participants[0];
        const senderName = otherParticipant
          ? [otherParticipant.miniProfile?.firstName, otherParticipant.miniProfile?.lastName].filter(Boolean).join(" ")
          : null;
        const senderLinkedInId = otherParticipant?.miniProfile?.entityUrn?.replace("urn:li:fs_miniProfile:", "") ?? null;

        for (const event of messages) {
          const msgId: string = event.entityUrn?.replace("urn:li:fs_event:", "") ?? event.id;
          if (!msgId) continue;

          const createdAt: number = event.createdAt ?? 0;
          if (createdAt < cutoff) continue; // skip old messages

          const body: string = event.eventContent?.messageBody?.text ?? "";
          if (!body) continue; // skip system events, reaction events, etc.

          const senderUrn: string = event.from?.["*actor"] ?? event.from?.actor ?? "";
          const isFromMe = rec.profileId && senderUrn.includes(rec.profileId);

          // Resolve or create contact for the LinkedIn sender
          let contactId: string | null = null;
          let contactName: string | null = senderName;
          if (senderLinkedInId) {
            const platform = await prisma.platform.findFirst({
              where: { type: "linkedin", platformId: senderLinkedInId },
            });
            if (platform) {
              contactId = platform.contactId;
              const contact = await prisma.contact.findUnique({ where: { id: contactId } });
              contactName = contact?.name ?? senderName;
            }
          }

          await inboxService.upsert({
            platform: "linkedin",
            externalId: msgId,
            contactId,
            contactName,
            senderId: senderLinkedInId,
            preview: body.slice(0, 120),
            body,
            receivedAt: new Date(createdAt),
            needsReply: !isFromMe,
            fromMe: !!isFromMe,
          });
          synced++;
        }
      } catch (convErr: any) {
        console.error(`[linkedin-sync] conversation error:`, convErr.message);
      }
    }

    await (prisma as any).linkedInToken.update({
      where: { userId },
      data: { lastSyncAt: new Date() },
    });

    return { synced };
  },

  get callbackRedirect() { return `${FRONTEND_URL}/dashboard/settings?linkedin=connected`; },
  get callbackErrorRedirect() { return `${FRONTEND_URL}/dashboard/settings?linkedin=error`; },
};
