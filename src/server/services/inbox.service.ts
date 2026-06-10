import path from "path";
import { prisma } from "../lib/prisma";
import type { PlatformType } from "@prisma/client";
import { broadcastInboxEvent } from "./sse.service";

export function parseMediaMarkdown(text: string): { filePath: string; caption: string } | null {
  // Only match image markdown `![...]()` — plain links `[...]()` are sent as text
  const match = text.match(/!\[([^\]]*)\]\((\/media\/[^)]+)\)/);
  if (!match) return null;

  const [fullTag, name, url] = match;
  const filename = url.replace("/media/", "");
  const filePath = path.join(process.cwd(), "public", "media", filename);

  let caption = text.replace(fullTag, "").trim();
  if (!caption) {
    const cleanName = name.trim();
    const isGeneric = ["image", "video", "file", "photo", "media", "attachment"].includes(cleanName.toLowerCase());
    caption = isGeneric ? "" : cleanName;
  }

  return { filePath, caption };
}

export const inboxService = {
  async getConversations(userId: string = "default") {
    const messages = await (prisma as any).inboxMessage.findMany({
      where: { userId },
      orderBy: { receivedAt: "desc" },
      take: 2000,
    });

    // Known contacts: group by contactId:platform; unknown senders: group by unknown:senderId:platform
    const map = new Map<string, {
      key: string; contactId: string | null; contactName: string | null;
      platform: string; senderId: string | null;
      latestMessage: any; unreadCount: number; archived: boolean; messageCount: number; starred: boolean;
    }>();

    for (const msg of messages) {
      let key: string;
      if (msg.contactId) {
        key = `${msg.contactId}:${msg.platform}`;
      } else if (msg.senderId) {
        key = `unknown:${msg.senderId}:${msg.platform}`;
      } else {
        continue; // no way to group without either identifier
      }
      const currentName = msg.contactName;
      if (!map.has(key)) {
        map.set(key, {
          key, contactId: msg.contactId ?? null, contactName: currentName,
          platform: msg.platform, senderId: msg.senderId,
          latestMessage: { ...msg, contactName: currentName },
          unreadCount: 0, archived: !!msg.archived, messageCount: 0, starred: false,
        });
      }
      const conv = map.get(key)!;
      conv.contactName = currentName;
      conv.messageCount++;
      if (!msg.read) conv.unreadCount++;
      if (msg.starred) conv.starred = true;
    }

    return Array.from(map.values())
      .sort((a, b) => +new Date(b.latestMessage.receivedAt) - +new Date(a.latestMessage.receivedAt));
  },

  async getThread(contactId: string, platform: string, _userId: string = "default") {
    const msgs = await (prisma as any).inboxMessage.findMany({
      where: { contactId, platform },
      orderBy: { receivedAt: "desc" },
      take: 50,
    });
    return (msgs as any[]).reverse();
  },

  async getThreadBefore(contactId: string, platform: string, before: Date, limit: number = 50) {
    const msgs = await (prisma as any).inboxMessage.findMany({
      where: { contactId, platform, receivedAt: { lt: before } },
      orderBy: { receivedAt: "desc" },
      take: limit,
    });
    return (msgs as any[]).reverse();
  },

  // All messages for a contact across every platform, newest first
  async getContactMessages(contactId: string, userId: string = "default") {
    return (prisma as any).inboxMessage.findMany({
      where: { userId, contactId },
      orderBy: { receivedAt: "asc" },
    });
  },

  async getMessages(opts?: { limit?: number }, userId: string = "default") {
    return (prisma as any).inboxMessage.findMany({
      where: { userId, contactId: { not: null } },
      orderBy: { receivedAt: "desc" },
      take: opts?.limit ?? 100,
    });
  },

  async getStats(userId: string = "default") {
    const [total, starred, unreadConvGroups] = await Promise.all([
      (prisma as any).inboxMessage.count({ where: { userId, contactId: { not: null } } }),
      (prisma as any).inboxMessage.count({ where: { userId, starred: true, contactId: { not: null } } }),
      (prisma as any).inboxMessage.groupBy({
        by: ["contactId", "platform"],
        where: { userId, read: false, contactId: { not: null } },
      }),
    ]);
    const unread = unreadConvGroups.length; // unread conversations, not messages
    return { total, unread, starred };
  },

  async updateMessage(id: string, data: { read?: boolean; starred?: boolean }, userId: string = "default") {
    return (prisma as any).inboxMessage.update({ where: { id, userId }, data });
  },

  async markConversationRead(contactId: string, platform: string, userId: string = "default") {
    const result = await (prisma as any).inboxMessage.updateMany({
      where: { userId, contactId, platform, read: false },
      data: { read: true },
    });
    if (platform === "whatsapp" && result.count > 0) {
      try {
        const p = await prisma.platform.findFirst({ where: { contactId, type: "whatsapp" } });
        if (p) {
          const jid = p.platformId.includes("@") ? p.platformId : `${p.platformId}@s.whatsapp.net`;
          const { whatsappService } = await import("./whatsapp.service");
          void whatsappService.markAsRead(jid, userId).catch(() => {});
          void whatsappService.subscribePresence(jid, userId).catch(() => {});
        }
      } catch {}
    }
    return result;
  },

  async getUnknownThread(senderId: string, platform: string, userId: string = "default") {
    return (prisma as any).inboxMessage.findMany({
      where: { userId, contactId: null, senderId, platform },
      orderBy: { receivedAt: "asc" },
    });
  },

  async markUnknownConversationRead(senderId: string, platform: string, userId: string = "default") {
    return (prisma as any).inboxMessage.updateMany({
      where: { userId, contactId: null, senderId, platform, read: false },
      data: { read: true },
    });
  },

  async deleteMessage(id: string, userId: string = "default") {
    const result = await (prisma as any).inboxMessage.deleteMany({ where: { id, userId } });
    broadcastInboxEvent("message_deleted", { id });
    return result;
  },

  async react(id: string, emoji: string, userId?: string): Promise<void> {
    const msg = await (prisma as any).inboxMessage.findUnique({ where: { id } });
    if (!msg) throw new Error("Message not found");

    if (msg.platform === "whatsapp") {
      let jid: string | null = null;
      if (msg.contactId) {
        const p = await prisma.platform.findFirst({ where: { contactId: msg.contactId, type: "whatsapp" } });
        if (p) jid = p.platformId.includes("@") ? p.platformId : `${p.platformId}@s.whatsapp.net`;
      }
      if (!jid && msg.senderId && !msg.senderId.endsWith("@lid")) jid = msg.senderId;
      if (!jid) throw new Error("Cannot resolve WhatsApp JID for this contact");
      const { whatsappService } = await import("./whatsapp.service");
      await whatsappService.sendReaction(jid, msg.externalId, !!msg.fromMe, emoji, userId ?? "default");

    } else if (msg.platform === "telegram") {
      const msgId = parseInt(msg.externalId.replace("personal-", ""), 10);
      if (isNaN(msgId)) throw new Error("Cannot parse Telegram message ID");
      let peer = msg.senderId;
      if (!peer && msg.contactId) {
        const p = await prisma.platform.findFirst({ where: { contactId: msg.contactId, type: "telegram" } });
        peer = p?.platformId ?? null;
      }
      if (!peer) throw new Error("Cannot resolve Telegram chat ID");
      const { telegramPersonalService } = await import("./telegram-personal.service");
      await telegramPersonalService.sendReaction(userId ?? "default", peer, msgId, emoji);
    }
    // LinkedIn, Slack, Discord, email — reactions not supported by their APIs
  },

  async upsert(data: {
    platform: string;
    externalId: string;
    userId?: string;
    contactId?: string | null;
    contactName?: string | null;
    senderId?: string | null;
    preview?: string | null;
    body?: string | null;
    receivedAt: Date;
  
    fromMe?: boolean;
    waStatus?: string | null;
    quotedId?: string | null;
    quotedBody?: string | null;
    quotedFromMe?: boolean | null;
  }) {
    const { platform, externalId, userId: dataUserId, waStatus, quotedId, quotedBody, quotedFromMe, ...rest } = data;
    const resolvedUserId = dataUserId ?? "default";
    // fromMe messages are always read; messages older than 24h on first sync are pre-read
    const isOld = data.receivedAt < new Date(Date.now() - 24 * 60 * 60 * 1000);
    const read = data.fromMe || isOld ? true : undefined; // undefined = let DB default handle new messages
    // Core upsert never includes WA-specific columns so it works even before the DB migration runs
    const result = await (prisma as any).inboxMessage.upsert({
      where: { platform_externalId_userId: { platform, externalId, userId: resolvedUserId } },
      create: { platform, externalId, userId: resolvedUserId, ...rest, ...(read !== undefined ? { read } : {}) },
      update: {
        contactId: rest.contactId, contactName: rest.contactName, preview: rest.preview,
        body: rest.body, receivedAt: rest.receivedAt, fromMe: rest.fromMe,
      },
    });
    // Set WA-specific fields in a separate update — silently skipped if columns don't exist yet
    const waFields: Record<string, unknown> = {};
    if (waStatus != null) waFields.waStatus = waStatus;
    if (quotedId != null) waFields.quotedId = quotedId;
    if (quotedBody != null) waFields.quotedBody = quotedBody;
    if (quotedFromMe != null) waFields.quotedFromMe = quotedFromMe;
    if (Object.keys(waFields).length > 0) {
      void (prisma as any).inboxMessage.update({ where: { id: result.id }, data: waFields }).catch(() => {});
    }

    // Fire SSE immediately after the DB save — don't wait for interaction/contact updates
    broadcastInboxEvent("new_message", { platform, contactId: rest.contactId, fromMe: rest.fromMe, message: result });

    // Update interactions and contact dates in the background — never blocks message display
    if (rest.contactId) {
      void (async () => {
        const direction = rest.fromMe ? "outbound" : "inbound";
        const existingInteraction = await prisma.interaction.findFirst({
          where: {
            contactId: rest.contactId!,
            platform: platform as any,
            direction,
            occurredAt: rest.receivedAt,
          },
        });

        if (!existingInteraction) {
          await prisma.interaction.create({
            data: {
              contactId: rest.contactId!,
              platform: platform as any,
              direction,
              contentSnippet: rest.preview || rest.body || "",
              occurredAt: rest.receivedAt,
            },
          }).catch((e: any) => {
            if (e?.code !== "P2003") throw e;
          });

          const contact = await prisma.contact.findUnique({
            where: { id: rest.contactId! },
            select: { lastContactDate: true, firstContactDate: true, contactFrequency: true },
          });
          if (contact) {
            const updates: any = {};
            if (!contact.lastContactDate || rest.receivedAt > contact.lastContactDate) {
              updates.lastContactDate = rest.receivedAt;
            }
            if (!contact.firstContactDate || rest.receivedAt < contact.firstContactDate) {
              updates.firstContactDate = rest.receivedAt;
            }
            updates.contactFrequency = (contact.contactFrequency || 0) + 1;
            await prisma.contact.update({ where: { id: rest.contactId! }, data: updates });
          }
        }
      })().catch(() => {});
    }

    return result;
  },

  async reply(id: string, text: string, userId?: string, replyToId?: string, ctx?: { contactId?: string; platform?: string; senderId?: string }): Promise<void> {
    let msg = await (prisma as any).inboxMessage.findUnique({ where: { id } });
    if (!msg && ctx?.contactId && ctx?.platform) {
      // Reference message may have been re-synced or deduped — fall back to most recent in conversation
      msg = await (prisma as any).inboxMessage.findFirst({
        where: { contactId: ctx.contactId, platform: ctx.platform },
        orderBy: { receivedAt: "desc" },
      });
    }
    if (!msg) throw new Error("Message not found");

    // ── Save to DB immediately → SSE fires → UI updates in < 100ms ─────────────
    const tempId = `sent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    // Pre-fetch quoted message so the quote bubble shows in inbox immediately
    let quotedOriginal: any = null;
    if (replyToId) {
      quotedOriginal = await (prisma as any).inboxMessage.findUnique({ where: { id: replyToId } }).catch(() => null);
    }
    await inboxService.upsert({
      platform: msg.platform,
      externalId: tempId,
      userId: msg.userId,
      contactId: msg.contactId,
      contactName: msg.contactName,
      senderId: undefined, // Will be resolved and updated in background
      preview: text.slice(0, 120),
      body: text,
      receivedAt: new Date(),
      fromMe: true,
      waStatus: msg.platform === "whatsapp" ? "sent" : null,
      quotedId: quotedOriginal?.externalId ?? null,
      quotedBody: quotedOriginal?.body ?? quotedOriginal?.preview ?? null,
      quotedFromMe: quotedOriginal != null ? !!quotedOriginal.fromMe : null,
    });

    // ── Actually resolve and send in background — never blocks the HTTP response ─────────────
    void (async () => {
      // Declared outside try so the catch block can read them for BullMQ retry
      let jid: string | null = null;
      let telegramChatId: string | null = null;
      let toEmail: string | null = null;
      let discordChannelId: string | undefined;
      let slackChannelId: string | undefined;

      try {
        // ── Resolve destination in background ─────────────────────────────────────────

        let matrixRoomId = (msg as any).matrixRoomId || null;
        if (!matrixRoomId && msg.contactId) {
          const sibling = await (prisma as any).inboxMessage.findFirst({
            where: { contactId: msg.contactId, platform: msg.platform, matrixRoomId: { not: null } },
            orderBy: { receivedAt: "desc" },
          });
          if (sibling) matrixRoomId = sibling.matrixRoomId;
        }

        if (matrixRoomId) {
          const { beeperService } = await import("./beeper.service");
          await beeperService.sendMessage(userId ?? "default", matrixRoomId, text, msg.platform);

          // Immediately fetch the message's local Beeper ID so we store it with the same
          // bl-{id} format the sync uses — this prevents duplicates on the next sync tick.
          let canonicalId: string = tempId;
          const localToken = process.env.BEEPER_LOCAL_TOKEN;
          if (localToken) {
            try {
              const msgsRes = await fetch(
                `http://localhost:23373/v1/chats/${encodeURIComponent(matrixRoomId)}/messages?limit=1`,
                { headers: { Authorization: `Bearer ${localToken}` } },
              );
              if (msgsRes.ok) {
                const msgsData = await msgsRes.json() as any;
                const latest = msgsData.items?.[0];
                if (latest?.id && latest?.isSender) canonicalId = `bl-${latest.id}`;
              }
            } catch {}
          }

          try {
            await (prisma as any).inboxMessage.updateMany({
              where: { platform: msg.platform, externalId: tempId },
              data: { matrixRoomId, externalId: canonicalId },
            });
          } catch {
            // Sync already created the canonical bl- entry — delete the temp optimistic row
            await (prisma as any).inboxMessage.deleteMany({
              where: { platform: msg.platform, externalId: tempId, userId: userId ?? "default" },
            }).catch(() => {});
          }
        } else if (msg.platform === "whatsapp") {
          // Prefer phone-based JID from the platform record — avoids @lid format which
          // Baileys may not be able to resolve without a full contact sync
          if (msg.contactId) {
            const p = await prisma.platform.findFirst({ where: { contactId: msg.contactId, type: "whatsapp" } });
            if (p) jid = p.platformId.includes("@") ? p.platformId : `${p.platformId}@s.whatsapp.net`;
          }
          // Fall back to senderId (may be @s.whatsapp.net or @lid — Baileys handles @s.whatsapp.net reliably)
          if (!jid && msg.senderId && !msg.senderId.endsWith("@lid")) jid = msg.senderId;
          // If senderId is @lid, strip to phone digits and build proper JID
          if (!jid && msg.senderId?.endsWith("@lid")) {
            const { resolveJid } = await import("./whatsapp.service");
            jid = resolveJid(msg.senderId) ?? msg.senderId;
          }
          if (jid) {
            const { resolveJid } = await import("./whatsapp.service");
            jid = resolveJid(jid) ?? jid;
          }

          // Last resort: if jid is still @lid (unresolvable), scan incoming messages from this
          // contact to find a proper @s.whatsapp.net JID that Baileys can actually send to
          if (jid?.endsWith("@lid") && msg.contactId) {
            const incoming = await (prisma as any).inboxMessage.findFirst({
              where: { contactId: msg.contactId, platform: "whatsapp", fromMe: false, senderId: { contains: "@s.whatsapp.net" } },
              orderBy: { receivedAt: "desc" },
            });
            if (incoming?.senderId) {
              jid = incoming.senderId;
              console.log(`[inbox] Resolved @lid via incoming message senderId → ${jid}`);
            }
          }
        } else if (msg.platform === "telegram") {
          telegramChatId = msg.senderId ?? null;
          // Fall back: scan thread for a message from the same contact that has a senderId
          if (!telegramChatId && msg.contactId) {
            const sibling = await (prisma as any).inboxMessage.findFirst({
              where: { contactId: msg.contactId, platform: "telegram", senderId: { not: null } },
              orderBy: { receivedAt: "desc" },
            });
            if (sibling?.senderId) telegramChatId = sibling.senderId;
          }
          // Fall back: Platform record (stores the username/ID the user typed)
          if (!telegramChatId && msg.contactId) {
            const p = await prisma.platform.findFirst({ where: { contactId: msg.contactId, type: "telegram" } });
            if (p) telegramChatId = p.platformId;
          }
          if (!telegramChatId) throw new Error("No chat ID found for this Telegram contact — make sure the contact has a Telegram platform entry.");
        } else if (msg.platform === "email") {
          // Prefer the email stored in the contact's platform entry
          if (msg.contactId) {
            const p = await prisma.platform.findFirst({ where: { contactId: msg.contactId, type: "email" } });
            if (p) toEmail = p.platformId;
          }
          // Fall back to senderId (stored as the contact's email on sync)
          if (!toEmail && msg.senderId) toEmail = msg.senderId;
          // Fall back to contactName (syncThreads stores contactEmail there)
          if (!toEmail && msg.contactName?.includes("@")) toEmail = msg.contactName;
          if (!toEmail) throw new Error("No email address found for this contact");
        } else if (msg.platform === "slack") {
          const channelId = msg.senderId;
          if (!channelId) throw new Error("No Slack channel ID found — try syncing Slack in Settings");
          const { slackService } = await import("./slack.service");
          await slackService.sendMessage(userId!, channelId, text);
          slackChannelId = channelId;
        } else if (msg.platform === "discord") {
          const channelId = msg.senderId;
          if (!channelId) throw new Error("No Discord channel ID found — try syncing Discord in Settings");
          const { discordService } = await import("./discord.service");
          await discordService.sendMessage(userId!, channelId, text);
          discordChannelId = channelId;
        } else {
          throw new Error(`Sending via ${msg.platform} is not yet supported`);
        }

        // Update the message in DB to have the correct resolved destination
        const resolvedSenderId = jid ?? telegramChatId ?? toEmail ?? slackChannelId ?? discordChannelId ?? undefined;
        if (resolvedSenderId) {
          await (prisma as any).inboxMessage.updateMany({
            where: { platform: msg.platform, externalId: tempId },
            data: { senderId: resolvedSenderId },
          });
        }

        if (msg.platform === "whatsapp" && jid) {
          const { whatsappService } = await import("./whatsapp.service");
          const media = parseMediaMarkdown(text);
          // Build quoted message object for WA reply threading
          let quotedMsg: any;
          if (replyToId) {
            const orig = await (prisma as any).inboxMessage.findUnique({ where: { id: replyToId } });
            if (orig?.externalId) {
              quotedMsg = {
                key: { id: orig.externalId, fromMe: !!orig.fromMe, remoteJid: jid },
                message: { conversation: orig.body || orig.preview || "" },
              };
            }
          }
          let sentMsg: unknown;
          if (media) {
            try {
              sentMsg = await whatsappService.sendMediaMessage(jid, media.filePath, media.caption, userId ?? "default");
            } catch (mediaErr: any) {
              // If media send fails for a non-reconnect reason (bad format, file missing, etc.),
              // send just the caption as text so WhatsApp doesn't receive raw markdown
              const isReconnect = mediaErr?.message?.includes("reconnecting") || mediaErr?.message?.includes("not connected");
              if (isReconnect) throw mediaErr; // rethrow so outer catch can queue BullMQ retry
              const fallbackText = media.caption || "";
              if (fallbackText) {
                sentMsg = await whatsappService.sendMessage(jid, fallbackText, userId ?? "default", quotedMsg);
              }
            }
          } else {
            sentMsg = await whatsappService.sendMessage(jid, text, userId ?? "default", quotedMsg);
          }
          // Update temp ID to real Baileys message ID so we don't get a duplicate from the echo
          const realId = (sentMsg as any)?.key?.id;
          if (realId) {
            await (prisma as any).inboxMessage.updateMany({
              where: { platform: "whatsapp", externalId: tempId },
              data: { externalId: realId },
            });
          }
        } else if (msg.platform === "telegram" && telegramChatId) {
          // Resolve Telegram reply-to message ID
          let replyToTelegramId: number | undefined;
          if (replyToId) {
            const replyToMsg = await (prisma as any).inboxMessage.findUnique({ where: { id: replyToId } });
            if (replyToMsg?.externalId?.startsWith("personal-")) {
              const parsed = parseInt(replyToMsg.externalId.replace("personal-", ""), 10);
              if (!isNaN(parsed)) replyToTelegramId = parsed;
            }
          }

          // Determine if we should send via Telegram Personal or Bot
          const resolvedUserId = userId ?? "default";
          let isPersonal = false;
          if (msg.externalId?.startsWith("personal-")) {
            isPersonal = true;
          } else if (msg.externalId?.startsWith("bot-")) {
            isPersonal = false;
          } else {
            if (msg.contactId) {
              const personalMsg = await (prisma as any).inboxMessage.findFirst({
                where: {
                  contactId: msg.contactId,
                  platform: "telegram",
                  externalId: { startsWith: "personal-" }
                }
              });
              if (personalMsg) {
                isPersonal = true;
              } else {
                const { telegramPersonalService } = await import("./telegram-personal.service");
                const personalSession = await (prisma as any).telegramPersonalSession.findUnique({
                  where: { userId: resolvedUserId }
                });
                if (personalSession?.connected) {
                  isPersonal = true;
                }
              }
            }
          }

          if (isPersonal) {
            const { telegramPersonalService } = await import("./telegram-personal.service");
            const sentMsg = await telegramPersonalService.sendOnly(resolvedUserId, telegramChatId, text, replyToTelegramId);
            const realId = sentMsg?.id;
            if (realId) {
              await (prisma as any).inboxMessage.updateMany({
                where: { platform: "telegram", externalId: tempId },
                data: { externalId: `personal-${realId}` },
              });
            }
          } else {
            const { sendBotReply } = await import("./telegram-bot.service");
            await sendBotReply(telegramChatId, text);
          }
        } else if (msg.platform === "email" && toEmail) {
          const originalSubject = msg.preview ?? "";
          const subject = originalSubject.match(/^re:/i) ? originalSubject : `Re: ${originalSubject}`;
          const { sendEmailViaGmailApi } = await import("./gmail.service");

          // Extract the real Gmail thread ID.
          // New format: externalId = "${threadId}:${messageId}" → take the part before ":"
          // Old format: externalId = "${threadId}" (legacy single-record-per-thread)
          // Temp format: externalId starts with "sent-" → look up from other messages
          const parseThreadId = (externalId: string | null): string | undefined => {
            if (!externalId || externalId.startsWith("sent-")) return undefined;
            return externalId.includes(":") ? externalId.split(":")[0] : externalId;
          };
          let gmailThreadId: string | undefined = parseThreadId(msg.externalId);
          if (!gmailThreadId && msg.contactId) {
            const original = await (prisma as any).inboxMessage.findFirst({
              where: {
                contactId: msg.contactId,
                platform: "email",
                NOT: { externalId: { startsWith: "sent-" } },
              },
              orderBy: { receivedAt: "asc" },
            });
            gmailThreadId = parseThreadId(original?.externalId ?? null);
          }

          await sendEmailViaGmailApi(userId ?? "default", {
            to: toEmail,
            subject,
            text,
            threadId: gmailThreadId,
          });
        }
      } catch (err: any) {
        // If WA is reconnecting (not permanently disconnected) and JID is resolved,
        // queue a BullMQ retry job instead of immediately marking failed.
        const isReconnecting = err?.message?.includes("reconnecting") || err?.message?.includes("not connected — retrying");
        if (msg.platform === "whatsapp" && jid && isReconnecting) {
          try {
            const { queues } = await import("../lib/queues");
            await queues.whatsappSend.add(
              "send",
              { userId: userId ?? "default", jid, text, tempId, contactId: msg.contactId },
              { attempts: 10, backoff: { type: "exponential", delay: 20_000 }, removeOnComplete: 100, removeOnFail: 50 }
            );
            console.log(`[inbox] WA reconnecting — queued send retry for ${jid} (tempId=${tempId})`);
            return;
          } catch (qErr) {
            console.error("[inbox] Failed to queue WA send retry:", qErr);
          }
        }
        const errMsg = err?.message ?? "Unknown error";
        console.error(`[inbox] Background send failed (${msg.platform}):`, err);
        broadcastInboxEvent("send_failed", { platform: msg.platform, tempId, contactId: msg.contactId, error: errMsg });
      }
    })();
  },

  async archiveConversation(opts: { contactId?: string | null; senderId?: string | null; platform: string; userId?: string }) {
    const { contactId, senderId, platform, userId = "default" } = opts;
    if (contactId) {
      await (prisma as any).inboxMessage.updateMany({ where: { userId, contactId, platform }, data: { archived: true } });
    } else if (senderId) {
      await (prisma as any).inboxMessage.updateMany({ where: { userId, contactId: null, senderId, platform }, data: { archived: true } });
    }
  },

  async unarchiveConversation(opts: { contactId?: string | null; senderId?: string | null; platform: string; userId?: string }) {
    const { contactId, senderId, platform, userId = "default" } = opts;
    if (contactId) {
      await (prisma as any).inboxMessage.updateMany({ where: { userId, contactId, platform }, data: { archived: false } });
    } else if (senderId) {
      await (prisma as any).inboxMessage.updateMany({ where: { userId, contactId: null, senderId, platform }, data: { archived: false } });
    }
  },

  async linkMessagesToContact(contactId: string, platformType: string, platformId: string) {
    // Some platforms use senderId, some use externalId that contain the platformId
    // We update where contactId is null to avoid re-linking already linked messages (unless they were linked to wrong contact, but that's a merge case).

    // For WhatsApp, senderId is usually <phone>@s.whatsapp.net.
    // For Telegram, senderId is usually the ID.
    // For X, senderId is the numeric ID.
    const matchingMessages = await (prisma as any).inboxMessage.findMany({
      where: {
        platform: platformType,
        contactId: null,
        OR: [
          { senderId: { contains: platformId } },
          { externalId: { contains: platformId } },
        ],
      },
    });

    if (matchingMessages.length > 0) {
      // Also fetch the contact's real name so we can update contactName on linked messages.
      // Messages saved before the contact existed store the phone number as contactName.
      const contact = await prisma.contact.findUnique({ where: { id: contactId }, select: { name: true } });
      await (prisma as any).inboxMessage.updateMany({
        where: {
          id: { in: matchingMessages.map((m: any) => m.id) },
        },
        data: { contactId, ...(contact ? { contactName: contact.name } : {}) },
      });

      await prisma.interaction.createMany({
        data: matchingMessages.map((msg: any) => ({
          contactId,
          platform: platformType as any,
          direction: msg.fromMe ? "outbound" : "inbound",
          contentSnippet: msg.preview || msg.body || "",
          occurredAt: msg.receivedAt,
        })),
        skipDuplicates: true,
      });

      const contactInteractions = await prisma.interaction.findMany({
        where: { contactId },
        orderBy: { occurredAt: "asc" },
      });

      if (contactInteractions.length > 0) {
        const firstContactDate = contactInteractions[0].occurredAt;
        const lastContactDate = contactInteractions[contactInteractions.length - 1].occurredAt;
        const contactFrequency = contactInteractions.length;

        await prisma.contact.update({
          where: { id: contactId },
          data: {
            firstContactDate,
            lastContactDate,
            contactFrequency,
          },
        });
      }
    }
  },
};
