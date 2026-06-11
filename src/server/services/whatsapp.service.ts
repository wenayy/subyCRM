import path from "path";
import fs from "fs";
// @ts-expect-error Could not find a declaration file for module 'async-lock'
import AsyncLock from "async-lock";
import { prisma } from "../lib/prisma";
import { inboxService } from "./inbox.service";
import { broadcastInboxEvent } from "./sse.service";
import { encrypt, decrypt } from "../lib/encryption";

// Memory cache of WhatsApp message IDs sent from this CRM instance to avoid duplicates
export const sentCrmMessageIds = new Set<string>();

const fileLock = new AsyncLock({ maxPending: Infinity });

// ── Full auth-state persistence to DB ─────────────────────────────────────────
// Mirrors what Telegram does: store the entire session as one blob so that
// after a Railway deploy (ephemeral filesystem wiped), we restore everything
// atomically and WhatsApp never sees an inconsistent session state.

const dbPersistTimers = new Map<string, ReturnType<typeof setTimeout>>();

async function persistAllFilesToDb(authDir: string, userId: string): Promise<void> {
  try {
    const files = await fs.promises.readdir(authDir).catch(() => [] as string[]);
    const authFiles: Record<string, string> = {};
    for (const f of files) {
      if (f.endsWith(".tmp")) continue;
      try {
        authFiles[f] = await fs.promises.readFile(path.join(authDir, f), "utf-8");
      } catch {}
    }
    if (Object.keys(authFiles).length === 0) return;
    const blob = JSON.stringify(authFiles);
    // Also keep credsJson populated for the legacy autoReconnect check
    const credsContent = authFiles["creds.json"] ?? null;
    await (prisma as any).whatsAppSession.upsert({
      where: { userId },
      create: { userId, authFilesJson: encrypt(blob), credsJson: credsContent ? encrypt(credsContent) : null },
      update: { authFilesJson: encrypt(blob), ...(credsContent ? { credsJson: encrypt(credsContent) } : {}) },
    });
    console.log(`[whatsapp] Persisted ${Object.keys(authFiles).length} auth files to DB for ${userId}`);
  } catch (e) {
    console.warn("[whatsapp] Failed to persist auth files to DB:", e);
  }
}

function schedulePersist(authDir: string, userId: string): void {
  const existing = dbPersistTimers.get(userId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    dbPersistTimers.delete(userId);
    persistAllFilesToDb(authDir, userId);
  }, 4_000); // debounce: write to DB 4s after last key change
  dbPersistTimers.set(userId, t);
}

// Called on graceful shutdown so pending debounced writes aren't lost.
export async function flushWhatsAppSessions(): Promise<void> {
  const pending = Array.from(dbPersistTimers.entries());
  if (pending.length === 0) return;
  console.log(`[whatsapp] Flushing ${pending.length} pending session write(s) before exit…`);
  for (const [userId, timer] of pending) {
    clearTimeout(timer);
    dbPersistTimers.delete(userId);
    const authDir = getAuthDir(userId);
    await persistAllFilesToDb(authDir, userId);
  }
}

