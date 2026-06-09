import { prisma } from "../lib/prisma";
import { inboxService } from "./inbox.service";
import { encrypt, decrypt } from "../lib/encryption";

function decryptSession(rec: any) {
  if (!rec) return rec;
  return {
    ...rec,
    sessionStr: rec.sessionStr ? decrypt(rec.sessionStr) : rec.sessionStr,
    apiHash: rec.apiHash ? decrypt(rec.apiHash) : rec.apiHash,
  };
}

// In-memory client registry (one per user session)
const clients: Map<string, unknown> = new Map();

// Entity cache: userId → (numericTelegramId → GramJS entity)
// Populated on dialog load so sends to numeric IDs don't reload all dialogs every time
const entityCache: Map<string, Map<string, any>> = new Map();

// Tracks in-progress cache warm so concurrent calls don't stack up
const warmingCache = new Map<string, Promise<void>>();

async function warmEntityCache(userId: string, client: any) {
  // Deduplicate concurrent warm calls for the same user
  const existing = warmingCache.get(userId);
  if (existing) return existing;

  const promise = (async () => {
    try {
      // Fetch enough dialogs to cover all CRM contacts
      const dialogs = await client.getDialogs({ limit: 500 });
      const cache = entityCache.get(userId) ?? new Map<string, any>();
      for (const d of dialogs) {
        if (d.entity?.id) cache.set(d.entity.id.toString(), d.entity);
      }
      entityCache.set(userId, cache);
      console.log(`[telegram-personal] Entity cache warmed: ${cache.size} entities`);
    } catch (err) {
      console.error("[telegram-personal] Failed to warm entity cache:", err);
    } finally {
      warmingCache.delete(userId);
    }
  })();

  warmingCache.set(userId, promise);
  return promise;
}

// Resolve a numeric peer ID to a GramJS entity (needs access hash to actually send).
// Order: local cache → warm cache → getEntity (network, always works for known contacts).
async function resolveNumericPeer(userId: string, peer: string, client: any): Promise<any> {
  // 1. Check local entity cache
  let cached = entityCache.get(userId)?.get(peer);
  if (cached) return cached;

  // 2. Warm cache (waits if already in progress)
  await warmEntityCache(userId, client);
  cached = entityCache.get(userId)?.get(peer);
  if (cached) return cached;

  // 3. Network fetch via getEntity — works for any user the account has ever interacted with
  try {
    const entity = await client.getEntity(peer);
    const cache = entityCache.get(userId) ?? new Map<string, any>();
    cache.set(peer, entity);
    entityCache.set(userId, cache);
    return entity;
  } catch (err) {
    console.error(`[telegram-personal] Could not resolve entity for peer ${peer}:`, err);
    throw new Error(`Cannot find Telegram entity for peer ${peer} — try syncing Telegram in Settings.`);
  }
}
const pendingCodes: Map<string, { phoneCodeHash: string; phoneNumber: string }> = new Map();
const tgStates: Map<string, {
  qr: string | null;
  connected: boolean;
  phone: string | null;
  client: any;
  error: string | null;
  passwordRequired: boolean;
  passwordResolver?: (password: string) => void;
}> = new Map();

const ENV_API_ID = process.env.TELEGRAM_API_ID ? parseInt(process.env.TELEGRAM_API_ID, 10) : null;
const ENV_API_HASH = process.env.TELEGRAM_API_HASH || null;

async function getTelegramLib() {
  const { TelegramClient } = await import("telegram");
  const { StringSession } = await import("telegram/sessions");
  const { NewMessage } = await import("telegram/events");
  return { TelegramClient, StringSession, NewMessage };
}

function isSessionExpired(err: unknown): boolean {
  const msg = String(err);
  return msg.includes("AUTH_KEY_UNREGISTERED") || msg.includes("AUTH_KEY_DUPLICATED") || msg.includes("SESSION_REVOKED") || msg.includes("SESSION_EXPIRED") || msg.includes("USER_DEACTIVATED");
}

async function clearSession(userId: string) {
  const client = clients.get(userId) as any;
  if (client) { try { await client.disconnect(); } catch { /* ignore */ } clients.delete(userId); }
  await (prisma as any).telegramPersonalSession.deleteMany({ where: { userId } });
  console.log(`[telegram-personal] Cleared expired session for user ${userId}`);
}

