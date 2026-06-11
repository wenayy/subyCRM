import { prisma } from "../lib/prisma";
import { inboxService } from "./inbox.service";
import { encrypt, decrypt } from "../lib/encryption";
import { deduplicateContacts } from "./dedup.service";
import { cache } from "../lib/cache";
import type { PlatformType } from "@prisma/client";
import fs from "fs/promises";
import path from "path";

const HOMESERVER = "https://matrix.beeper.com";
const DEFAULT_LOCAL_API = "http://localhost:23373";

function getLocalApi(session: any): string {
  return (session?.localEndpoint || "").trim().replace(/\/$/, "") || DEFAULT_LOCAL_API;
}

// Persistent long-poll connections per userId
const activeLongPolls = new Map<string, AbortController>();

// Bridge system notifications that look like messages but aren't
const SYSTEM_MESSAGE_RE = /^(you (joined|left) the chat|.+ (joined|left) the (chat|group)|this chat is end-to-end encrypted|messages? and calls? are end-to-end encrypted)\.?$/i;

const NETWORK_TO_PLATFORM: Record<string, string> = {
  "LinkedIn": "linkedin",
  "Twitter/X": "x",
  "Twitter": "x",
  "X": "x",
  "WhatsApp": "whatsapp",
  "Telegram": "telegram",
  "Discord": "discord",
  "iMessage": "imessage",
  "Signal": "signal",
  "Instagram": "instagram",
  "Facebook Messenger": "facebook",
  "Slack": "slack",
};

// Matrix filter — only receive message events, nothing else
const LONG_POLL_FILTER = JSON.stringify({
  room: {
    timeline: { types: ["m.room.message", "m.room.encrypted"], limit: 10 },
    state: { types: [] },
    ephemeral: { not_types: ["*"] },
    account_data: { not_types: ["*"] },
  },
  account_data: { not_types: ["*"] },
  presence: { not_types: ["*"] },
});

function parseBeeperSender(sender: string): { platform: string; platformId: string } | null {
  const match = sender.match(/^@(linkedin|twitter|whatsapp|telegram|discord|signal|instagram|facebook|slack|imessage)_(.+):/);
  if (!match) return null;

  const [, service, rawId] = match;
  const platform = service === "twitter" ? "x" : service;

  // Decode Matrix uppercase encoding (e.g. _a -> A)
  const platformId = rawId.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
  return { platform, platformId };
}

function profileUrl(platform: string, platformId: string): string | null {
  if (platform === "x") return `https://x.com/${platformId}`;
  if (platform === "telegram") return `https://t.me/${platformId}`;
  if (platform === "linkedin") return `https://linkedin.com/in/${platformId}`;
  return null;
}

// Beeper bridges (LinkedIn, WA bots, Telegram formatted msgs) often send HTML in the text field.
// Convert to clean plain text before storing.
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/blockquote>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png",
    "image/gif": ".gif", "image/webp": ".webp", "image/heic": ".heic",
    "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm",
    "audio/mpeg": ".mp3", "audio/ogg": ".ogg", "audio/mp4": ".m4a",
    "application/pdf": ".pdf",
  };
  return map[mime] ?? ".bin";
}