async function useRobustMultiFileAuthState(folder: string, userId: string) {
  const fixFileName = (file?: string) => file?.replace(/\//g, "__")?.replace(/:/g, "-");

  const writeData = async (data: any, file: string) => {
    const filePath = path.join(folder, fixFileName(file)!);
    const tmpPath = filePath + ".tmp";
    const { BufferJSON } = await getBaileys();
    await fileLock.acquire(filePath, async () => {
      const content = JSON.stringify(data, BufferJSON.replacer);
      await fs.promises.writeFile(tmpPath, content);
      await fs.promises.rename(tmpPath, filePath);
    });
  };

  const readData = async (file: string) => {
    try {
      const filePath = path.join(folder, fixFileName(file)!);
      const { BufferJSON } = await getBaileys();
      const data = await fileLock.acquire(filePath, () =>
        fs.promises.readFile(filePath, { encoding: "utf-8" })
      );
      return JSON.parse(data, BufferJSON.reviver);
    } catch (error) {
      return null;
    }
  };

  const removeData = async (file: string) => {
    try {
      const filePath = path.join(folder, fixFileName(file)!);
      await fileLock.acquire(filePath, () => fs.promises.unlink(filePath));
    } catch {}
  };

  const folderInfo = await fs.promises.stat(folder).catch(() => {});
  if (folderInfo) {
    if (!folderInfo.isDirectory()) {
      throw new Error(`found something that is not a directory at ${folder}`);
    }
  } else {
    await fs.promises.mkdir(folder, { recursive: true });
  }

  const { initAuthCreds } = await getBaileys();
  const creds = (await readData("creds.json")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type: string, ids: string[]) => {
          const data: any = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}.json`);
              if (type === "app-state-sync-key" && value) {
                const { proto } = await getBaileys();
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data: any) => {
          const tasks: Promise<void>[] = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const file = `${category}-${id}.json`;
              tasks.push(value ? writeData(value, file) : removeData(file));
            }
          }
          await Promise.all(tasks);
          // Schedule a debounced DB persist after key changes
          schedulePersist(folder, userId);
        },
      },
    },
    saveCreds: () => {
      schedulePersist(folder, userId);
      return writeData(creds, "creds.json");
    },
  };
}

const getAuthDir = (userId: string) => path.join(process.cwd(), ".whatsapp-auth", userId);
const getLidFile = (userId: string) => path.join(getAuthDir(userId), "lid-map.json");

// ── Per-user state ─────────────────────────────────────────────────────────────
type UserState = {
  sock: any | null;
  connected: boolean;
  qr: string | null;
  phoneNumber: string | null;
  userId: string;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectDelay: number;
  reconnecting: boolean;
  consecutive440s: number;
  lastConnectedAt: number;
  // Monotonically-increasing counter. Each call to connectSocket gets its own
  // generation number. Event handlers check that their generation still matches
  // before acting — this prevents a closing socket from triggering scheduleReconnect
  // and creating a second connectSocket call (the cascade-loop root cause).
  generation: number;
  lidMap: Map<string, string>;
  contactsCache: Map<string, any>;
  pendingLidMessages: Array<{ msg: any; isHistorical: boolean }>;
  autoImportDone: boolean;
};

const sessions = new Map<string, UserState>();

function getSession(userId: string): UserState {
  let s = sessions.get(userId);
  if (!s) {
    s = {
      sock: null,
      connected: false,
      qr: null,
      phoneNumber: null,
      userId,
      reconnectTimer: null,
      reconnectDelay: 0,
      reconnecting: false,
      consecutive440s: 0,
      lastConnectedAt: 0,
      generation: 0,
      lidMap: new Map(),
      contactsCache: new Map(),
      pendingLidMessages: [],
      autoImportDone: false,
    };
    sessions.set(userId, s);
  }
  return s;
}

// ── LID → phone mapping (persisted across restarts) ───────────────────────────
// Key: LID digits (no suffix), Value: phone digits (no suffix)

function loadLidMap(s: UserState): void {
  try {
    const lidFile = getLidFile(s.userId);
    if (fs.existsSync(lidFile)) {
      const raw = JSON.parse(fs.readFileSync(lidFile, "utf-8")) as Record<string, string>;
      for (const [k, v] of Object.entries(raw)) s.lidMap.set(k, v);
      console.log(`[whatsapp] Loaded ${s.lidMap.size} LID entries`);
    }
  } catch {}
}

function saveLidMap(s: UserState): void {
  try {
    const obj: Record<string, string> = {};
    for (const [k, v] of s.lidMap.entries()) obj[k] = v;
    fs.writeFileSync(getLidFile(s.userId), JSON.stringify(obj));
  } catch {}
}

function ingestContacts(contacts: any[], s: UserState): void {
  let changed = false;
  for (const c of contacts) {
    if (c.id) s.contactsCache.set(c.id, c);
    // c.lid="<digits>@lid", c.id="<digits>@s.whatsapp.net" → build LID map
    if (c.lid && c.id?.endsWith("@s.whatsapp.net")) {
      const lid   = c.lid.split("@")[0];
      const phone = c.id.split("@")[0];
      if (lid && phone && s.lidMap.get(lid) !== phone) {
        s.lidMap.set(lid, phone);
        changed = true;
      }
    }
  }
  if (changed) {
    saveLidMap(s);
    // Retry messages that were dropped because the LID wasn't in the map yet
    if (s.pendingLidMessages.length > 0) {
      const pending = s.pendingLidMessages.splice(0);
      console.log(`[whatsapp] Retrying ${pending.length} buffered @lid message(s)…`);
      for (const { msg, isHistorical } of pending) {
        processMessage(msg, isHistorical, s).catch(() => {});
      }
    }
  }
}

// ── DB platform cache (per-user) ──────────────────────────────────────────────
type PlatformRow = { contactId: string; contactName: string; phoneDigits: string };
const platformCacheByUser = new Map<string, { rows: PlatformRow[]; expiry: number }>();

async function getPlatforms(userId: string): Promise<PlatformRow[]> {
  const cached = platformCacheByUser.get(userId);
  if (cached && Date.now() < cached.expiry && cached.rows.length > 0) return cached.rows;
  const rows = await prisma.platform.findMany({
    where: { type: "whatsapp", contact: { userId } },
    include: { contact: true },
  });
  const result = rows
    .filter((r) => r.contact)
    .map((r) => ({
      contactId: r.contact!.id,
      contactName: r.contact!.name,
      phoneDigits: r.platformId.replace(/\D/g, ""),
    }))
    .filter((r) => r.phoneDigits.length >= 10);
  platformCacheByUser.set(userId, { rows: result, expiry: Date.now() + 5 * 60 * 1000 });
  return result;
}

export function invalidatePlatformCache(userId?: string): void {
  if (userId) {
    platformCacheByUser.delete(userId);
  } else {
    platformCacheByUser.clear();
  }
}

// ── JID helpers ───────────────────────────────────────────────────────────────

// Resolve any JID/phone to a sendable @s.whatsapp.net form
// Note: this exported form has no per-user state — it cannot resolve @lid JIDs
// without a session. Use the internal resolveJid(jid, s) for full resolution.
export function resolveJid(jid: string): string | null {
  if (!jid) return null;
  if (jid.endsWith("@g.us")) return jid;
  if (jid.endsWith("@s.whatsapp.net")) {
    const digits = jid.split("@")[0].replace(/\D/g, "");
    return digits ? `${digits}@s.whatsapp.net` : null;
  }
  if (jid.endsWith("@lid")) {
    // No session context — cannot resolve @lid here
    return null;
  }
  const digits = jid.replace(/\D/g, "");
  return digits ? `${digits}@s.whatsapp.net` : null;
}

// Internal version with full per-user state for @lid resolution
function resolveJidWithState(jid: string, s: UserState): string | null {
  if (!jid) return null;
  if (jid.endsWith("@g.us")) return jid;
  if (jid.endsWith("@s.whatsapp.net")) {
    const digits = jid.split("@")[0].replace(/\D/g, "");
    return digits ? `${digits}@s.whatsapp.net` : null;
  }
  if (jid.endsWith("@lid")) {
    const phone = s.lidMap.get(jid.split("@")[0]);
    if (phone) return `${phone}@s.whatsapp.net`;
    // Try contacts cache
    const cached = s.contactsCache.get(jid);
    if (cached?.id?.endsWith("@s.whatsapp.net")) return cached.id;
    return null;
  }
  const digits = jid.replace(/\D/g, "");
  return digits ? `${digits}@s.whatsapp.net` : null;
}

// Get phone digits from a JID (resolves @lid via map, then contactsCache)
function jidDigits(jid: string, s: UserState): string {
  if (jid.endsWith("@lid")) {
    const fromMap = s.lidMap.get(jid.split("@")[0]);
    if (fromMap) return fromMap;
    // Fallback: contactsCache may have the @s.whatsapp.net id before lidMap is saved
    const cached = s.contactsCache.get(jid);
    if (cached?.id?.endsWith("@s.whatsapp.net")) {
      return cached.id.split("@")[0].replace(/\D/g, "");
    }
    return "";
  }
  return jid.split("@")[0].replace(/\D/g, "");
}

// Match a JID to a CRM contact (scoped to the owning user)
async function resolveContact(
  jid: string,
  pushName: string | null | undefined,
  s: UserState,
): Promise<{ contactId: string; contactName: string } | null> {
  const digits = jidDigits(jid, s);
  const platforms = await getPlatforms(s.userId);

  if (digits.length >= 10) {
    // Exact match first (full number with country code)
    const exact = platforms.find((p) => p.phoneDigits === digits);
    if (exact) {
      // Prefer the phone-saved name (info.name) from contacts cache over CRM name
      const cached = s.contactsCache.get(jid) || s.contactsCache.get(`${digits}@s.whatsapp.net`);
      const name = cached?.name || exact.contactName;
      return { contactId: exact.contactId, contactName: name };
    }

    // Last-10-digit match — strips country code variation (91xxxxxxxxxx vs xxxxxxxxxx)
    // Both sides must have ≥10 digits to prevent short stored numbers causing false matches
    const last10 = digits.slice(-10);
    const hit = platforms.find(
      (p) => p.phoneDigits.length >= 10 && p.phoneDigits.slice(-10) === last10,
    );
    if (hit) {
      const cached = s.contactsCache.get(jid) || s.contactsCache.get(`${digits}@s.whatsapp.net`);
      const name = cached?.name || hit.contactName;
      return { contactId: hit.contactId, contactName: name };
    }
  }

  // pushName fallback for unresolved @lid — EXACT match only.
  // Prefix/startsWith matching ("yogesh pangati".startsWith("yogesh")) caused messages from
  // strangers with a common first name to be attributed to the wrong CRM contact, then replies
  // went to that contact's saved phone number instead of the actual sender.
  if (jid.endsWith("@lid") && !digits && pushName) {
    const norm = pushName.toLowerCase().trim();
    const hit = platforms.find((p) => p.contactName.toLowerCase().trim() === norm);
    if (hit) {
      console.log(`[whatsapp] LID matched via pushName exact "${pushName}" → ${hit.contactName}`);
      return { contactId: hit.contactId, contactName: hit.contactName };
    }
  }

  return null;
}

// ── WA delivery status → string ────────────────────────────────────────────────
// Detect WhatsApp pushName-style names (e.g. "Vatsal_Kumar_20232057") vs clean phone-book names.
function looksLikePushName(name: string): boolean {
  return /_\d{4,}/.test(name) || (name.includes("_") && /\d/.test(name) && name.split("_").length > 2);
}

function waStatusString(status: number | undefined): string | null {
  if (status === 2) return "sent";
  if (status === 3) return "delivered";
  if (status === 4) return "read";
  if (status === 5) return "played";
  return null;
}

// ── Quote context extraction ────────────────────────────────────────────────────
function extractQuoteContext(msg: any): { quotedId: string | null; quotedBody: string | null; quotedFromMe: boolean | null } {
  const m = msg.message;
  if (!m) return { quotedId: null, quotedBody: null, quotedFromMe: null };
  const ctx =
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo ||
    m.audioMessage?.contextInfo ||
    m.documentMessage?.contextInfo;
  if (!ctx?.stanzaId) return { quotedId: null, quotedBody: null, quotedFromMe: null };
  const qm = ctx.quotedMessage;
  const quotedBody = qm
    ? qm.conversation || qm.extendedTextMessage?.text ||
      (qm.imageMessage ? "[Image]" : null) ||
      (qm.videoMessage ? "[Video]" : null) ||
      (qm.audioMessage ? "[Voice Note]" : null) ||
      (qm.documentMessage ? "[Document]" : null) || null
    : null;
  const quotedFromMe = ctx.participant ? ctx.participant === msg.key?.remoteJid : true;
  return { quotedId: ctx.stanzaId, quotedBody, quotedFromMe };
}

// ── Text extraction ────────────────────────────────────────────────────────────
function extractText(msg: any): string {
  let m = msg.message;
  if (!m) return "";
  // Unwrap ephemeral (disappearing messages) and view-once wrappers
  if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
  else if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
  else if (m.viewOnceMessageV2?.message?.viewOnceMessage?.message) m = m.viewOnceMessageV2.message.viewOnceMessage.message;
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage) return m.imageMessage.caption || "[Image]";
  if (m.videoMessage) return m.videoMessage.caption || "[Video]";
  if (m.audioMessage) return "[Voice Note]";
  if (m.documentMessage) return m.documentMessage.caption || m.documentMessage.fileName || "[Document]";
  if (m.stickerMessage) return "[Sticker]";
  if (m.reactionMessage) return ""; // reactions are not messages, skip silently
  if (m.pollCreationMessage) return `[Poll: ${m.pollCreationMessage.name || ""}]`;
  if (m.locationMessage) return "[Location]";
  if (m.contactMessage) return `[Contact: ${m.contactMessage.displayName || ""}]`;
  return "";
}

function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png",
    "image/gif": ".gif", "image/webp": ".webp", "image/heic": ".heic",
    "video/mp4": ".mp4", "video/quicktime": ".mov", "video/3gpp": ".3gp",
    "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "audio/mp4": ".m4a",
    "audio/opus": ".ogg",
  };
  return map[mime] ?? `.${mime.split("/")[1] ?? "bin"}`;
}

async function downloadAndSaveMedia(msg: any, s: UserState): Promise<string | null> {
  const m = msg.message;
  if (!m) return null;
  const hasMedia = m.imageMessage || m.videoMessage || m.audioMessage || m.documentMessage || m.stickerMessage;
  if (!hasMedia) return null;
  try {
    const { downloadMediaMessage } = await getBaileys();
    const buffer = await downloadMediaMessage(
      msg,
      "buffer",
      {},
      { logger: { level: "silent", trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => ({ level: "silent", trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => ({} as any) }) } as any,
        reuploadRequest: s.sock?.updateMediaMessage?.bind(s.sock),
      }
    ) as Buffer;
    if (!buffer || !buffer.length) return null;
    const mime =
      m.imageMessage?.mimetype ?? m.videoMessage?.mimetype ?? m.audioMessage?.mimetype ??
      m.documentMessage?.mimetype ?? m.stickerMessage?.mimetype ?? "application/octet-stream";
    const ext = m.documentMessage?.fileName
      ? path.extname(m.documentMessage.fileName) || mimeToExt(mime)
      : mimeToExt(mime);
    const uniqueName = `${Date.now()}_${(msg.key?.id ?? "media").replace(/[^a-zA-Z0-9_-]/g, "")}${ext}`;
    const { saveMedia } = await import("../lib/media-store");
    return await saveMedia(buffer, uniqueName, mime);
  } catch (e) {
    console.error("[whatsapp] Media download failed:", e);
    return null;
  }
}

// ── Message processor ──────────────────────────────────────────────────────────
async function processMessage(msg: any, isHistorical: boolean, s: UserState): Promise<void> {
  const remoteJid: string = msg.key?.remoteJid ?? "";
  if (!remoteJid) return;
  if (
    remoteJid.endsWith("@g.us") ||
    remoteJid.endsWith("@broadcast") ||
    remoteJid === "status@broadcast"
  ) return;
  if (!msg.message) {
    if (!isHistorical) console.log(`[whatsapp] drop: no message object from ${remoteJid}`);
    return;
  }

  let text = extractText(msg);
  if (!text) {
    if (!isHistorical) {
      const types = Object.keys(msg.message ?? {}).join(",");
      console.log(`[whatsapp] drop: no text from ${remoteJid}, types=${types}`);
    }
    return;
  }

  const fromMe = !!msg.key.fromMe;
  if (fromMe && !isHistorical) {
    if (msg.key.id && sentCrmMessageIds.has(msg.key.id)) {
      return; // sent messages saved by inbox.service.reply, ignore the socket echo
    }
  }

  let contact = await resolveContact(remoteJid, msg.pushName, s);

  // For outgoing messages sent from the user's phone: resolveContact uses phone digits,
  // but pushName is null for outgoing so the name fallback never fires.
  // Look up the contact from previous inbox messages where this JID was the sender.
  if (!contact && fromMe && !isHistorical) {
    const prev = await (prisma as any).inboxMessage.findFirst({
      where: { platform: "whatsapp", userId: s.userId, senderId: remoteJid, contactId: { not: null }, fromMe: false },
    });
    if (prev?.contactId) {
      contact = { contactId: prev.contactId, contactName: prev.contactName };
      console.log(`[whatsapp] Resolved outgoing message via DB lookup → ${contact.contactName}`);
    }
  }

  // Quote context (reply threading)
  const { quotedId, quotedBody, quotedFromMe } = extractQuoteContext(msg);

  // Delivery status — only meaningful for outgoing messages
  const waStatus: string | null = fromMe ? (waStatusString(msg.status) ?? (isHistorical ? null : "sent")) : null;

  if (!contact) {
    if (remoteJid.endsWith("@lid")) {
      // LID not yet resolved — buffer and retry after contacts.upsert fires
      if (!isHistorical) s.pendingLidMessages.push({ msg, isHistorical });
      return;
    }

    // Skip messages to/from the user's own number (Saved Messages / note-to-self chat)
    const ownJid = s.phoneNumber ? `${s.phoneNumber}@s.whatsapp.net` : null;
    if (ownJid && remoteJid === ownJid) return;

    // If this JID is in the phone's address book with a real name, auto-create the CRM contact
    // so the message lands in a named conversation rather than "NOT IN CONTACTS".
    const cached = s.contactsCache.get(remoteJid) as any;
    const phoneName: string | undefined = cached?.name || cached?.verifiedName;
    if (phoneName && !phoneName.match(/^[+\d]/)) {
      const phoneDigits = jidDigits(remoteJid, s);
      if (phoneDigits.length >= 8) {
        try {
          const created = await prisma.contact.create({
            data: {
              name: phoneName, userId: s.userId,
              type: "other", domain: "other", relationshipStrength: "cold",
              platforms: { create: [{ type: "whatsapp", platformId: phoneDigits, displayName: phoneName }] },
            },
          });
          contact = { contactId: created.id, contactName: phoneName };
          invalidatePlatformCache(s.userId);
          // Retroactively link any earlier messages from this JID
          void inboxService.linkMessagesToContact(created.id, "whatsapp", phoneDigits).catch(() => {});
          void inboxService.linkMessagesToContact(created.id, "whatsapp", remoteJid).catch(() => {});
        } catch {
          // Race condition — contact was created by another path; look it up
          const plat = await prisma.platform.findFirst({
            where: { type: "whatsapp", platformId: phoneDigits, contact: { userId: s.userId } },
            include: { contact: { select: { id: true, name: true } } },
          });
          if (plat?.contact) contact = { contactId: plat.contact.id, contactName: plat.contact.name };
        }
      }
    }

    if (!contact) {
      if (isHistorical) {
        // Allow up to 10 historical messages per unknown sender for context
        const existing = await (prisma as any).inboxMessage.count({
          where: { platform: "whatsapp", senderId: remoteJid, contactId: null },
        });
        if (existing >= 10) return;
      }

      // Save unknown messages (live or up to 10 historical) so they appear in inbox.
      const displayName = fromMe
        ? (s.contactsCache.get(remoteJid) as any)?.name || jidDigits(remoteJid, s) || remoteJid.replace(/@.+$/, "")
        : msg.pushName || jidDigits(remoteJid, s) || remoteJid.replace(/@.+$/, "");
      await inboxService.upsert({
        platform: "whatsapp",
        externalId: msg.key.id ?? `wa-${remoteJid}-${msg.messageTimestamp}`,
        userId: s.userId,
        contactId: null,
        contactName: displayName,
        senderId: remoteJid,
        preview: text.slice(0, 120),
        body: text,
        receivedAt: new Date((msg.messageTimestamp as number) * 1000),
        fromMe,
        waStatus,
        quotedId,
        quotedBody,
        quotedFromMe,
      });

      // Backfill earlier messages from this sender that landed as raw digits
      // (historical sync has no pushName, so they get the JID digits as name).
      if (!fromMe && msg.pushName) {
        const digits = jidDigits(remoteJid, s);
        if (digits) {
          await (prisma as any).inboxMessage.updateMany({
            where: {
              userId: s.userId,
              platform: "whatsapp",
              senderId: remoteJid,
              contactId: null,
              contactName: { in: [digits, remoteJid, remoteJid.replace(/@.+$/, "")] },
            },
            data: { contactName: msg.pushName },
          }).catch(() => {});
        }
      }
      return;
    }
  }

  const msgExternalId = msg.key.id ?? `wa-${remoteJid}-${msg.messageTimestamp}`;

  // Save the message immediately so it appears in the inbox right away
  await inboxService.upsert({
    platform: "whatsapp",
    externalId: msgExternalId,
    userId: s.userId,
    contactId: contact.contactId,
    contactName: contact.contactName,
    senderId: remoteJid,
    preview: text.slice(0, 120),
    body: text,
    receivedAt: new Date((msg.messageTimestamp as number) * 1000),
    fromMe,
    waStatus,
    quotedId,
    quotedBody,
    quotedFromMe,
  });

  // Download media in background — never blocks message receipt
  const msgAgeMs = Date.now() - (msg.messageTimestamp as number) * 1000;
  const isRecentEnoughForMedia = msgAgeMs < 7 * 24 * 60 * 60 * 1000;
  if (!isHistorical || isRecentEnoughForMedia) {
    const m = msg.message;
    const hasMedia = m?.imageMessage || m?.videoMessage || m?.audioMessage || m?.documentMessage || m?.stickerMessage;
    if (hasMedia) {
      void (async () => {
        try {
          const mediaUrl = await downloadAndSaveMedia(msg, s);
          if (!mediaUrl) return;
          const caption = m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption || "";
          const docName = m.documentMessage?.fileName || "file";
          let mediaText: string;
          if (m.imageMessage || m.stickerMessage) {
            mediaText = caption ? `![${caption}](${mediaUrl})` : `![Image](${mediaUrl})`;
          } else if (m.videoMessage) {
            mediaText = caption ? `![${caption}](${mediaUrl})` : `![Video](${mediaUrl})`;
          } else if (m.audioMessage) {
            mediaText = `[Voice Note](${mediaUrl})`;
          } else {
            mediaText = `[${docName}](${mediaUrl})`;
          }
          // Re-upsert with media URL — SSE fires again, inbox updates in place
          await inboxService.upsert({
            platform: "whatsapp",
            externalId: msgExternalId,
            userId: s.userId,
            contactId: contact.contactId,
            contactName: contact.contactName,
            senderId: remoteJid,
            preview: mediaText.slice(0, 120),
            body: mediaText,
            receivedAt: new Date((msg.messageTimestamp as number) * 1000),
            fromMe,
            waStatus,
            quotedId,
            quotedBody,
            quotedFromMe,
          });
        } catch (e) {
          console.error("[whatsapp] Background media download error:", e);
        }
      })();
    }
  }
}

// ── Baileys lazy import ────────────────────────────────────────────────────────
let _baileys: typeof import("@whiskeysockets/baileys") | null = null;
async function getBaileys() {
  if (!_baileys) _baileys = await import("@whiskeysockets/baileys");
  return _baileys;
}

// ── Socket lifecycle ───────────────────────────────────────────────────────────

// Silently drop the socket reference WITHOUT calling end().
// Calling sock.end() emits connection.update{close} on the OLD socket, which would
// trigger our handler → scheduleReconnect → another connectSocket = cascade loop.
// We bump `s.generation` so any in-flight handlers from the old socket see a
// stale generation number and exit immediately instead of scheduling another reconnect.
function dropSocket(s: UserState): void {
  s.generation++;
  if (s.sock) {
    try { s.sock.end(undefined); } catch {}
    try {
      if (s.sock.ws) {
        s.sock.ws.close();
        s.sock.sock?.destroy?.();
      }
    } catch {}
    s.sock = null;
  }
  s.connected = false;
  s.qr = null;
}

// Only used for explicit user-initiated logout — actually ends the WA session.
function endSocketForLogout(s: UserState): void {
  s.generation++;
  if (s.sock) {
    try { s.sock.end(undefined); } catch {}
    s.sock = null;
  }
  s.connected = false;
  s.qr = null;
}

function scheduleReconnect(gen: number, s: UserState): void {
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  // Always wait at least 3 s to avoid racing WhatsApp's server-side cleanup.
  // Honour the delay already set by the 440 handler — don't double it here.
  const delay = Math.max(s.reconnectDelay, 3_000);
  console.log(`[whatsapp] Reconnecting in ${delay / 1000}s…`);
  s.reconnectTimer = setTimeout(() => {
    s.reconnectTimer = null;
    s.reconnectDelay = 0; // reset after the wait
    // Only proceed if no newer socket has been created since this was scheduled
    if (s.generation === gen && !s.connected) {
      connectSocket(s.userId).catch(console.error);
    }
  }, delay);
}

function waitForConnection(ms: number, s: UserState): Promise<void> {
  if (s.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const poll = () => {
      if (s.connected) return resolve();
      if (Date.now() > deadline) return reject(new Error("timeout"));
      setTimeout(poll, 300);
    };
    poll();
  });
}

// ── Core: create socket and wire events ───────────────────────────────────────
async function connectSocket(userId: string): Promise<{ qr?: string; connected: boolean }> {
  const s = getSession(userId);

  // Safeguard: Check if AUTH_DIR exists but creds.json is corrupt/empty.
  // Also restore from DB if the filesystem is missing (e.g. after a Railway redeploy).
  const authDir = getAuthDir(userId);
  const credsFile = path.join(authDir, "creds.json");
  if (fs.existsSync(credsFile)) {
    try {
      const stats = fs.statSync(credsFile);
      if (stats.size === 0) {
        console.warn("[whatsapp] creds.json is empty. Cleaning up auth directory.");
        fs.rmSync(authDir, { recursive: true, force: true });
        await (prisma as any).whatsAppSession.updateMany({
          where: { userId }, data: { connected: false },
        }).catch(() => {});
      } else {
        const content = fs.readFileSync(credsFile, "utf-8");
        JSON.parse(content); // validate
      }
    } catch (e) {
      console.warn("[whatsapp] creds.json is corrupt. Cleaning up auth directory.");
      fs.rmSync(authDir, { recursive: true, force: true });
      await (prisma as any).whatsAppSession.updateMany({
        where: { userId }, data: { connected: false },
      }).catch(() => {});
    }
  }
  // Restore ALL auth files from DB if the auth dir was wiped (Railway ephemeral FS).
  // Baileys needs creds + app-state-sync-keys + sender-keys + pre-keys — not just creds.json.
  // We snapshot the full directory to DB on every connect, so we can restore it atomically.
  if (!fs.existsSync(credsFile)) {
    try {
      const saved = await (prisma as any).whatsAppSession.findUnique({
        where: { userId },
        select: { authFilesJson: true, credsJson: true },
      });
      if (saved?.authFilesJson) {
        const authFiles: Record<string, string> = JSON.parse(decrypt(saved.authFilesJson));
        fs.mkdirSync(authDir, { recursive: true });
        for (const [fname, content] of Object.entries(authFiles)) {
          fs.writeFileSync(path.join(authDir, fname), content, "utf-8");
        }
        console.log(`[whatsapp] Restored ${Object.keys(authFiles).length} auth files from DB for ${userId}`);
      } else if (saved?.credsJson) {
        // Legacy fallback: only creds.json was stored (will reconnect but may need re-link)
        fs.mkdirSync(authDir, { recursive: true });
        fs.writeFileSync(credsFile, decrypt(saved.credsJson), "utf-8");
        console.log(`[whatsapp] Restored creds.json (legacy) from DB for ${userId}`);
      }
    } catch (e) {
      console.warn("[whatsapp] Could not restore auth files from DB:", e);
    }
  }

  // Bump generation FIRST, then drop old socket.
  // Any pending callbacks from the old socket will see a stale generation and no-op.
  dropSocket(s);
  s.reconnecting = true;

  const myGen = s.generation; // capture generation for this socket's lifetime

  const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
  } = await getBaileys();
  const { Boom } = await import("@hapi/boom");
  const pino = (await import("pino")).default;

  // Guard: another connectSocket may have started while we were awaiting getBaileys()
  if (s.generation !== myGen) return { connected: false };

  fs.mkdirSync(authDir, { recursive: true });
  loadLidMap(s);

  const { state: authState, saveCreds } = await useRobustMultiFileAuthState(authDir, userId);

  // Guard again after the async auth-state load
  if (s.generation !== myGen) return { connected: false };

  let version: [number, number, number];
  try {
    const fetched = await fetchLatestBaileysVersion();
    version = fetched.version;
  } catch {
    version = [2, 3000, 1023625727];
    console.log("[whatsapp] Using fallback WA version");
  }

  if (s.generation !== myGen) return { connected: false };

  const sock = makeWASocket({
    version,
    auth: authState,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: Browsers.ubuntu("Chrome"),
    keepAliveIntervalMs: 25_000,
    maxMsgRetryCount: 3,
    // Required for Baileys to resend messages when a recipient hits a pre-key decryption error.
    // Without this, messages stay as "Waiting for this message" on the recipient's side.
    getMessage: async (key) => {
      const stored = await (prisma as any).inboxMessage.findFirst({
        where: { platform: "whatsapp", externalId: key.id ?? "" },
      });
      if (!stored?.body) return undefined;
      const { proto } = await getBaileys();
      return proto.Message.fromObject({ conversation: stored.body });
    },
  });

  s.sock = sock;

  return new Promise((resolve) => {
    let settled = false;
    const settle = (val: { qr?: string; connected: boolean }) => {
      if (!settled) { settled = true; s.reconnecting = false; resolve(val); }
    };

    // ── Connection state ──────────────────────────────────────
    sock.ev.on("connection.update", async (update: any) => {
      // If a newer socket has replaced this one, ignore all events from this socket
      if (s.generation !== myGen) return;

      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("[whatsapp] QR code ready. Go to Settings → WhatsApp to scan.");
        try {
          const QRCode = await import("qrcode");
          s.qr = await QRCode.toDataURL(qr);
        } catch {
          s.qr = qr;
        }
        settle({ qr: s.qr!, connected: false });
      }

      if (connection === "open") {
        s.connected    = true;
        s.lastConnectedAt = Date.now();
        s.qr           = null;
        s.phoneNumber  = sock.user?.id?.split(":")[0] ?? null;
        console.log(`[whatsapp] Connected as ${s.phoneNumber}`);
        try {
          await (prisma as any).whatsAppSession.upsert({
            where:  { userId },
            create: { userId, connected: true, phoneNumber: s.phoneNumber },
            update: { connected: true, phoneNumber: s.phoneNumber },
          });
        } catch (e) {
          console.error("[whatsapp] Failed to persist session:", e);
        }
        // Snapshot all auth files to DB immediately on every successful connect.
        // This is the equivalent of Telegram's sessionStr — a complete, restorable blob.
        persistAllFilesToDb(authDir, userId).catch(e =>
          console.error("[whatsapp] Failed to snapshot auth files on connect:", e)
        );
        settle({ connected: true });
      }

      if (connection === "close") {
        s.connected = false;
        const code = (lastDisconnect?.error as InstanceType<typeof Boom>)?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut || code === 401;
        console.log(`[whatsapp] Disconnected — code=${code} loggedOut=${loggedOut}`);

        if (loggedOut) {
          try { fs.rmSync(authDir, { recursive: true, force: true }); } catch {}
          await (prisma as any).whatsAppSession.deleteMany({ where: { userId } }).catch(() => {});
          console.log("[whatsapp] Logged out. Scan QR to reconnect.");
          settle({ connected: false });
        } else {
          settle({ connected: false });
          if (code === DisconnectReason.connectionReplaced || code === 440) {
            // 440 = another client replaced this session (e.g. user opens WhatsApp on phone).
            // Graduated backoff: escalates if 440s keep happening in quick succession.
            // Reset the counter only if this connection was stable for 5+ minutes — this
            // ensures rapid-fire 440s escalate to longer delays instead of always waiting 30s.
            const connectedDuration = Date.now() - s.lastConnectedAt;
            if (connectedDuration >= 5 * 60_000) s.consecutive440s = 0;
            s.consecutive440s++;
            const delays = [30_000, 90_000, 5 * 60_000]; // 30s → 90s → 5 min
            s.reconnectDelay = delays[Math.min(s.consecutive440s - 1, delays.length - 1)];
            console.log(`[whatsapp] Connection replaced (440) — count=${s.consecutive440s}, stable_for=${Math.round(connectedDuration / 1000)}s, reconnecting in ${s.reconnectDelay / 1000}s`);
          } else {
            s.consecutive440s = 0;
            s.reconnectDelay = 0;
          }
          // Pass myGen so scheduleReconnect won't fire if a newer socket already exists
          scheduleReconnect(myGen, s);
        }
      }
    });

    // ── Credentials ───────────────────────────────────────────
    // saveCreds() already calls schedulePersist which debounces a full auth-file
    // snapshot to DB — no need for a separate single-file persist here.
    sock.ev.on("creds.update", () => { saveCreds(); });

    // ── Historical messages ───────────────────────────────────
    sock.ev.on("messaging-history.set", async ({ messages: historicalMsgs, contacts }: any) => {
      if (s.generation !== myGen) return;
      if (contacts?.length) ingestContacts(contacts, s);
      if (!historicalMsgs?.length) return;
      console.log(`[whatsapp] Syncing ${historicalMsgs.length} historical messages…`);
      let saved = 0;
      for (const msg of historicalMsgs) {
        try { await processMessage(msg, true, s); saved++; } catch {}
      }
      console.log(`[whatsapp] History done — ${saved}/${historicalMsgs.length} saved`);
    });

    // ── Contact list updates (builds LID map) ────────────────
    sock.ev.on("contacts.upsert", async (c: any[]) => {
      if (s.generation !== myGen) return;
      ingestContacts(c, s);

      // For unknowns (no phone-book name), use their WhatsApp display name (notify/pushName)
      // to backfill inbox messages that currently show as raw digits.
      for (const info of c) {
        if (!info.id?.endsWith("@s.whatsapp.net")) continue;
        const displayName: string | undefined = info.notify || info.verifiedName;
        if (!displayName || info.name) continue; // skip if saved in phone — phone name wins
        const digits = info.id.split("@")[0].replace(/\D/g, "");
        if (digits.length < 5) continue;
        await (prisma as any).inboxMessage.updateMany({
          where: {
            userId: s.userId,
            platform: "whatsapp",
            senderId: info.id,
            contactId: null,
            contactName: { in: [digits, info.id, info.id.replace(/@.+$/, "")] },
          },
          data: { contactName: displayName },
        }).catch(() => {});
      }

      // Auto-import contacts into CRM on first contacts.upsert after a fresh connect
      if (!s.autoImportDone && s.contactsCache.size > 0) {
        s.autoImportDone = true;
        try {
          const { queues } = await import("../lib/queues");
          const job = await prisma.importJob.create({
            data: { userId, source: "whatsapp_export", status: "running", startedAt: new Date() },
          });
          await queues.whatsappImport.add("whatsapp-import", { userId, importJobId: job.id });
          console.log(`[whatsapp] Auto-import triggered for user ${userId} (${s.contactsCache.size} contacts in cache)`);
        } catch (err) {
          console.error("[whatsapp] Failed to trigger auto-import:", err);
        }
      }
    });
    sock.ev.on("contacts.update", async (c: any[]) => {
      if (s.generation !== myGen) return;
      ingestContacts(c, s);
      // When phone address book names arrive (info.name), update CRM contact names
      // that were previously set from pushName (WhatsApp display name set by contact).
      for (const upd of c) {
        if (!upd.name || !upd.id?.endsWith("@s.whatsapp.net")) continue;
        const digits = upd.id.split("@")[0].replace(/\D/g, "");
        if (digits.length < 5) continue;
        try {
          const plat = await prisma.platform.findFirst({
            where: { type: "whatsapp", platformId: digits, contact: { userId: s.userId } },
            include: { contact: true },
          });
          if (!plat?.contact || plat.contact.name === upd.name) continue;
          // Only overwrite if current name looks like a pushName (underscores+digits)
          // vs the incoming name which is the phone-saved name.
          if (looksLikePushName(plat.contact.name) && !looksLikePushName(upd.name)) {
            await prisma.contact.update({ where: { id: plat.contact.id }, data: { name: upd.name } });
            await (prisma as any).inboxMessage.updateMany({
              where: { contactId: plat.contact.id },
              data: { contactName: upd.name },
            });
            invalidatePlatformCache(s.userId);
          }
        } catch {}
      }
    });

    // ── Live messages ─────────────────────────────────────────
    sock.ev.on("messages.upsert", async ({ messages: msgs, type }: any) => {
      if (s.generation !== myGen) return;
      console.log(`[whatsapp] messages.upsert: ${msgs?.length ?? 0} msgs, type=${type}`);
      // Process all messages in the batch concurrently — prevents one slow media
      // download from delaying unrelated messages in the same upsert batch
      await Promise.all(msgs.map(async (msg: any) => {
        try {
          // "Delete for everyone" arrives as a protocol message type=0 with a target key.
          // Only skip processMessage when both conditions are confirmed — otherwise fall
          // through so legitimate messages (including ones with a zeroed protocolMessage
          // from some Baileys versions) are still saved.
          const proto = msg.message?.protocolMessage;
          const revokedId = proto?.type === 0 ? proto?.key?.id : null;
          if (revokedId) {
            const result = await (prisma as any).inboxMessage.deleteMany({
              where: { platform: "whatsapp", externalId: revokedId },
            });
            if (result.count > 0) {
              console.log(`[whatsapp] Reflected deletion of ${revokedId}`);
              broadcastInboxEvent("message_deleted", { externalId: revokedId });
            }
            return;
          }
          await processMessage(msg, false, s);
        } catch (e) {
          console.error("[whatsapp] Message error:", e);
        }
      }));
    });

    // ── Status updates, revocations, deletions ───────────────
    sock.ev.on("messages.update", async (updates: any[]) => {
      if (s.generation !== myGen) return;
      for (const update of updates) {
        try {
          if (update.update?.message === null) {
            // Tombstone: message revoked
            const revokedId = update.key?.id;
            if (!revokedId) continue;
            const result = await (prisma as any).inboxMessage.deleteMany({
              where: { platform: "whatsapp", externalId: revokedId },
            });
            if (result.count > 0) {
              console.log(`[whatsapp] Reflected deletion (tombstone) of ${revokedId}`);
              broadcastInboxEvent("message_deleted", { externalId: revokedId });
            }
          } else if (update.update?.status !== undefined) {
            // Delivery/read status change
            const waStatus = waStatusString(update.update.status);
            const msgId = update.key?.id;
            if (waStatus && msgId) {
              await (prisma as any).inboxMessage.updateMany({
                where: { platform: "whatsapp", externalId: msgId },
                data: { waStatus },
              });
              broadcastInboxEvent("status_update", { externalId: msgId, waStatus });
            }
          }
        } catch {}
      }
    });

    // ── Typing / presence updates ─────────────────────────────
    sock.ev.on("presence.update", ({ id, presences }: any) => {
      if (s.generation !== myGen) return;
      try {
        const presence = presences?.[id];
        if (!presence) return;
        const typing = presence.lastKnownPresence === "composing" || presence.lastKnownPresence === "recording";
        broadcastInboxEvent("typing", { senderId: id, typing, userId: s.userId });
      } catch {}
    });

    // Handles direct message deletions/clears synced from the primary phone
    sock.ev.on("messages.delete", async (item) => {
      if (s.generation !== myGen) return;
      try {
        if ("keys" in item) {
          // Individual message deletions ("delete for me" or "delete for everyone")
          for (const key of item.keys) {
            if (key.id) {
              const result = await (prisma as any).inboxMessage.deleteMany({
                where: { platform: "whatsapp", externalId: key.id },
              });
              if (result.count > 0) {
                console.log(`[whatsapp] Reflected deletion (messages.delete) of ${key.id}`);
                broadcastInboxEvent("message_deleted", {});
              }
            }
          }
        } else if ("all" in item && item.all) {
          // "Clear chat" on primary phone — delete all messages for this conversation
          const jid: string = (item as any).jid ?? "";
          const phone = jid.replace(/@.+$/, "");
          if (!phone) return;

          // Delete by senderId (unknown contacts) + by contactId via platform record
          const platform = await prisma.platform.findFirst({
            where: { type: "whatsapp", platformId: { contains: phone } },
          });
          const deleted = await (prisma as any).inboxMessage.deleteMany({
            where: {
              platform: "whatsapp",
              OR: [
                { senderId: jid },
                { senderId: `${phone}@s.whatsapp.net` },
                ...(platform ? [{ contactId: platform.contactId }] : []),
              ],
            },
          });
          if (deleted.count > 0) {
            console.log(`[whatsapp] Clear-chat: removed ${deleted.count} messages for ${jid}`);
            broadcastInboxEvent("conversations_changed", {});
          }
        }
      } catch (e) {
        console.error("[whatsapp] Error handling messages.delete:", e);
      }
    });

    // Settle after 45s if neither QR nor connection arrived
    setTimeout(() => settle({ connected: false }), 45_000);
  });
}

// ── Public API ─────────────────────────────────────────────────────────────────
export const whatsappService = {
  async getStatus(userId: string) {
    const s = getSession(userId);
    if (s.connected) {
      return { connected: true, qrAvailable: !!s.qr, phoneNumber: s.phoneNumber, lastSync: null };
    }
    const saved = await (prisma as any).whatsAppSession
      .findFirst({ where: { userId, connected: true } })
      .catch(() => null);
    return {
      connected: !!(saved && fs.existsSync(getAuthDir(userId))),
      qrAvailable: !!s.qr,
      phoneNumber: saved?.phoneNumber ?? s.phoneNumber,
      lastSync: null,
    };
  },

  getQR(userId: string): string | null {
    return getSession(userId).qr;
  },

  async initSession(userId: string): Promise<{ qr?: string; connected: boolean }> {
    const s = getSession(userId);
    // Already connected as THIS user — nothing to do
    if (s.connected && s.userId === userId) return { connected: true };
    // Reconnecting for this same user — wait for it instead of spawning a second socket
    if (s.reconnecting) {
      try { await waitForConnection(40_000, s); } catch {}
      return { connected: s.connected, qr: s.qr ?? undefined };
    }
    // No session or not reconnecting — start a new connection
    return connectSocket(userId);
  },

  async ensureConnected(userId: string): Promise<void> {
    const s = getSession(userId);
    if (!s.connected) {
      const saved = await (prisma as any).whatsAppSession
        .findFirst({ where: { userId, connected: true }, select: { credsJson: true } })
        .catch(() => null);
      // Only give up if there are no credentials anywhere — neither in DB nor on disk
      if (!saved?.credsJson && !fs.existsSync(getAuthDir(userId))) {
        throw new Error("WhatsApp is not connected. Go to Settings → WhatsApp to connect.");
      }
      // Only start an immediate reconnect if there's no scheduled reconnect timer.
      // If s.reconnectTimer is set (e.g. 30s 440 backoff), let it fire — calling
      // connectSocket here would bypass the backoff and create a rapid-fire loop.
      if (!s.reconnecting && !s.sock && !s.reconnectTimer) {
        console.log("[whatsapp] Starting reconnect for pending send…");
        connectSocket(userId).catch(console.error);
      }
      try {
        await waitForConnection(5_000, s);
      } catch {
        throw new Error("WhatsApp is still reconnecting — please try again in a moment.");
      }
    }
    if (!s.sock) throw new Error("WhatsApp socket not initialized");
  },

  async sendMediaMessage(jid: string, filePath: string, caption: string | undefined, userId: string): Promise<unknown> {
    await whatsappService.ensureConnected(userId);
    const s = getSession(userId);
    const resolved = resolveJid(jid);
    if (!resolved) throw new Error(`Invalid WhatsApp JID: ${jid}`);
    console.log(`[whatsapp] Sending image to ${resolved}`);

    const imageBuffer = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const isVideo = [".mp4", ".mov", ".avi", ".mkv"].includes(ext);

    let result: unknown;
    try {
      if (isVideo) {
        result = await s.sock.sendMessage(resolved, { video: imageBuffer, caption: caption ?? "" });
      } else {
        result = await s.sock.sendMessage(resolved, { image: imageBuffer, caption: caption ?? "" });
      }
    } catch (sendErr) {
      if (!s.connected) {
        console.log("[whatsapp] Socket closed during send — waiting for reconnect before retry…");
        await waitForConnection(5_000, s);
        if (!s.sock) throw new Error("WhatsApp socket unavailable after reconnect");
        result = isVideo
          ? await s.sock.sendMessage(resolved, { video: imageBuffer, caption: caption ?? "" })
          : await s.sock.sendMessage(resolved, { image: imageBuffer, caption: caption ?? "" });
      } else {
        throw sendErr;
      }
    }

    const realId = (result as any)?.key?.id;
    if (realId) {
      sentCrmMessageIds.add(realId);
      setTimeout(() => sentCrmMessageIds.delete(realId), 120_000);
    }
    return result;
  },

  async sendReaction(jid: string, messageId: string, fromMe: boolean, emoji: string, userId: string): Promise<void> {
    await whatsappService.ensureConnected(userId);
    const s = getSession(userId);
    const resolved = resolveJid(jid);
    if (!resolved) throw new Error(`Invalid WhatsApp JID: ${jid}`);
    await s.sock.sendMessage(resolved, {
      react: { text: emoji, key: { remoteJid: resolved, fromMe, id: messageId } },
    });
  },

  async sendMessage(jid: string, text: string, userId: string, quoted?: any): Promise<unknown> {
    await whatsappService.ensureConnected(userId);
    const s = getSession(userId);

    const resolved = resolveJid(jid);
    if (!resolved) throw new Error(`Invalid WhatsApp JID: ${jid}`);
    console.log(`[whatsapp] Sending to ${resolved}`);

    // quoted must go in options (3rd arg), NOT inside the content object
    const opts = quoted ? { quoted } : undefined;

    let result: unknown;
    try {
      result = await s.sock.sendMessage(resolved, { text }, opts);
    } catch (sendErr) {
      // Socket may have dropped mid-send (e.g. 440 reconnect) — wait for next connection and retry once
      if (!s.connected) {
        console.log("[whatsapp] Socket closed during send — waiting for reconnect before retry…");
        await waitForConnection(5_000, s);
        if (!s.sock) throw new Error("WhatsApp socket unavailable after reconnect");
        result = await s.sock.sendMessage(resolved, { text }, opts);
      } else {
        throw sendErr;
      }
    }

    const realId = (result as any)?.key?.id;
    if (realId) {
      sentCrmMessageIds.add(realId);
      setTimeout(() => sentCrmMessageIds.delete(realId), 120_000);
    }

    return result;
  },

  async markAsRead(jid: string, userId: string): Promise<void> {
    const s = getSession(userId);
    if (!s?.connected || !s.sock) return;
    const resolved = resolveJid(jid) ?? jid;
    try {
      // Find the last inbound message from this chat to mark read up to that point
      const lastMsg = await (prisma as any).inboxMessage.findFirst({
        where: { platform: "whatsapp", senderId: resolved, fromMe: false },
        orderBy: { receivedAt: "desc" },
        select: { externalId: true },
      });
      if (!lastMsg?.externalId) return;
      await s.sock.readMessages([{ remoteJid: resolved, id: lastMsg.externalId, fromMe: false }]);
    } catch (e) {
      console.error("[whatsapp] markAsRead error:", e);
    }
  },

  async subscribePresence(jid: string, userId: string): Promise<void> {
    const s = getSession(userId);
    if (!s?.connected || !s.sock) return;
    const resolved = resolveJid(jid);
    if (!resolved) return;
    try {
      await s.sock.presenceSubscribe(resolved);
    } catch {}
  },

  async autoReconnect(): Promise<void> {
    // Reconnect ALL saved sessions — each user gets their own socket.
    // Fetch credsJson so we can reconnect even when Railway wipes the ephemeral filesystem.
    const savedSessions = await (prisma as any).whatsAppSession
      .findMany({ where: { connected: true }, select: { userId: true, credsJson: true } })
      .catch(() => []);

    for (const saved of savedSessions) {
      const uid: string = saved.userId;
      // Skip only if there's truly nothing to restore (no creds in DB and no auth dir on disk)
      if (!saved.credsJson && !fs.existsSync(getAuthDir(uid))) continue;

      const s = getSession(uid);
      if (s.connected || s.reconnecting) continue; // already running — skip

      console.log(`[whatsapp] Auto-reconnecting saved session for user ${uid}…`);
      connectSocket(uid).catch((e) => {
        console.error(`[whatsapp] Auto-reconnect error for user ${uid}:`, e);
      });
    }
  },

  async disconnect(userId: string): Promise<void> {
    const s = getSession(userId);
    if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }
    endSocketForLogout(s); // sends end() signal — proper logout, not a silent drop
    s.phoneNumber   = null;
    s.reconnectDelay = 0;
    sessions.delete(userId);
    try { fs.rmSync(getAuthDir(userId), { recursive: true, force: true }); } catch {}
    await (prisma as any).whatsAppSession.deleteMany({ where: { userId } }).catch(() => {});
    console.log("[whatsapp] Disconnected and session cleared.");
  },

  async importContacts(userId: string): Promise<{ imported: number; updated: number; skipped: number }> {
    const s = getSession(userId);
    if (!s.connected || !s.sock) {
      throw new Error("WhatsApp not connected. Connect it in Settings first.");
    }

    let imported = 0, updated = 0, skipped = 0;

    for (const [jid, info] of s.contactsCache.entries()) {
      try {
        if (
          jid.endsWith("@g.us") ||
          jid.endsWith("@broadcast") ||
          jid === "status@broadcast"
        ) { skipped++; continue; }

        const name = info.name || info.verifiedName || info.notify;
        if (!name) { skipped++; continue; }

        const phoneDigits = jidDigits(jid, s);
        if (phoneDigits.length < 5) { skipped++; continue; }

        const existing = await prisma.platform.findFirst({
          where: {
            OR: [
              { type: "whatsapp", platformId: phoneDigits },
              { type: "whatsapp", platformId: jid },
            ],
          },
        });
        if (existing) { updated++; continue; }

        await prisma.contact.create({
          data: {
            name,
            type: "other",
            domain: "other",
            relationshipStrength: "cold",
            platforms: {
              create: [{ type: "whatsapp", platformId: phoneDigits, displayName: name }],
            },
          },
        });
        imported++;
      } catch (e) {
        console.error(`[whatsapp-import] Skipped ${jid}:`, e);
        skipped++;
      }
    }

    return { imported, updated, skipped };
  },

  getSessionConnected(userId: string): boolean {
    const s = getSession(userId);
    return s.connected && !!s.sock;
  },

  // Serialize in-memory contacts cache for the import worker job payload
  getContactsForImport(userId: string): Array<{ jid: string; name: string; phoneDigits: string }> {
    const s = getSession(userId);
    const result: Array<{ jid: string; name: string; phoneDigits: string }> = [];
    for (const [jid, info] of s.contactsCache.entries()) {
      if (jid.endsWith("@g.us") || jid.endsWith("@broadcast") || jid === "status@broadcast") continue;
      // Only import contacts saved in the phone book (info.name).
      // Contacts only known by their WhatsApp display name (info.notify) are NOT saved in
      // the phone — they should appear in inbox but not become CRM contacts.
      const name = info.name || info.verifiedName;
      if (!name) continue;
      const phoneDigits = jidDigits(jid, s);
      if (phoneDigits.length < 5) continue;
      result.push({ jid, name, phoneDigits });
    }
    return result;
  },
};

// Fast send for the BullMQ retry worker.
// Throws immediately if not connected — no 35s wait — so BullMQ applies its own backoff.
export async function sendMessageQueued(userId: string, jid: string, text: string): Promise<{ keyId?: string }> {
  const s = getSession(userId);
  if (!s.connected || !s.sock) {
    throw new Error("WhatsApp not connected — retrying");
  }
  const resolved = resolveJid(jid) ?? jid;
  const result = await s.sock.sendMessage(resolved, { text });
  const keyId: string | undefined = (result as any)?.key?.id ?? undefined;
  if (keyId) {
    sentCrmMessageIds.add(keyId);
    setTimeout(() => sentCrmMessageIds.delete(keyId), 120_000);
  }
  return { keyId };
}