async function findContactForTelegram(entity: any, userId: string) {
  if (!entity) return null;
  const username = entity.username;
  const phone = entity.phone;
  const idStr = entity.id?.toString();

  const platforms = await prisma.platform.findMany({
    where: {
      contact: { userId },
      OR: [
        { type: "telegram" },
        { type: "whatsapp" }
      ]
    },
    include: { contact: true },
  });

  const platform = platforms.find(p => {
    if (idStr && p.platformId === idStr) return true;
    if (username) {
      const bare = username.replace(/^@+/, "").toLowerCase();
      const pBare = p.platformId.replace(/^@+/, "").toLowerCase();
      if (bare === pBare) return true;
    }
    if (phone) {
      if (phone.includes(p.platformId) || p.platformId.includes(phone)) return true;
    }
    return false;
  });

  return platform?.contact || null;
}

async function downloadTelegramMedia(client: any, msg: any): Promise<string | null> {
  if (!msg?.media) return null;
  try {
    // Pass the full message object — more reliable than passing media directly
    const buffer = await client.downloadMedia(msg, { workers: 1 });
    if (!buffer) return null;

    const fs = await import("fs/promises");
    const path = await import("path");
    const dir = path.join(process.cwd(), "public", "media");
    await fs.mkdir(dir, { recursive: true });

    const media = msg.media;
    let ext = "jpg";
    if (media?.document?.mimeType) {
      const parts = media.document.mimeType.split("/");
      if (parts[1]) ext = parts[1].replace("jpeg", "jpg");
    } else if (media?.photo) {
      ext = "jpg";
    }

    const filename = `tg_${msg.id ?? Date.now()}.${ext}`;
    await fs.writeFile(path.join(dir, filename), buffer);
    return `/media/${filename}`;
  } catch (err) {
    console.error(`[telegram-personal] Failed to download media for msg ${msg.id}:`, err);
    return null;
  }
}

// Link existing CRM contacts to Telegram entities by name/phone (no new contacts created)
async function linkContactsByName(dialogs: any[]): Promise<void> {
  for (const dialog of dialogs) {
    try {
      const entity = dialog.entity as any;
      if (!entity || entity.className !== "User" || entity.bot || entity.self) continue;
      const idStr = entity.id?.toString();
      if (!idStr) continue;

      // Skip if platform record already exists
      const existing = await prisma.platform.findFirst({ where: { type: "telegram", platformId: idStr } });
      if (existing) continue;

      const firstName = entity.firstName ?? "";
      const lastName = entity.lastName ?? "";
      const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
      const username = entity.username ?? null;
      const phone = entity.phone ?? null;

      // Try matching existing CRM contact by name
      let contact = fullName
        ? await prisma.contact.findFirst({ where: { name: { equals: fullName, mode: "insensitive" } } })
        : null;

      // Fallback: match by phone against all platform records
      if (!contact && phone) {
        const digits = phone.replace(/\D/g, "").slice(-10);
        const plat = await prisma.platform.findFirst({ where: { platformId: { endsWith: digits } } });
        if (plat) contact = await prisma.contact.findUnique({ where: { id: plat.contactId } });
      }

      if (!contact) continue;

      // Create Telegram platform record on the existing contact
      await prisma.platform.create({
        data: {
          contactId: contact.id,
          type: "telegram",
          platformId: username ?? idStr,
          displayName: fullName || username || idStr,
        },
      }).catch(() => {}); // ignore unique constraint if race condition
    } catch {}
  }
}