// Save media from a Beeper attachment to /public/media/, return markdown tag.
// Beeper local API attachment shape: { id: "mxc://...", srcURL: "file:///...", mimeType, fileName, ... }
async function downloadBeeperMedia(
  attachment: any,
  localToken: string,
  msgId: string,
  localEndpoint = DEFAULT_LOCAL_API,
): Promise<string | null> {
  const mime: string = attachment.mimeType ?? "application/octet-stream";
  const rawName: string = attachment.fileName ?? attachment.filename ?? `media_${msgId}`;
  const name = rawName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const ext = path.extname(name) || mimeToExt(mime);
  const safeName = name.endsWith(ext) ? name : `${name}${ext}`;
  const uniqueName = `${Date.now()}_${safeName}`;

  let buffer: Buffer | null = null;

  // Fast path: srcURL is a file:// path — works only when this server runs on
  // the same machine as Beeper Desktop (local dev)
  const srcUrl: string | undefined = attachment.srcURL;
  if (srcUrl?.startsWith("file://")) {
    const localPath = decodeURIComponent(srcUrl.replace(/^file:\/\//, ""));
    try {
      buffer = await fs.readFile(localPath);
      console.log(`[beeper-media-rx] read from srcURL ${localPath} (${buffer.length} bytes)`);
    } catch {
      // File not on this machine (e.g. server on Railway) — fall through to assets/serve
    }
  }

  // Stream the decrypted bytes via the Desktop API. Works for mxc:// /
  // localmxc:// URLs (including E2E-encrypted ones with encryptedFileInfoJSON)
  // and also when the server is remote from Beeper Desktop.
  if (!buffer) {
    const assetUrl: string | undefined =
      (srcUrl && !srcUrl.startsWith("file://") ? srcUrl : undefined) ?? attachment.id ?? attachment.url;
    if (!assetUrl) {
      console.warn(`[beeper-media-rx] no srcURL or mxc id on attachment, keys=${Object.keys(attachment).join(",")}`);
      return null;
    }
    try {
      const serveUrl = `${localEndpoint}/v1/assets/serve?url=${encodeURIComponent(assetUrl)}`;
      console.log(`[beeper-media-rx] fetching via assets/serve for msgId=${msgId}`);
      const res = await fetch(serveUrl, {
        headers: { Authorization: `Bearer ${localToken}` },
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        console.warn(`[beeper-media-rx] assets/serve fetch failed ${res.status}`);
        return null;
      }
      buffer = Buffer.from(await res.arrayBuffer());
      console.log(`[beeper-media-rx] downloaded ${buffer.length} bytes via assets/serve`);
    } catch (e: any) {
      console.error(`[beeper-media-rx] error for msgId=${msgId}:`, e?.message);
      return null;
    }
  }

  if (!buffer.length) return null;

  const { saveMedia } = await import("../lib/media-store");
  const url = await saveMedia(buffer, uniqueName, mime);
  const isImage = mime.startsWith("image/") || /\.(jpg|jpeg|png|gif|webp)$/i.test(safeName);
  const isVideo = mime.startsWith("video/") || /\.(mp4|mov|webm|avi)$/i.test(safeName);
  console.log(`[beeper-media-rx] saved ${uniqueName} → ${url}`);
  return (isImage || isVideo) ? `![${safeName}](${url})` : `[${safeName}](${url})`;
}

export const beeperService = {
  async connect(userId: string, matrixId: string, accessToken: string, localToken?: string, localEndpoint?: string) {
    const whoamiUrl = `${HOMESERVER}/_matrix/client/v3/account/whoami`;
    const res = await fetch(whoamiUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      throw new Error("Invalid access token. Please verify your Beeper Matrix token.");
    }

    const data = await res.json() as { user_id?: string };
    const validatedMatrixId = data.user_id || matrixId;
    const encryptedToken = encrypt(accessToken);

    await (prisma as any).beeperSession.upsert({
      where: { userId },
      create: { userId, matrixId: validatedMatrixId, accessToken: encryptedToken, localToken: localToken || null, localEndpoint: localEndpoint || null, connected: true },
      update: { matrixId: validatedMatrixId, accessToken: encryptedToken, localToken: localToken || null, localEndpoint: localEndpoint || null, connected: true, lastSyncAt: null, nextBatch: null },
    });

    // Initial sync to pull history, then start real-time long-poll
    beeperService.sync(userId).then(() => {
      const token = localToken || process.env.BEEPER_LOCAL_TOKEN;
      if (token) beeperService.startLongPoll(userId);
    }).catch(console.error);

    return { matrixId: validatedMatrixId };
  },

  async getStatus(userId: string) {
    const session = await (prisma as any).beeperSession.findUnique({ where: { userId } }).catch(() => null);
    if (!session) {
      return { connected: false, matrixId: null, lastSync: null, hasLocalToken: false, isPolling: false };
    }
    return {
      connected: session.connected,
      matrixId: session.matrixId,
      lastSync: session.lastSyncAt?.toISOString() ?? null,
      hasLocalToken: !!session.localToken,
      isPolling: activeLongPolls.has(userId),
    };
  },

  async disconnect(userId: string) {
    beeperService.stopLongPoll(userId);
    await (prisma as any).beeperSession.deleteMany({ where: { userId } });
  },

  // ─── Real-time long-poll via Matrix ──────────────────────────
  startLongPoll(userId: string): void {
    // Stop any existing poll for this user first
    beeperService.stopLongPoll(userId);

    const controller = new AbortController();
    activeLongPolls.set(userId, controller);

    const run = async () => {
      console.log(`[beeper-poll] Starting real-time long-poll for user=${userId}`);
      let backoffMs = 0;

      try {
      while (!controller.signal.aborted) {
        if (backoffMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          if (controller.signal.aborted) break;
          backoffMs = 0;
        }

        let session: any;
        try {
          session = await (prisma as any).beeperSession.findUnique({ where: { userId } });
        } catch {
          backoffMs = 5000;
          continue;
        }

        if (!session?.connected) {
          console.log(`[beeper-poll] Session disconnected for user=${userId}, stopping`);
          break;
        }

        const accessToken = decrypt(session.accessToken);
        const localToken = session.localToken || process.env.BEEPER_LOCAL_TOKEN;
        const localEndpoint = getLocalApi(session);
        const since = session.nextBatch;

        let url = `${HOMESERVER}/_matrix/client/v3/sync?timeout=30000&filter=${encodeURIComponent(LONG_POLL_FILTER)}`;
        if (since) url += `&since=${encodeURIComponent(since)}`;

        let res: Response;
        try {
          res = await fetch(url, {
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: controller.signal,
          });
        } catch (err: any) {
          if (controller.signal.aborted) break;
          console.warn(`[beeper-poll] Network error for user=${userId}: ${err.message}`);
          backoffMs = 5000;
          continue;
        }

        if (res.status === 401) {
          console.warn(`[beeper-poll] Token expired for user=${userId}, stopping`);
          await (prisma as any).beeperSession.update({
            where: { userId },
            data: { connected: false },
          }).catch(() => {});
          break;
        }

        if (!res.ok) {
          console.warn(`[beeper-poll] Matrix returned ${res.status} for user=${userId}, backing off`);
          backoffMs = 5000;
          continue;
        }

        let data: any;
        try {
          data = await res.json();
        } catch {
          backoffMs = 1000;
          continue;
        }

        const nextBatch: string | undefined = data.next_batch;
        const rooms: Record<string, any> = data.rooms?.join ?? {};

        if (!localToken) {
          // No local API — save nextBatch and move on
          if (nextBatch) {
            await (prisma as any).beeperSession.update({
              where: { userId },
              data: { nextBatch, lastSyncAt: new Date() },
            }).catch(() => {});
          }
          continue;
        }

        const activeRooms = Object.entries(rooms).filter(([, roomData]) => {
          const timelineEvents: any[] = (roomData as any).timeline?.events ?? [];
          return timelineEvents.some((e: any) =>
            e.type === "m.room.message" || e.type === "m.room.encrypted"
          );
        });

        // Wait for Beeper's local bridge to finish processing the event before we fetch.
        // Without this delay the local API often returns stale results (race condition).
        if (activeRooms.length > 0) {
          await new Promise((r) => setTimeout(r, 1500));
          if (controller.signal.aborted) break;
        }

        // Process rooms sequentially to avoid saturating the DB connection pool
        for (const [roomId] of activeRooms) {
          if (controller.signal.aborted) break;

          const { synced } = await beeperService.syncSingleChat(userId, roomId, localToken, localEndpoint).catch((err) => {
            console.warn(`[beeper-poll] syncSingleChat failed room=${roomId}: ${err.message}`);
            return { synced: 0 };
          });

          // Retry with longer delays — local API may still be catching up
          if (synced === 0) {
            await new Promise((r) => setTimeout(r, 3000));
            if (controller.signal.aborted) break;
            const { synced: synced2 } = await beeperService.syncSingleChat(userId, roomId, localToken, localEndpoint).catch(() => ({ synced: 0 }));
            if (synced2 === 0) {
              await new Promise((r) => setTimeout(r, 6000));
              if (controller.signal.aborted) break;
              await beeperService.syncSingleChat(userId, roomId, localToken, localEndpoint).catch(() => {});
            }
          }
        }

        // Save nextBatch AFTER processing all rooms — ensures we never advance past an
        // event we failed to process (missing messages would be unrecoverable otherwise)
        if (nextBatch) {
          await (prisma as any).beeperSession.update({
            where: { userId },
            data: { nextBatch, lastSyncAt: new Date() },
          }).catch(() => {});
        }
      }

      } catch (err: any) {
        if (!controller.signal.aborted) {
          console.error(`[beeper-poll] Unexpected crash for user=${userId}: ${err.message}`);
        }
      }

      activeLongPolls.delete(userId);
      console.log(`[beeper-poll] Long-poll ended for user=${userId}`);

      // Auto-restart unless explicitly stopped (aborted) or token expired
      if (!controller.signal.aborted) {
        try {
          const session = await (prisma as any).beeperSession.findUnique({ where: { userId } });
          if (session?.connected) {
            console.log(`[beeper-poll] Auto-restarting for user=${userId} in 15s`);
            await new Promise((r) => setTimeout(r, 15000));
            if (!controller.signal.aborted) beeperService.startLongPoll(userId);
          }
        } catch {}
      }
    };

    run().catch((err) => {
      console.error(`[beeper-poll] Fatal error for user=${userId}:`, err.message);
      activeLongPolls.delete(userId);
      if (!controller.signal.aborted) {
        setTimeout(() => beeperService.startLongPoll(userId), 15000);
      }
    });
  },

  stopLongPoll(userId: string): void {
    const controller = activeLongPolls.get(userId);
    if (controller) {
      controller.abort();
      activeLongPolls.delete(userId);
    }
  },

  stopAllLongPolls(): void {
    for (const controller of activeLongPolls.values()) {
      controller.abort();
    }
    activeLongPolls.clear();
  },

  // ─── Fetch & store messages for a single room from local API ──
  async syncSingleChat(userId: string, roomId: string, localToken: string, localEndpoint = DEFAULT_LOCAL_API): Promise<{ synced: number }> {
    const headers = { Authorization: `Bearer ${localToken}` };

    // Try to resolve contact from existing messages for this room
    const prevMsg = await (prisma as any).inboxMessage.findFirst({
      where: { matrixRoomId: roomId, userId },
      orderBy: { receivedAt: "desc" },
      select: { contactId: true, contactName: true, platform: true, senderId: true },
    });

    let contactId: string | null = prevMsg?.contactId ?? null;
    let contactName: string | null = prevMsg?.contactName ?? null;
    let platform: string | null = prevMsg?.platform ?? null;
    let platformId: string | null = prevMsg?.senderId ?? null;

    // If prevMsg exists but senderId is null, recover platformId from the platform record
    if (prevMsg && !platformId && contactId && platform) {
      const platRecord = await prisma.platform.findFirst({
        where: { type: platform as PlatformType, contactId },
        select: { platformId: true },
      });
      platformId = platRecord?.platformId ?? null;
    }

    console.log(`[beeper-sync] room=${roomId.slice(0, 20)} prevMsg=${!!prevMsg} contactId=${contactId?.slice(0,8)} platform=${platform} platformId=${platformId?.slice(0,12)}`);

    // If room is unknown, ask local API for chat metadata
    if (!contactId || !platform) {
      const chatRes = await fetch(`${localEndpoint}/v1/chats/${encodeURIComponent(roomId)}`, { headers });
      if (!chatRes.ok) {
        console.log(`[beeper-sync] local API chat fetch failed: ${chatRes.status} for room=${roomId.slice(0, 20)}`);
        return { synced: 0 };
      }
      const chat = await chatRes.json() as any;

      if (!NETWORK_TO_PLATFORM[chat.network] || chat.type !== "single") return { synced: 0 };
      platform = NETWORK_TO_PLATFORM[chat.network];

      const otherParticipant = (chat.participants?.items ?? []).find((p: any) => !p.isSelf);
      if (!otherParticipant) return { synced: 0 };
      // Prefer native platform ID extracted from Matrix user ID (e.g. @discord_123456:beeper.com → 123456)
      // so it matches the ID stored by native integrations (Discord, X, etc.)
      const nativeIdMatch = (otherParticipant.id || "").match(/^@[a-z]+_(.+):[^:]+$/);
      platformId = (nativeIdMatch ? nativeIdMatch[1] : null) || otherParticipant.username || otherParticipant.id || otherParticipant.userID || roomId;
      const displayName: string = otherParticipant.fullName || otherParticipant.displayName || chat.title || platformId;

      let platformRecord = await prisma.platform.findFirst({
        where: { type: platform as PlatformType, platformId: platformId!, contact: { userId } },
      });
      // Fallback: match by username or displayName (handles case where native integration
      // stored username as platformId and Beeper now has the numeric ID, or vice versa).
      // Never match by displayName on phone-based platforms — numbers are the identity
      // there and several different people can share one display name ("Yogesh").
      if (!platformRecord && displayName) {
        const phoneBased = platform === "whatsapp" || platform === "telegram";
        platformRecord = await (prisma as any).platform.findFirst({
          where: {
            type: platform as PlatformType,
            contact: { userId },
            OR: [
              ...(phoneBased ? [] : [{ displayName: { equals: displayName, mode: "insensitive" } }]),
              { platformId: { equals: otherParticipant.username || "", mode: "insensitive" } },
            ],
          },
        }) ?? null;
      }
      if (platformRecord) {
        contactId = platformRecord.contactId;
        const contact = await prisma.contact.findUnique({ where: { id: contactId } });
        contactName = contact?.name ?? displayName;
      } else {
        const contact = await prisma.contact.create({
          data: {
            userId,
            name: displayName,
            platforms: {
              create: [{ type: platform as PlatformType, platformId: platformId!, displayName, profileUrl: profileUrl(platform, platformId!) }],
            },
          },
        });
        contactId = contact.id;
        contactName = contact.name;
        deduplicateContacts(userId).catch(console.error);
        cache.invalidateContacts().catch(() => {});
      }
    }

    if (!contactId || !platform || !platformId) return { synced: 0 };

    // Fetch the latest messages from local API
    const msgsRes = await fetch(`${localEndpoint}/v1/chats/${encodeURIComponent(roomId)}/messages?limit=100`, { headers });
    if (!msgsRes.ok) return { synced: 0 };
    const msgsData = await msgsRes.json() as any;
    const messages: any[] = msgsData.items ?? [];

    let synced = 0;

    for (const msg of messages) {
      const rawText = (msg.text || msg.body || "").trim();
      const attachments: any[] = msg.attachments ?? [];

      // Build message content: text + any media attachments
      let cleanText = stripHtml(rawText);
      if (attachments.length > 0) {
        console.log(`[beeper-media-rx] msg id=${msg.id} has ${attachments.length} attachment(s): ${JSON.stringify(attachments.map((a: any) => ({ url: a.url, mimeType: a.mimeType, filename: a.filename })))}`);
        const mediaTags = (await Promise.all(
          attachments.map((a: any) => downloadBeeperMedia(a, localToken, String(msg.id), localEndpoint))
        )).filter(Boolean) as string[];
        if (mediaTags.length > 0) {
          cleanText = cleanText ? `${cleanText}\n\n${mediaTags.join("\n")}` : mediaTags.join("\n");
        }
      }

      if (!cleanText) {
        console.log(`[beeper-sync] skipping msg id=${msg.id} — empty after processing (rawText="${rawText}", attachments=${attachments.length})`);
        continue;
      }
      if (SYSTEM_MESSAGE_RE.test(cleanText)) continue;

      const canonicalId = `bl-${msg.id}`;
      const receivedAt = new Date(msg.timestamp);
      const ts = receivedAt.getTime();

      // Already stored under canonical ID — skip
      const exists = await (prisma as any).inboxMessage.findFirst({
        where: { platform: platform as any, externalId: canonicalId, userId },
        select: { id: true },
      });
      if (exists) continue;

      // Dedup by body+timestamp: Beeper sometimes assigns a new ID to the same message
      // (e.g. pending → final Telegram ID), which would bypass the externalId check above.
      const bodyDup = await (prisma as any).inboxMessage.findFirst({
        where: {
          userId, contactId, platform: platform as any,
          body: cleanText, fromMe: !!msg.isSender,
          receivedAt: { gte: new Date(ts - 30000), lte: new Date(ts + 30000) },
        },
        select: { id: true },
      });
      if (bodyDup) {
        await (prisma as any).inboxMessage.update({
          where: { id: bodyDup.id },
          data: { externalId: canonicalId, matrixRoomId: roomId },
        }).catch(() => {});
        continue;
      }

      // Sent message: check if stored under a temp ID and merge
      if (msg.isSender) {
        const tempEntry = await (prisma as any).inboxMessage.findFirst({
          where: {
            userId, contactId, platform: platform as any, fromMe: true,
            receivedAt: { gte: new Date(ts - 30000), lte: new Date(ts + 30000) },
            NOT: { externalId: canonicalId },
          },
          select: { id: true, body: true },
        });
        if (tempEntry && tempEntry.body === cleanText) {
          await (prisma as any).inboxMessage.update({
            where: { id: tempEntry.id },
            data: { externalId: canonicalId, matrixRoomId: roomId },
          }).catch(() => {});
          continue;
        }
      }

      await inboxService.upsert({
        platform: platform as any,
        externalId: canonicalId,
        userId,
        contactId,
        contactName: contactName!,
        senderId: platformId!,
        preview: cleanText.slice(0, 120),
        body: cleanText,
        receivedAt,
        fromMe: !!msg.isSender,
      });
      await (prisma as any).inboxMessage.updateMany({
        where: { externalId: canonicalId, userId },
        data: { matrixRoomId: roomId },
      }).catch(() => {});
      synced++;
    }

    if (synced > 0) {
      console.log(`[beeper-poll] room=${roomId} — stored ${synced} new message(s)`);
    }

    return { synced };
  },

  // ─── Full sync via local API (used for initial/manual sync) ──
  async syncViaLocalApi(userId: string, localToken: string, localEndpoint = DEFAULT_LOCAL_API): Promise<{ synced: number; importedContacts: number }> {
    const session = await (prisma as any).beeperSession.findUnique({ where: { userId } });
    const isFirstSync = !session?.lastSyncAt;
    // First sync: import all history. Subsequent syncs: only last 30 days of new messages.
    const cutoff = session?.lastSyncAt
      ? new Date(session.lastSyncAt)
      : new Date(0);

    const headers = { Authorization: `Bearer ${localToken}` };

    // Paginate through all chats — API defaults to ~25 per page
    const chats: any[] = [];
    let chatCursor: string | null = null;
    while (true) {
      const url = chatCursor
        ? `${localEndpoint}/v1/chats?limit=100&cursor=${chatCursor}`
        : `${localEndpoint}/v1/chats?limit=100`;
      const chatsRes = await fetch(url, { headers });
      if (!chatsRes.ok) throw new Error(`Local Beeper API failed: ${chatsRes.status}`);
      const chatsData = await chatsRes.json() as any;
      chats.push(...(chatsData.items ?? []));
      if (!chatsData.hasMore) break;
      chatCursor = chatsData.oldestCursor ?? chatsData.nextCursor ?? null;
      if (!chatCursor) break;
    }

    console.log(`[beeper-local] total chats=${chats.length}`);
    for (const c of chats) {
      const known = !!NETWORK_TO_PLATFORM[c.network];
      const isDm = c.type === "single";
    }

    const dmChats = chats.filter((c: any) => {
      if (!NETWORK_TO_PLATFORM[c.network] || c.type !== "single") return false;
      if (session?.lastSyncAt && c.lastActivity) {
        return new Date(c.lastActivity) > new Date(session.lastSyncAt);
      }
      return true;
    });
    console.log(`[beeper-local] ${dmChats.length} active DM chats to sync`);

    let synced = 0;
    let importedContacts = 0;

    const syncOneChat = async (chat: any, quickOnly = false): Promise<{ synced: number; imported: number }> => {
      const chatId: string = chat.id;
      const network: string = chat.network;
      const platform = NETWORK_TO_PLATFORM[network]!;

      const otherParticipant = (chat.participants?.items ?? []).find((p: any) => !p.isSelf);
      if (!otherParticipant) return { synced: 0, imported: 0 };

      const nativeIdMatchSync = (otherParticipant.id || "").match(/^@[a-z]+_(.+):[^:]+$/);
      const platformId: string = (nativeIdMatchSync ? nativeIdMatchSync[1] : null) || otherParticipant.username || otherParticipant.id || otherParticipant.userID || chat.id;
      const displayName: string = otherParticipant.fullName || otherParticipant.displayName || chat.title || platformId;

      let contactId: string | null = null;
      let contactName: string = displayName;
      let imported = 0;

      let platformRecord = await prisma.platform.findFirst({
        where: { type: platform as PlatformType, platformId, contact: { userId } },
      });
      if (!platformRecord && displayName) {
        // displayName matching is unsafe on phone platforms — see syncSingleChat
        const phoneBased = platform === "whatsapp" || platform === "telegram";
        platformRecord = await (prisma as any).platform.findFirst({
          where: {
            type: platform as PlatformType,
            contact: { userId },
            OR: [
              ...(phoneBased ? [] : [{ displayName: { equals: displayName, mode: "insensitive" } }]),
              { platformId: { equals: otherParticipant.username || "", mode: "insensitive" } },
            ],
          },
        }) ?? null;
      }
      if (platformRecord) {
        contactId = platformRecord.contactId;
        const contact = await prisma.contact.findUnique({ where: { id: contactId } });
        if (contact) {
          contactName = contact.name;
        }
      } else {
        try {
          const contact = await prisma.contact.create({
            data: {
              userId,
              name: displayName,
              platforms: {
                create: [{ type: platform as PlatformType, platformId, displayName, profileUrl: profileUrl(platform, platformId) }],
              },
            },
          });
          contactId = contact.id;
          contactName = contact.name;
          imported++;
        } catch {
          // Race condition: another parallel chat created this contact first — look it up
          const existing = await prisma.platform.findFirst({ where: { type: platform as PlatformType, platformId, contact: { userId } } });
          if (existing) { contactId = existing.contactId; }
          else return { synced: 0, imported: 0 };
        }
      }

      let chatSynced = 0;
      let cursor: string | null = null;
      let reachedCutoff = false;

      // Skip message fetch entirely if this is an incremental sync and we already
      // have recent messages for this contact — saves a round trip per chat
      if (!isFirstSync && contactId) {
        const recentMsg = await (prisma as any).inboxMessage.findFirst({
          where: { userId, contactId, platform: platform as any },
          orderBy: { receivedAt: "desc" },
          select: { id: true },
        });
        if (recentMsg) return { synced: 0, imported };
      }

      while (!reachedCutoff) {
        const msgLimit = quickOnly ? 1 : 100;
        const url = cursor
          ? `${localEndpoint}/v1/chats/${encodeURIComponent(chatId)}/messages?limit=${msgLimit}&cursor=${cursor}`
          : `${localEndpoint}/v1/chats/${encodeURIComponent(chatId)}/messages?limit=${msgLimit}`;
        const msgsRes = await fetch(url, { headers });
        if (!msgsRes.ok) break;
        const msgsData = await msgsRes.json() as any;
        const messages: any[] = msgsData.items ?? [];

        for (const msg of messages) {
          const rawText = (msg.text || msg.body || "").trim();
          const attachments: any[] = msg.attachments ?? [];
          let cleanText = stripHtml(rawText);
          if (attachments.length > 0) {
            const mediaTags = (await Promise.all(
              attachments.map((a: any) => downloadBeeperMedia(a, localToken, String(msg.id), localEndpoint))
            )).filter(Boolean) as string[];
            if (mediaTags.length > 0) {
              cleanText = cleanText ? `${cleanText}\n\n${mediaTags.join("\n")}` : mediaTags.join("\n");
            }
          }
          if (!cleanText) continue;
          if (SYSTEM_MESSAGE_RE.test(cleanText)) continue;
          const receivedAt = new Date(msg.timestamp);
          if (receivedAt <= cutoff) { reachedCutoff = true; break; }

          const canonicalId = `bl-${msg.id}`;
          const ts = receivedAt.getTime();

          const bodyDup = await (prisma as any).inboxMessage.findFirst({
            where: {
              userId, contactId, platform: platform as any,
              body: cleanText, fromMe: !!msg.isSender,
              receivedAt: { gte: new Date(ts - 30000), lte: new Date(ts + 30000) },
            },
            select: { id: true },
          });
          if (bodyDup) {
            await (prisma as any).inboxMessage.update({
              where: { id: bodyDup.id },
              data: { externalId: canonicalId, matrixRoomId: chatId },
            }).catch(() => {});
            continue;
          }

          if (msg.isSender) {
            const existing = await (prisma as any).inboxMessage.findFirst({
              where: {
                userId, contactId, platform: platform as any, fromMe: true,
                receivedAt: { gte: new Date(ts - 30000), lte: new Date(ts + 30000) },
                NOT: { externalId: canonicalId },
              },
              select: { id: true, body: true },
            });
            if (existing && existing.body === cleanText) {
              await (prisma as any).inboxMessage.update({
                where: { id: existing.id },
                data: { externalId: canonicalId, matrixRoomId: chatId },
              }).catch(() => {});
              continue;
            }
          }

          await inboxService.upsert({
            platform: platform as any,
            externalId: canonicalId,
            userId,
            contactId,
            contactName,
            senderId: platformId,
            preview: cleanText.slice(0, 120),
            body: cleanText,
            receivedAt,
            fromMe: !!msg.isSender,
          });
          await (prisma as any).inboxMessage.updateMany({
            where: { externalId: canonicalId, userId },
            data: { matrixRoomId: chatId },
          }).catch(() => {});
          chatSynced++;
        }

        if (quickOnly || reachedCutoff || !msgsData.hasMore) break;
        cursor = msgsData.oldestCursor ?? null;
        if (!cursor) break;
      }

      return { synced: chatSynced, imported };
    };

    if (isFirstSync) {
      // Phase 1: fetch 1 message per chat — creates all contacts + shows latest message instantly
      const Q_BATCH = 16;
      for (let i = 0; i < dmChats.length; i += Q_BATCH) {
        const batch = dmChats.slice(i, i + Q_BATCH);
        const results = await Promise.allSettled(batch.map((c) => syncOneChat(c, true)));
        for (const r of results) {
          if (r.status === "fulfilled") {
            synced += r.value.synced;
            importedContacts += r.value.imported;
          }
        }
        console.log(`[beeper-local] phase1 batch ${Math.floor(i / Q_BATCH) + 1}/${Math.ceil(dmChats.length / Q_BATCH)} done — contacts=${importedContacts}`);
      }
      if (importedContacts > 0) {
        deduplicateContacts(userId).catch(console.error);
        cache.invalidateContacts().catch(() => {});
      }

      // Phase 2: full history — runs in background so the initial connect returns fast
      setImmediate(async () => {
        console.log(`[beeper-local] phase2 starting full history for ${dmChats.length} chats`);
        let p2synced = 0;
        const F_BATCH = 8;
        for (let i = 0; i < dmChats.length; i += F_BATCH) {
          const batch = dmChats.slice(i, i + F_BATCH);
          const results = await Promise.allSettled(batch.map((c) => syncOneChat(c, false)));
          for (const r of results) {
            if (r.status === "fulfilled") p2synced += r.value.synced;
          }
          console.log(`[beeper-local] phase2 batch ${Math.floor(i / F_BATCH) + 1}/${Math.ceil(dmChats.length / F_BATCH)} done — synced=${p2synced}`);
        }
        console.log(`[beeper-local] phase2 complete — ${p2synced} historical messages synced`);
      });
    } else {
      // Incremental: single-phase, only chats active since last sync
      const BATCH = 8;
      for (let i = 0; i < dmChats.length; i += BATCH) {
        const batch = dmChats.slice(i, i + BATCH);
        const results = await Promise.allSettled(batch.map((c) => syncOneChat(c, false)));
        for (const r of results) {
          if (r.status === "fulfilled") {
            synced += r.value.synced;
            importedContacts += r.value.imported;
          }
        }
        console.log(`[beeper-local] batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(dmChats.length / BATCH)} done — synced=${synced} contacts=${importedContacts}`);
      }
      if (importedContacts > 0) {
        deduplicateContacts(userId).catch(console.error);
        cache.invalidateContacts().catch(() => {});
      }
    }

    // Grab a fresh Matrix nextBatch pointing to "right now" so the long-poll that
    // starts after this sync doesn't replay the entire Matrix history from scratch.
    // syncViaLocalApi never calls Matrix, so nextBatch would be null/stale otherwise.
    try {
      const freshSession = await (prisma as any).beeperSession.findUnique({ where: { userId } });
      if (freshSession?.accessToken) {
        const accessToken = decrypt(freshSession.accessToken);
        const nowRes = await fetch(
          `${HOMESERVER}/_matrix/client/v3/sync?timeout=0&filter=${encodeURIComponent(JSON.stringify({ room: { timeline: { limit: 1 }, state: { types: [] }, ephemeral: { not_types: ["*"] }, account_data: { not_types: ["*"] } }, account_data: { not_types: ["*"] }, presence: { not_types: ["*"] } }))}`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (nowRes.ok) {
          const nowData = await nowRes.json() as any;
          if (nowData.next_batch) {
            await (prisma as any).beeperSession.update({
              where: { userId },
              data: { nextBatch: nowData.next_batch, lastSyncAt: new Date() },
            });
            console.log(`[beeper-local] nextBatch anchored to now — long-poll will start from current position`);
          }
        }
      }
    } catch (e: any) {
      console.warn(`[beeper-local] Could not anchor nextBatch: ${e.message}`);
      await (prisma as any).beeperSession.update({ where: { userId }, data: { lastSyncAt: new Date() } });
    }

    console.log(`[beeper-local] Done — synced=${synced} new messages, imported=${importedContacts} contacts`);
    return { synced, importedContacts };
  },

  async sync(userId: string): Promise<{ synced: number; importedContacts: number }> {
    const session = await (prisma as any).beeperSession.findUnique({ where: { userId } });
    if (!session || !session.connected) {
      throw new Error("Beeper not connected");
    }

    // Use local Beeper desktop API when available — gives decrypted messages directly
    const localToken = session.localToken || process.env.BEEPER_LOCAL_TOKEN;
    if (localToken) {
      return beeperService.syncViaLocalApi(userId, localToken, getLocalApi(session));
    }

    const accessToken = decrypt(session.accessToken);
    const matrixId = session.matrixId;

    const filter = JSON.stringify({
      room: {
        timeline: { limit: 50 },
        state: { types: ["m.room.member", "m.room.encryption"] },
      },
    });

    let syncUrl = `${HOMESERVER}/_matrix/client/v3/sync?timeout=0&filter=${encodeURIComponent(filter)}`;
    if (session.nextBatch) {
      syncUrl += `&since=${session.nextBatch}`;
    }

    console.log(`[beeper-sync] Syncing Matrix for user=${userId} since=${session.nextBatch || "beginning"}`);
    const res = await fetch(syncUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      if (res.status === 401) {
        await (prisma as any).beeperSession.update({
          where: { userId },
          data: { connected: false },
        });
        throw new Error("Beeper session expired. Please reconnect.");
      }
      throw new Error(`Matrix sync failed: ${res.statusText}`);
    }

    const data = await res.json() as any;
    const nextBatch = data.next_batch;
    const rooms = data.rooms?.join ?? {};

    let synced = 0;
    let importedContacts = 0;

    for (const [roomId, roomData] of Object.entries(rooms) as [string, any][]) {
      let otherParticipantId: string | null = null;
      let otherParticipantName: string | null = null;

      const stateEvents = roomData.state?.events ?? [];
      const timelineEvents = roomData.timeline?.events ?? [];
      const allEvents = [...stateEvents, ...timelineEvents];

      for (const event of allEvents) {
        if (event.type !== "m.room.member" || !event.state_key || event.state_key === matrixId) continue;
        const candidate = event.state_key as string;
        const name = (event.content?.displayname || event.content?.name) ?? null;
        if (parseBeeperSender(candidate)) {
          otherParticipantId = candidate;
          otherParticipantName = name;
        } else if (!otherParticipantId) {
          otherParticipantId = candidate;
          otherParticipantName = name;
        }
      }

      let parsed = otherParticipantId ? parseBeeperSender(otherParticipantId) : null;
      let resolvedContactId: string | null = null;
      let resolvedContactName: string | null = otherParticipantName;

      if (!parsed) {
        const prevMsg = await (prisma as any).inboxMessage.findFirst({
          where: { matrixRoomId: roomId, userId },
          orderBy: { receivedAt: "desc" },
          select: { senderId: true, platform: true, contactId: true, contactName: true },
        });
        if (!prevMsg?.senderId || !prevMsg?.platform) continue;
        parsed = { platform: prevMsg.platform, platformId: prevMsg.senderId };
        resolvedContactId = prevMsg.contactId;
        resolvedContactName = prevMsg.contactName;
      }

      const { platform, platformId } = parsed;

      let contactId: string | null = resolvedContactId;
      let contactName: string | null = resolvedContactName;

      if (!resolvedContactId) {
        const platformRecord = await prisma.platform.findFirst({
          where: { type: platform as PlatformType, platformId, contact: { userId } },
        });

        if (platformRecord) {
          contactId = platformRecord.contactId;
          const contact = await prisma.contact.findUnique({ where: { id: contactId } });
          if (contact) {
            contactName = contact.name;
          }
        } else {
          const resolvedName = otherParticipantName || platformId;
          const contact = await prisma.contact.create({
            data: {
              userId,
              name: resolvedName,
              platforms: {
                create: [{
                  type: platform as PlatformType,
                  platformId,
                  displayName: resolvedName,
                  profileUrl: profileUrl(platform, platformId),
                }],
              },
            },
          });
          contactId = contact.id;
          contactName = contact.name;
          importedContacts++;
        }
      }

      for (const event of timelineEvents) {
        if (event.type !== "m.room.message" && event.type !== "m.room.encrypted") continue;

        const isFromMe = event.sender === matrixId;
        const body = event.type === "m.room.encrypted"
          ? "[Encrypted message]"
          : (event.content?.body || "[No message content]");
        const receivedAt = new Date(event.origin_server_ts);

        let resolvedExternalId = event.event_id;
        if (isFromMe) {
          try {
            const { getBeeperEchoId } = await import("../import/beeper");
            const echoId = getBeeperEchoId(event.event_id);
            if (echoId) {
              const pendingMsg = await prisma.inboxMessage.findFirst({
                where: { userId, platform: platform as any, externalId: echoId },
              });
              if (pendingMsg) {
                await prisma.inboxMessage.update({
                  where: { id: pendingMsg.id },
                  data: { externalId: event.event_id },
                }).catch(() => {});
              }
            }
          } catch {}
        }

        await inboxService.upsert({
          platform,
          externalId: resolvedExternalId,
          userId,
          contactId,
          contactName,
          senderId: parsed.platformId,
          preview: body.slice(0, 120),
          body,
          receivedAt,
          fromMe: isFromMe,
        });

        await (prisma as any).inboxMessage.updateMany({
          where: { platform: platform as PlatformType, externalId: event.event_id, userId },
          data: { matrixRoomId: roomId },
        }).catch(() => {});

        synced++;
      }
    }

    if (importedContacts > 0) {
      deduplicateContacts(userId).catch(console.error);
      cache.invalidateContacts().catch(() => {});
    }

    await (prisma as any).beeperSession.update({
      where: { userId },
      data: { nextBatch, lastSyncAt: new Date() },
    });

    try {
      const { decryptEncryptedMessages, syncLocalMessagesForContacts } = await import("../import/beeper");
      const localSyncedResult = await syncLocalMessagesForContacts(userId);
      const decryptedCount = await decryptEncryptedMessages(userId);
      console.log(`[beeper-sync] Post-sync local update: synced ${localSyncedResult.synced} messages, decrypted ${decryptedCount}`);
    } catch (localErr: any) {
      console.error("[beeper-sync] Local message sync failed (non-fatal):", localErr.message);
    }

    return { synced, importedContacts };
  },

  async sendMessage(userId: string, roomId: string, text: string, platform?: string): Promise<string> {
    const session = await (prisma as any).beeperSession.findUnique({ where: { userId } });
    if (!session || !session.connected) throw new Error("Beeper not connected");

    const localToken = session.localToken || process.env.BEEPER_LOCAL_TOKEN;

    // If the text contains a media attachment, send it as a proper media message
    console.log(`[beeper-send] sendMessage roomId=${roomId} platform=${platform} textLen=${text.length} textPreview=${JSON.stringify(text.slice(0, 80))}`);
    const mediaMatch = text.match(/!\[([^\]]*)\]\((\/media\/([^)]+))\)/);
    if (mediaMatch) {
      const caption = text.replace(mediaMatch[0], "").trim();
      const relPath = mediaMatch[2]; // e.g. /media/filename.jpg
      const filename = mediaMatch[3];
      const filePath = path.join(process.cwd(), "public", relPath);
      return beeperService.sendMediaFile(userId, roomId, filePath, filename, caption, localToken, session);
    }

    if (localToken) {
      const localApi = getLocalApi(session);
      console.log(`[beeper-send] Sending via local API platform=${platform} roomId=${roomId} endpoint=${localApi}`);
      const res = await fetch(`${localApi}/v1/chats/${encodeURIComponent(roomId)}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${localToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`Local Beeper API send failed: ${res.statusText} ${errText}`);
      }
      const data = await res.json() as { pendingMessageID: string };
      return data.pendingMessageID;
    }

    const accessToken = decrypt(session.accessToken);
    const txnId = Math.random().toString(36).slice(2, 12);
    const res = await fetch(
      `${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "m.text", body: text }),
      }
    );
    if (!res.ok) throw new Error(`Matrix send failed: ${res.statusText}`);
    const data = await res.json() as { event_id: string };
    return data.event_id;
  },

  async sendMediaFile(
    userId: string, roomId: string, filePath: string,
    filename: string, caption: string,
    _localToken: string | null, session?: any,
  ): Promise<string> {
    let buffer: Buffer;
    const { ensureMediaLocal } = await import("../lib/media-store");
    await ensureMediaLocal(filePath);
    try {
      buffer = await fs.readFile(filePath);
    } catch {
      throw new Error(`Media file not found: ${filePath}`);
    }

    const ext = path.extname(filename).toLowerCase();
    const mimeMap: Record<string, string> = {
      ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
      ".gif": "image/gif", ".webp": "image/webp",
      ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
      ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
      ".pdf": "application/pdf",
    };
    const mimeType = mimeMap[ext] ?? "application/octet-stream";

    const resolvedSession = session ?? await (prisma as any).beeperSession.findUnique({ where: { userId } });
    const tok = _localToken ?? resolvedSession?.localToken ?? process.env.BEEPER_LOCAL_TOKEN;
    if (!tok) throw new Error("No local Beeper token — cannot send media");
    const localApi = getLocalApi(resolvedSession);

    // Step 1: upload the file to the Beeper Desktop API → uploadID.
    // Step 2: send the message referencing that uploadID; the local API handles
    // platform upload + E2E encryption transparently.
    console.log(`[beeper-media] Uploading ${filename} (${mimeType}, ${buffer.length} bytes) to local API`);
    const uploadRes = await fetch(`${localApi}/v1/assets/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: buffer.toString("base64"), fileName: filename, mimeType }),
    });
    if (!uploadRes.ok) {
      const errBody = await uploadRes.text().catch(() => "");
      throw new Error(`Local API asset upload failed (${uploadRes.status}): ${errBody}`);
    }
    const { uploadID } = await uploadRes.json() as { uploadID: string };
    console.log(`[beeper-media] Uploaded → uploadID=${uploadID}`);

    const sendBody: any = { attachment: { uploadID } };
    if (caption) sendBody.text = caption;

    console.log(`[beeper-media] Sending via local API roomId=${roomId} endpoint=${localApi}`);
    const sendRes = await fetch(`${localApi}/v1/chats/${encodeURIComponent(roomId)}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify(sendBody),
    });
    if (!sendRes.ok) {
      const errBody = await sendRes.text().catch(() => "");
      throw new Error(`Local API media send failed (${sendRes.status}): ${errBody}`);
    }
    const data = await sendRes.json() as any;
    console.log(`[beeper-media] Sent via local API, pendingMessageID=${data.pendingMessageID}`);
    return data.pendingMessageID ?? "sent";
  },
};