export const telegramPersonalService = {
  async getQrStatus(userId: string) {
    const state = tgStates.get(userId);
    if (!state) return { active: false, connected: false, qr: null, passwordRequired: false, error: null };
    return {
      active: true,
      connected: state.connected,
      qr: state.qr,
      passwordRequired: state.passwordRequired,
      phone: state.phone,
      error: state.error,
    };
  },

  async submitPassword(userId: string, password: string) {
    const state = tgStates.get(userId);
    if (!state || !state.passwordResolver) throw new Error("No pending 2FA password input found for this session.");
    state.passwordResolver(password);
    state.passwordRequired = false;
    delete state.passwordResolver;
    return { success: true };
  },

  async startQrFlow(userId: string, apiId?: number, apiHash?: string): Promise<{ active: boolean }> {
    const resolvedApiId = apiId ?? ENV_API_ID;
    const resolvedApiHash = apiHash ?? ENV_API_HASH;
    if (!resolvedApiId || !resolvedApiHash) {
      throw new Error("Telegram API credentials not configured. Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env.local or provide apiId and apiHash.");
    }

    const { TelegramClient, StringSession } = await getTelegramLib();

    // Check existing session
    const existing = decryptSession(await (prisma as any).telegramPersonalSession.findUnique({ where: { userId } }));
    const sessionStr = existing?.sessionStr ?? "";

    const client = new TelegramClient(new StringSession(sessionStr), resolvedApiId, resolvedApiHash, {
      connectionRetries: 3,
    });
    await client.connect();
    clients.set(userId, client);

    const userState = {
      qr: null as string | null,
      connected: false,
      phone: null as string | null,
      client,
      error: null as string | null,
      passwordRequired: false,
      passwordResolver: undefined as ((password: string) => void) | undefined,
    };
    tgStates.set(userId, userState);

    // Run the QR flow in background
    (async () => {
      try {
        const user = await client.signInUserWithQrCode(
          { apiId: resolvedApiId, apiHash: resolvedApiHash },
          {
            qrCode: async (params: any) => {
              const { token } = params;
              const qrUrl = `tg://login?token=${token.toString("base64url")}`;
              const QRCode = await import("qrcode");
              userState.qr = await QRCode.toDataURL(qrUrl);
            },
            onError: async (err: any) => {
              console.error("Telegram QR sign-in error:", err);
              userState.error = err.message || String(err);
              return true; // Stop
            },
            password: async () => {
              userState.passwordRequired = true;
              return new Promise<string>((resolve) => {
                userState.passwordResolver = resolve;
              });
            },
          } as any
        );

        userState.connected = true;
        userState.qr = null;
        const me = await client.getMe();
        userState.phone = me.phone ?? null;

        const savedSession = (client.session as InstanceType<typeof StringSession>).save() as unknown as string;
        await (prisma as any).telegramPersonalSession.upsert({
          where: { userId },
          create: { userId, phoneNumber: me.phone ?? "", apiId: resolvedApiId, apiHash: encrypt(resolvedApiHash), sessionStr: encrypt(savedSession), connected: true },
          update: { phoneNumber: me.phone ?? "", apiId: resolvedApiId, apiHash: encrypt(resolvedApiHash), sessionStr: encrypt(savedSession), connected: true },
        });

        // Register message listener, warm entity cache, and sync history
        telegramPersonalService._attachListener(userId, client);
        warmEntityCache(userId, client);
        telegramPersonalService.sync(userId, { deep: true }).catch(console.error);
      } catch (err: any) {
        console.error("QR Code auth loop finished with error:", err);
        userState.error = err.message || String(err);
      }
    })();

    return { active: true };
  },

  async getStatus(userId: string) {
    const rec = decryptSession(await (prisma as any).telegramPersonalSession.findUnique({ where: { userId } }));
    const hasEnvCreds = !!(ENV_API_ID && ENV_API_HASH);
    if (!rec) return { connected: false, lastSync: null, hasEnvCreds };
    return { connected: rec.connected, lastSync: rec.lastSyncAt?.toISOString() ?? null, phone: rec.phoneNumber, hasEnvCreds };
  },

  async sendCode(userId: string, phoneNumber: string, apiId?: number, apiHash?: string): Promise<{ sent: boolean }> {
    const resolvedApiId = apiId ?? ENV_API_ID;
    const resolvedApiHash = apiHash ?? ENV_API_HASH;
    if (!resolvedApiId || !resolvedApiHash) throw new Error("Telegram API credentials not configured. Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env.local or provide apiId and apiHash.");

    const { TelegramClient, StringSession } = await getTelegramLib();

    const existing = decryptSession(await (prisma as any).telegramPersonalSession.findUnique({ where: { userId } }));
    const sessionStr = existing?.sessionStr ?? "";

    const client = new TelegramClient(new StringSession(sessionStr), resolvedApiId, resolvedApiHash, {
      connectionRetries: 3,
    });
    await client.connect();
    clients.set(userId, client);

    const result = await client.sendCode({ apiId: resolvedApiId, apiHash: resolvedApiHash }, phoneNumber) as { phoneCodeHash: string };
    pendingCodes.set(userId, { phoneCodeHash: result.phoneCodeHash, phoneNumber });

    await (prisma as any).telegramPersonalSession.upsert({
      where: { userId },
      create: { userId, phoneNumber, apiId: resolvedApiId, apiHash: encrypt(resolvedApiHash), connected: false },
      update: { phoneNumber, apiId: resolvedApiId, apiHash: encrypt(resolvedApiHash) },
    });

    return { sent: true };
  },

  async verify(userId: string, code: string, password?: string): Promise<{ connected: boolean }> {
    const { TelegramClient, StringSession } = await getTelegramLib();

    const pending = pendingCodes.get(userId);
    if (!pending) throw new Error("No pending code — call sendCode first");

    const rec = decryptSession(await (prisma as any).telegramPersonalSession.findUnique({ where: { userId } }));
    if (!rec) throw new Error("Session not found");

    let client = clients.get(userId) as InstanceType<typeof TelegramClient> | undefined;
    if (!client) {
      client = new TelegramClient(new StringSession(rec.sessionStr ?? ""), rec.apiId, rec.apiHash, { connectionRetries: 3 });
      await client.connect();
      clients.set(userId, client);
    }

    await client.signInUser(
      { apiId: rec.apiId, apiHash: rec.apiHash },
      {
        phoneNumber: pending.phoneNumber,
        phoneCodeHash: pending.phoneCodeHash,
        phoneCode: () => Promise.resolve(code),
        password: password ? () => Promise.resolve(password) : undefined,
        onError: (err: Error) => { throw err; },
      } as any,
    );

    const sessionStr = (client.session as InstanceType<typeof StringSession>).save() as unknown as string;
    pendingCodes.delete(userId);

    await (prisma as any).telegramPersonalSession.update({
      where: { userId },
      data: { sessionStr: encrypt(sessionStr), connected: true },
    });

    // Register live message listener, warm entity cache, and sync history
    telegramPersonalService._attachListener(userId, client);
    warmEntityCache(userId, client);
    telegramPersonalService.sync(userId, { deep: true }).catch(console.error);

    return { connected: true };
  },

  async importContacts(userId: string): Promise<{ imported: number; updated: number; skipped: number }> {
    const { TelegramClient, StringSession } = await getTelegramLib();
    const rec = decryptSession(await (prisma as any).telegramPersonalSession.findUnique({ where: { userId } }));
    if (!rec?.sessionStr) throw new Error("Telegram personal not authenticated");

    let client = clients.get(userId) as InstanceType<typeof TelegramClient> | undefined;
    if (!client) {
      client = new TelegramClient(new StringSession(rec.sessionStr), rec.apiId, rec.apiHash, { connectionRetries: 3 });
      await client.connect();
      clients.set(userId, client);
      telegramPersonalService._attachListener(userId, client);
    }

    const dialogs = await client.getDialogs({ limit: 200 });

    // Populate entity cache while we have the dialogs loaded
    const cache = entityCache.get(userId) ?? new Map<string, any>();
    for (const d of dialogs) { if (d.entity?.id) cache.set(d.entity.id.toString(), d.entity); }
    entityCache.set(userId, cache);

    let imported = 0, updated = 0, skipped = 0;

    for (const dialog of dialogs) {
      try {
        const entity = dialog.entity as any;

        // Only process private user chats — skip groups, channels, bots
        if (!entity || entity.className !== "User") { skipped++; continue; }
        if (entity.bot) { skipped++; continue; }
        if (entity.self) { skipped++; continue; } // "Saved Messages"

        const firstName = entity.firstName ?? "";
        const lastName = entity.lastName ?? "";
        const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
        if (!fullName) { skipped++; continue; }

        const username = entity.username ?? null;
        const phone = entity.phone ?? null;
        const telegramId = entity.id?.toString() ?? null;
        if (!telegramId) { skipped++; continue; }

        const lastMessageDate = dialog.date ? new Date(dialog.date * 1000) : null;

        // Check if already in CRM
        const existing = await findContactForTelegram(entity, userId);
        if (existing) {
          // Update lastContactDate if dialog has a newer message
          if (lastMessageDate && (!existing.lastContactDate || lastMessageDate > existing.lastContactDate)) {
            await prisma.contact.update({
              where: { id: existing.id },
              data: { lastContactDate: lastMessageDate },
            });
          }
          updated++;
          continue;
        }

        // Create new contact + platform record
        const platformIdToUse = username ?? telegramId;
        await prisma.contact.create({
          data: {
            name: fullName,
            lastContactDate: lastMessageDate,
            firstContactDate: lastMessageDate,
            type: "other",
            domain: "other",
            relationshipStrength: "cold",
            platforms: {
              create: [{
                type: "telegram" as const,
                platformId: platformIdToUse,
                displayName: fullName,
                profileUrl: username ? `https://t.me/${username}` : null,
              }],
            },
          },
        });

        // Also create a whatsapp platform if phone is known
        if (phone) {
          const created = await prisma.contact.findFirst({
            where: { platforms: { some: { type: "telegram", platformId: platformIdToUse } } },
          });
          if (created) {
            const exists = await prisma.platform.findFirst({ where: { type: "whatsapp", platformId: phone } });
            if (!exists) {
              await prisma.platform.create({
                data: { contactId: created.id, type: "whatsapp", platformId: phone, displayName: fullName },
              });
            }
          }
        }

        imported++;
      } catch (err: any) {
        console.error("[telegram-import] skipped dialog:", err.message);
        skipped++;
      }
    }

    console.log(`[telegram-import] done — imported=${imported} updated=${updated} skipped=${skipped}`);
    return { imported, updated, skipped };
  },

  async sync(userId: string, opts?: { deep?: boolean }): Promise<{ synced: number }> {
    const { TelegramClient, StringSession } = await getTelegramLib();
    const rec = decryptSession(await (prisma as any).telegramPersonalSession.findUnique({ where: { userId } }));
    if (!rec?.sessionStr) throw new Error("Not authenticated");

    let client = clients.get(userId) as InstanceType<typeof TelegramClient> | undefined;
    if (!client) {
      client = new TelegramClient(new StringSession(rec.sessionStr), rec.apiId, rec.apiHash, { connectionRetries: 3 });
      await client.connect();
      clients.set(userId, client);
      telegramPersonalService._attachListener(userId, client);
    }

    // deep=true on first-time historical import: more dialogs, more messages per chat
    const dialogLimit = opts?.deep ? 200 : 100;
    const msgLimit    = opts?.deep ? 200 : 50;

    const dialogs = await client.getDialogs({ limit: dialogLimit });

    // Link any existing CRM contacts to Telegram entities by name/phone before syncing
    await linkContactsByName(dialogs);

    let synced = 0;

    for (const dialog of dialogs) {
      try {
        const entity = dialog.entity as any;
        if (!entity || entity.className !== "User" || entity.bot || entity.self) continue;

        const contact = await findContactForTelegram(entity, userId);
        const entityName = [entity.firstName, entity.lastName].filter(Boolean).join(" ")
          || entity.username
          || String(entity.id);
        const senderName = contact?.name ?? entityName;

        const messages = await client.getMessages(entity, { limit: msgLimit });

        for (const msg of messages) {
          if (!msg.text && !msg.media) continue;

          let body = msg.text || "";
          if (msg.media) {
            const mediaUrl = await downloadTelegramMedia(client, msg);
            if (mediaUrl) {
              const isImage = /\.(jpg|png|jpeg|gif|webp)$/i.test(mediaUrl);
              body = isImage
                ? `${body}\n\n![Image](${mediaUrl})`.trim()
                : `${body}\n\n[File](${mediaUrl})`.trim();
            } else if (!body) {
              body = "[Media message]";
            }
          }
          if (!body) continue;

          await inboxService.upsert({
            platform: "telegram",
            externalId: `personal-${msg.id}`,
            userId,
            contactId: contact?.id ?? null,
            contactName: senderName,
            senderId: contact ? undefined : entity.id.toString(),
            preview: body.slice(0, 120),
            body,
            receivedAt: new Date(msg.date * 1000),
            needsReply: !msg.out,
            fromMe: !!msg.out,
          });
          synced++;
        }

        // Retroactively link any messages saved before this contact was resolved
        if (contact) {
          const telegramId = entity.id?.toString();
          if (telegramId) {
            await inboxService.linkMessagesToContact(contact.id, "telegram", telegramId).catch(() => {});
          }
        }
      } catch (err) {
        console.error("[telegram-sync] dialog skipped:", (err as any)?.message ?? err);
      }
    }

    await (prisma as any).telegramPersonalSession.update({
      where: { userId },
      data: { lastSyncAt: new Date() },
    });
    console.log(`[telegram-sync] done — synced=${synced} deep=${!!opts?.deep}`);
    return { synced };
  },

  _attachListener(userId: string, client: unknown) {
    const typedClient = client as any;
    // Warm entity cache in background so first sends don't cold-start
    warmEntityCache(userId, typedClient).catch(() => {});
    try {
      import("telegram/events").then(({ NewMessage, Raw }) => {
        // ── Incoming / outgoing messages ──────────────────────────────────────────
        typedClient.addEventHandler(async (event: any) => {
          try {
            const msg = event.message;
            if (!msg?.text && !msg?.media) return;

            const chat = await msg.getChat();
            // Skip bots, self (Saved Messages), and non-user entities (groups, channels)
            if (!chat || chat.bot || chat.self || chat.className !== "User") return;

            let contact = await findContactForTelegram(chat, userId);
            let chatEntity = chat;

            if (!contact) {
              const sender = await msg.getSender();
              // Skip if sender is also a bot or the current account
              if (!sender || sender.bot || sender.self) return;
              contact = await findContactForTelegram(sender, userId);
              if (contact) {
                chatEntity = sender;
              }
            }

            if (!contact || !chatEntity) return;

            let body = msg.text || "";
            if (msg.media) {
              const mediaUrl = await downloadTelegramMedia(typedClient, msg);
              if (mediaUrl) {
                const isImage = mediaUrl.endsWith(".jpg") || mediaUrl.endsWith(".png") || mediaUrl.endsWith(".jpeg") || mediaUrl.endsWith(".gif") || mediaUrl.endsWith(".webp");
                if (isImage) {
                  body = `${body}\n\n![Image](${mediaUrl})`.trim();
                } else {
                  body = `${body}\n\n[File](${mediaUrl})`.trim();
                }
              } else if (!body) {
                body = "[Media message]";
              }
            }
            if (!body) body = "[Unknown message type]";

            const telegramIdStr = chatEntity.id.toString();
            await inboxService.upsert({
              platform: "telegram",
              externalId: `personal-${msg.id}`,
              userId,
              contactId: contact.id,
              contactName: contact.name,
              senderId: telegramIdStr,
              preview: body.slice(0, 120),
              body,
              receivedAt: new Date(msg.date * 1000),
              needsReply: !msg.out,
              fromMe: !!msg.out,
            });
            // Link any prior messages that were saved without a contactId
            await inboxService.linkMessagesToContact(contact.id, "telegram", telegramIdStr).catch(() => {});
          } catch (e) {
            console.error("[telegram-personal] Live listener handler error:", e);
          }
        }, new NewMessage({}));

        // ── Deleted messages (delete for me / delete for everyone) ───────────────
        // GramJS exposes deletions via Raw updates: UpdateDeleteMessages (private)
        // and UpdateDeleteChannelMessages (groups/channels).
        typedClient.addEventHandler(async (update: any) => {
          try {
            const className = update?.className ?? "";
            if (className !== "UpdateDeleteMessages" && className !== "UpdateDeleteChannelMessages") return;

            const ids: number[] = update.messages ?? [];
            for (const msgId of ids) {
              // Delete directly (no userId filter) — inboxService.deleteMessage defaults
              // userId to "default" which won't match real user UUIDs.
              const result = await (prisma as any).inboxMessage.deleteMany({
                where: { platform: "telegram", externalId: `personal-${msgId}` },
              });
              if (result.count > 0) {
                const { broadcastInboxEvent } = await import("./sse.service");
                broadcastInboxEvent("message_deleted", {});
                console.log(`[telegram-personal] Reflected deletion of personal-${msgId}`);
              }
            }
          } catch (e) {
            console.error("[telegram-personal] Deletion handler error:", e);
          }
        }, new Raw({}));

      }).catch(() => { /* ignore */ });
    } catch { /* ignore */ }
  },

  async sendPersonalMessage(userId: string, peer: string, text: string, replyTo?: number, contactId?: string | null): Promise<void> {
    const { TelegramClient, StringSession } = await getTelegramLib();
    const rec = decryptSession(await (prisma as any).telegramPersonalSession.findUnique({ where: { userId } }));
    if (!rec?.sessionStr) throw new Error("Telegram not connected — go to Settings → Telegram to reconnect.");

    let client = clients.get(userId) as any;
    if (!client) {
      try {
        client = new TelegramClient(new StringSession(rec.sessionStr), rec.apiId, rec.apiHash, { connectionRetries: 5 });
        await client.connect();
        clients.set(userId, client);
        telegramPersonalService._attachListener(userId, client);
        warmEntityCache(userId, client);
      } catch (err) {
        if (isSessionExpired(err)) {
          await clearSession(userId);
          throw new Error("Telegram session expired — go to Settings → Telegram to reconnect.");
        }
        throw err;
      }
    }

    // Resolve the target peer — GramJS needs the access hash alongside the user ID.
    let targetPeer: any = peer;
    if (/^-?\d+$/.test(peer)) {
      targetPeer = await resolveNumericPeer(userId, peer, client);
    } else {
      targetPeer = peer.replace(/^@/, "");
    }

    // Try to find contact by platformId (username), then by numeric senderId, then by contactId passed from the reply chain
    const platform = await prisma.platform.findFirst({
      where: { type: "telegram", OR: [{ platformId: peer }, { platformId: peer.replace(/^@/, "") }] },
      include: { contact: true },
    });
    let contact = platform?.contact ?? null;
    if (!contact && contactId) {
      contact = await prisma.contact.findUnique({ where: { id: contactId } }) ?? null;
    }

    // Check if the text contains a markdown media tag
    const { parseMediaMarkdown } = await import("./inbox.service");
    const media = parseMediaMarkdown(text);
    if (media) {
      const fs = await import("fs/promises");
      try {
        await fs.access(media.filePath);
        const sentMediaMsg = await client.sendFile(targetPeer, {
          file: media.filePath,
          caption: media.caption || undefined,
        });

        if (contact) {
          await inboxService.upsert({
            platform: "telegram",
            externalId: `personal-${sentMediaMsg.id}`,
            contactId: contact.id,
            contactName: contact.name,
            senderId: peer,
            preview: media.caption ? media.caption.slice(0, 120) : "[File]",
            body: text,
            receivedAt: new Date(sentMediaMsg.date * 1000),
            needsReply: false,
            fromMe: true,
          });
        }
        return;
      } catch (err) {
        console.warn(`[telegram-personal] Media file not accessible, sending as text link instead. error:`, err);
      }
    }

    let sentMsg: any;
    try {
      sentMsg = await client.sendMessage(targetPeer, { message: text, replyTo });
    } catch (err) {
      if (isSessionExpired(err)) {
        await clearSession(userId);
        throw new Error("Telegram session expired — go to Settings → Telegram to reconnect.");
      }
      throw err;
    }

    if (contact) {
      await inboxService.upsert({
        platform: "telegram",
        externalId: `personal-${sentMsg.id}`,
        contactId: contact.id,
        contactName: contact.name,
        senderId: peer,
        preview: text.slice(0, 120),
        body: text,
        receivedAt: new Date(sentMsg.date * 1000),
        needsReply: false,
        fromMe: true,
      });
    }
  },

  async sendOnly(userId: string, peer: string, text: string, replyTo?: number): Promise<any> {
    const { TelegramClient, StringSession } = await getTelegramLib();
    const rec = decryptSession(await (prisma as any).telegramPersonalSession.findUnique({ where: { userId } }));
    if (!rec?.sessionStr) throw new Error("Telegram not connected — go to Settings → Telegram to reconnect.");

    let client = clients.get(userId) as any;
    if (!client) {
      try {
        client = new TelegramClient(new StringSession(rec.sessionStr), rec.apiId, rec.apiHash, {
          connectionRetries: 5,
          requestRetries: 3,
          floodSleepThreshold: 60,
        });
        await client.connect();
        clients.set(userId, client);
        telegramPersonalService._attachListener(userId, client);
        // Warm entity cache in background so subsequent sends are faster
        warmEntityCache(userId, client);
      } catch (err) {
        if (isSessionExpired(err)) {
          await clearSession(userId);
          throw new Error("Telegram session expired — go to Settings → Telegram to reconnect.");
        }
        throw err;
      }
    }

    let targetPeer: any = peer;
    if (/^-?\d+$/.test(peer)) {
      targetPeer = await resolveNumericPeer(userId, peer, client);
    } else {
      // Username peer — strip leading @ for consistency
      targetPeer = peer.replace(/^@/, "");
    }

    // Check if the text contains a markdown media tag
    const { parseMediaMarkdown } = await import("./inbox.service");
    const media = parseMediaMarkdown(text);
    if (media) {
      const fs = await import("fs/promises");
      try {
        await fs.access(media.filePath);
        return await client.sendFile(targetPeer, {
          file: media.filePath,
          caption: media.caption || undefined,
          replyTo,
        });
      } catch (err) {
        console.warn(`[telegram-personal] Media file not accessible in sendOnly, sending as text link. error:`, err);
      }
    }

    try {
      return await client.sendMessage(targetPeer, { message: text, replyTo });
    } catch (err: any) {
      if (isSessionExpired(err)) {
        await clearSession(userId);
        throw new Error("Telegram session expired — go to Settings → Telegram to reconnect.");
      }
      const errMsg = err?.message ?? String(err);
      // FLOOD_WAIT — Telegram rate limit; wait and retry once
      const floodMatch = errMsg.match(/FLOOD_WAIT_(\d+)/);
      if (floodMatch) {
        const waitSecs = Math.min(parseInt(floodMatch[1], 10), 30); // cap at 30s
        console.warn(`[telegram-personal] FLOOD_WAIT_${floodMatch[1]} — waiting ${waitSecs}s before retry`);
        await new Promise((r) => setTimeout(r, waitSecs * 1000));
        return await client.sendMessage(targetPeer, { message: text, replyTo });
      }
      // TIMEOUT or connection drop — reconnect and retry once
      if (errMsg === "TIMEOUT" || errMsg.includes("CONNECTION") || errMsg.includes("disconnect")) {
        console.warn(`[telegram-personal] sendOnly hit ${errMsg} — reconnecting and retrying once`);
        clients.delete(userId);
        try { await client.disconnect(); } catch {}
        const { TelegramClient: TC, StringSession: SS } = await getTelegramLib();
        const freshClient = new TC(new SS(rec.sessionStr), rec.apiId!, rec.apiHash!, { connectionRetries: 5 });
        await freshClient.connect();
        clients.set(userId, freshClient);
        telegramPersonalService._attachListener(userId, freshClient);
        return await freshClient.sendMessage(
          /^-?\d+$/.test(peer) ? await resolveNumericPeer(userId, peer, freshClient) : peer.replace(/^@/, ""),
          { message: text, replyTo }
        );
      }
      throw err;
    }
  },

  async sendReaction(userId: string, peer: string, messageId: number, emoji: string): Promise<void> {
    // Reuse sendOnly's reconnect logic by ensuring client is alive
    let client = clients.get(userId) as any;
    if (!client) {
      const { TelegramClient, StringSession } = await getTelegramLib();
      const rec = decryptSession(await (prisma as any).telegramPersonalSession.findUnique({ where: { userId } }));
      if (!rec?.sessionStr) throw new Error("Telegram not connected");
      client = new TelegramClient(new StringSession(rec.sessionStr), rec.apiId, rec.apiHash, { connectionRetries: 5 });
      await client.connect();
      clients.set(userId, client);
    }
    const { Api } = await import("telegram");
    let targetPeer: any = peer;
    if (/^-?\d+$/.test(peer)) {
      targetPeer = await resolveNumericPeer(userId, peer, client);
    } else {
      targetPeer = peer.replace(/^@/, "");
    }
    await client.invoke(new (Api as any).messages.SendReaction({
      peer: targetPeer,
      msgId: messageId,
      reaction: [new (Api as any).ReactionEmoji({ emoticon: emoji })],
    }));
  },

  async disconnect(userId: string) {
    const client = clients.get(userId) as any;
    if (client) {
      try { await client.disconnect(); } catch { /* ignore */ }
      clients.delete(userId);
    }
    await (prisma as any).telegramPersonalSession.deleteMany({ where: { userId } });
  },

  async getOrCreateClient(userId: string): Promise<any> {
    const existing = clients.get(userId);
    if (existing) return existing;

    const { TelegramClient, StringSession } = await getTelegramLib();
    const rec = decryptSession(await (prisma as any).telegramPersonalSession.findUnique({ where: { userId } }));
    if (!rec?.sessionStr) throw new Error("Telegram not connected");

    try {
      const client = new TelegramClient(new StringSession(rec.sessionStr), rec.apiId, rec.apiHash, {
        connectionRetries: 5,
        requestRetries: 3,
        floodSleepThreshold: 60,
      });
      await client.connect();
      clients.set(userId, client);
      telegramPersonalService._attachListener(userId, client);
      warmEntityCache(userId, client);
      return client;
    } catch (err) {
      if (isSessionExpired(err)) {
        await clearSession(userId);
        throw new Error("Telegram session expired — go to Settings → Telegram to reconnect.");
      }
      throw err;
    }
  },

  async autoReconnect() {
    const sessions = ((await (prisma as any).telegramPersonalSession.findMany()) as any[]).map(decryptSession);
    for (const session of sessions) {
      if (!session.sessionStr) continue;
      try {
        console.log(`[telegram-personal] Auto-reconnecting session for user ${session.userId}...`);
        const { TelegramClient, StringSession } = await getTelegramLib();
        const client = new TelegramClient(new StringSession(session.sessionStr), session.apiId, session.apiHash, {
          connectionRetries: 5,
          requestRetries: 3,
          floodSleepThreshold: 60,
        });
        await client.connect();
        clients.set(session.userId, client);
        telegramPersonalService._attachListener(session.userId, client);
        console.log(`[telegram-personal] Auto-reconnect successful for user ${session.userId}`);
        // Warm entity cache in background so sends to numeric IDs work immediately
        warmEntityCache(session.userId, client);
      } catch (err) {
        if (isSessionExpired(err)) {
          console.error(`[telegram-personal] Session expired for user ${session.userId} — clearing. User must reconnect in Settings.`);
          await clearSession(session.userId);
        } else {
          console.error(`[telegram-personal] Auto-reconnect failed for user ${session.userId}:`, err);
        }
      }
    }
  },
};
