import path from "path";
import fs from "fs";
// @ts-expect-error Could not find a declaration file for module 'async-lock'
import AsyncLock from "async-lock";
import { prisma } from "../lib/prisma";
import { inboxService } from "./inbox.service";
import { broadcastInboxEvent } from "./sse.service";

// Memory cache of WhatsApp message IDs sent from this CRM instance to avoid duplicates
export const sentCrmMessageIds = new Set<string>();

const fileLock = new AsyncLock({ maxPending: Infinity });

async function useRobustMultiFileAuthState(folder: string) {
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
        },
      },
    },
    saveCreds: () => {
      return writeData(creds, "creds.json");
    },
  };
}

const AUTH_DIR = path.join(process.cwd(), ".whatsapp-auth");
const LID_FILE  = path.join(AUTH_DIR, "lid-map.json");

// ── Runtime state ──────────────────────────────────────────────────────────────
const state: {
  sock: any | null;
  connected: boolean;
  qr: string | null;
  phoneNumber: string | null;
  userId: string | null;
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
} = {
  sock: null,
  connected: false,
  qr: null,
  phoneNumber: null,
  userId: null,
  reconnectTimer: null,
  reconnectDelay: 0,
  reconnecting: false,
  consecutive440s: 0,
  lastConnectedAt: 0,
  generation: 0,
};

// ── LID → phone mapping (persisted across restarts) ───────────────────────────
// Key: LID digits (no suffix), Value: phone digits (no suffix)
const lidMap = new Map<string, string>();

function loadLidMap(): void {
  try {
    if (fs.existsSync(LID_FILE)) {
      const raw = JSON.parse(fs.readFileSync(LID_FILE, "utf-8")) as Record<string, string>;
      for (const [k, v] of Object.entries(raw)) lidMap.set(k, v);
      console.log(`[whatsapp] Loaded ${lidMap.size} LID entries`);
    }
  } catch {}
}

function saveLidMap(): void {
  try {
    const obj: Record<string, string> = {};
    for (const [k, v] of lidMap.entries()) obj[k] = v;
    fs.writeFileSync(LID_FILE, JSON.stringify(obj));
  } catch {}
}

// ── Contacts cache (for importContacts + LID resolution) ─────────────────────
const contactsCache = new Map<string, any>();

// Messages that arrived before contacts.upsert populated the LID map — retried after sync
const pendingLidMessages: Array<{ msg: any; isHistorical: boolean }> = [];

function ingestContacts(contacts: any[]): void {
  let changed = false;
  for (const c of contacts) {
    if (c.id) contactsCache.set(c.id, c);
    // c.lid="<digits>@lid", c.id="<digits>@s.whatsapp.net" → build LID map
    if (c.lid && c.id?.endsWith("@s.whatsapp.net")) {
      const lid   = c.lid.split("@")[0];
      const phone = c.id.split("@")[0];
      if (lid && phone && lidMap.get(lid) !== phone) {
        lidMap.set(lid, phone);
        changed = true;
      }
    }
  }
  if (changed) {
    saveLidMap();
    // Retry messages that were dropped because the LID wasn't in the map yet
    if (pendingLidMessages.length > 0) {
      const pending = pendingLidMessages.splice(0);
      console.log(`[whatsapp] Retrying ${pending.length} buffered @lid message(s)…`);
      for (const { msg, isHistorical } of pending) {
        processMessage(msg, isHistorical).catch(() => {});
      }
    }
  }
}

// ── DB platform cache ─────────────────────────────────────────────────────────
type PlatformRow = { contactId: string; contactName: string; phoneDigits: string };
let platformCache: PlatformRow[] = [];
let platformCacheExpiry = 0;

async function getPlatforms(): Promise<PlatformRow[]> {
  if (Date.now() < platformCacheExpiry && platformCache.length > 0) return platformCache;
  const rows = await prisma.platform.findMany({
    where: { type: "whatsapp" },
    include: { contact: true },
  });
  platformCache = rows
    .filter((r) => r.contact)
    .map((r) => ({
      contactId: r.contact!.id,
      contactName: r.contact!.name,
      phoneDigits: r.platformId.replace(/\D/g, ""),
    }))
    .filter((r) => r.phoneDigits.length >= 5);
  platformCacheExpiry = Date.now() + 5 * 60 * 1000;
  return platformCache;
}

export function invalidatePlatformCache(): void {
  platformCacheExpiry = 0;
}

// ── JID helpers ───────────────────────────────────────────────────────────────

// Resolve any JID/phone to a sendable @s.whatsapp.net form
export function resolveJid(jid: string): string | null {
  if (!jid) return null;
  if (jid.endsWith("@g.us")) return jid;
  if (jid.endsWith("@s.whatsapp.net")) {
    const digits = jid.split("@")[0].replace(/\D/g, "");
    return digits ? `${digits}@s.whatsapp.net` : null;
  }
  if (jid.endsWith("@lid")) {
    const phone = lidMap.get(jid.split("@")[0]);
    if (phone) return `${phone}@s.whatsapp.net`;
    // Try contacts cache
    const cached = contactsCache.get(jid);
    if (cached?.id?.endsWith("@s.whatsapp.net")) return cached.id;
    return null;
  }
  const digits = jid.replace(/\D/g, "");
  return digits ? `${digits}@s.whatsapp.net` : null;
}

// Get phone digits from a JID (resolves @lid via map, then contactsCache)
function jidDigits(jid: string): string {
  if (jid.endsWith("@lid")) {
    const fromMap = lidMap.get(jid.split("@")[0]);
    if (fromMap) return fromMap;
    // Fallback: contactsCache may have the @s.whatsapp.net id before lidMap is saved
    const cached = contactsCache.get(jid);
    if (cached?.id?.endsWith("@s.whatsapp.net")) {
      return cached.id.split("@")[0].replace(/\D/g, "");
    }
    return "";
  }
  return jid.split("@")[0].replace(/\D/g, "");
}

// Match a JID to a CRM contact
async function resolveContact(
  jid: string,
  pushName?: string | null,
): Promise<{ contactId: string; contactName: string } | null> {
  const digits = jidDigits(jid);
  const platforms = await getPlatforms();

  if (digits.length >= 5) {
    const hit = platforms.find(
      (p) => digits.endsWith(p.phoneDigits) || p.phoneDigits.endsWith(digits),
    );
    if (hit) return { contactId: hit.contactId, contactName: hit.contactName };
  }

  // pushName fallback for unresolved @lid
  if (jid.endsWith("@lid") && !digits && pushName) {
    const norm = pushName.toLowerCase().trim();
    const hit = platforms.find((p) => {
      const n = p.contactName.toLowerCase().trim();
      return n === norm || norm.startsWith(n) || n.startsWith(norm);
    });
    if (hit) {
      console.log(`[whatsapp] LID matched via pushName "${pushName}" → ${hit.contactName}`);
      return { contactId: hit.contactId, contactName: hit.contactName };
    }
  }

  return null;
}

// ── Text extraction ────────────────────────────────────────────────────────────
function extractText(msg: any): string {
  const m = msg.message;
  if (!m) return "";
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.stickerMessage) return "[Sticker]";
  if (m.audioMessage) return "[Voice Note]";
  if (m.videoMessage) return m.videoMessage.caption || "[Video]";
  if (m.documentMessage) return m.documentMessage.caption || m.documentMessage.fileName || "[Document]";
  if (m.imageMessage) return m.imageMessage.caption || "[Image]";
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

async function downloadAndSaveMedia(msg: any): Promise<string | null> {
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
        reuploadRequest: state.sock?.updateMediaMessage?.bind(state.sock),
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
    const mediaDir = path.join(process.cwd(), "public", "media");
    await fs.promises.mkdir(mediaDir, { recursive: true });
    await fs.promises.writeFile(path.join(mediaDir, uniqueName), buffer);
    return `/media/${uniqueName}`;
  } catch (e) {
    console.error("[whatsapp] Media download failed:", e);
    return null;
  }
}

// ── Message processor ──────────────────────────────────────────────────────────
async function processMessage(msg: any, isHistorical = false): Promise<void> {
  const remoteJid: string = msg.key?.remoteJid ?? "";
  if (!remoteJid) return;
  if (
    remoteJid.endsWith("@g.us") ||
    remoteJid.endsWith("@broadcast") ||
    remoteJid === "status@broadcast"
  ) return;
  if (!msg.message) return;

  let text = extractText(msg);
  if (!text) return;

  const fromMe = !!msg.key.fromMe;
  if (fromMe && !isHistorical) {
    if (msg.key.id && sentCrmMessageIds.has(msg.key.id)) {
      return; // sent messages saved by inbox.service.reply, ignore the socket echo
    }
  }

  let contact = await resolveContact(remoteJid, msg.pushName);

  // For outgoing messages sent from the user's phone: resolveContact uses phone digits,
  // but pushName is null for outgoing so the name fallback never fires.
  // Look up the contact from previous inbox messages where this JID was the sender.
  if (!contact && fromMe && !isHistorical) {
    const prev = await (prisma as any).inboxMessage.findFirst({
      where: { platform: "whatsapp", senderId: remoteJid, contactId: { not: null }, fromMe: false },
    });
    if (prev?.contactId) {
      contact = { contactId: prev.contactId, contactName: prev.contactName };
      console.log(`[whatsapp] Resolved outgoing message via DB lookup → ${contact.contactName}`);
    }
  }

  if (!contact) {
    if (!isHistorical && remoteJid.endsWith("@lid")) {
      // LID map may not be populated yet — buffer and retry after contacts.upsert
      pendingLidMessages.push({ msg, isHistorical });
      console.log(`[whatsapp] Buffered @lid message (LID not yet resolved): ${remoteJid}`);
    } else if (!isHistorical) {
      console.log(`[whatsapp] No CRM contact for ${jidDigits(remoteJid) || remoteJid} (pushName: ${msg.pushName ?? "none"})`);
    }
    return;
  }

  // Download media for live messages and store as markdown so the inbox renders it
  if (!isHistorical) {
    const m = msg.message;
    const hasMedia = m?.imageMessage || m?.videoMessage || m?.audioMessage || m?.documentMessage || m?.stickerMessage;
    if (hasMedia) {
      const mediaUrl = await downloadAndSaveMedia(msg);
      if (mediaUrl) {
        const caption = m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption || "";
        const docName = m.documentMessage?.fileName || "file";
        if (m.imageMessage || m.stickerMessage) {
          text = caption ? `![${caption}](${mediaUrl})` : `![Image](${mediaUrl})`;
        } else if (m.videoMessage) {
          text = caption ? `![${caption}](${mediaUrl})` : `![Video](${mediaUrl})`;
        } else if (m.audioMessage) {
          text = `[Voice Note](${mediaUrl})`;
        } else {
          text = `[${docName}](${mediaUrl})`;
        }
      }
    }
  }

  await inboxService.upsert({
    platform: "whatsapp",
    externalId: msg.key.id ?? `wa-${remoteJid}-${msg.messageTimestamp}`,
    userId: state.userId ?? "default",
    contactId: contact.contactId,
    contactName: contact.contactName,
    senderId: remoteJid,
    preview: text.slice(0, 120),
    body: text,
    receivedAt: new Date((msg.messageTimestamp as number) * 1000),
    needsReply: !fromMe,
    fromMe,
  });
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
// We bump `state.generation` so any in-flight handlers from the old socket see a
// stale generation number and exit immediately instead of scheduling another reconnect.
function dropSocket(): void {
  state.generation++;
  if (state.sock) {
    try { state.sock.end(undefined); } catch {}
    try {
      if (state.sock.ws) {
        state.sock.ws.close();
        state.sock.sock?.destroy?.();
      }
    } catch {}
    state.sock = null;
  }
  state.connected = false;
  state.qr = null;
}

// Only used for explicit user-initiated logout — actually ends the WA session.
function endSocketForLogout(): void {
  state.generation++;
  if (state.sock) {
    try { state.sock.end(undefined); } catch {}
    state.sock = null;
  }
  state.connected = false;
  state.qr = null;
}

function scheduleReconnect(gen: number): void {
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  // Always wait at least 3 s to avoid racing WhatsApp's server-side cleanup.
  // Honour the delay already set by the 440 handler — don't double it here.
  const delay = Math.max(state.reconnectDelay, 3_000);
  console.log(`[whatsapp] Reconnecting in ${delay / 1000}s…`);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    state.reconnectDelay = 0; // reset after the wait
    // Only proceed if no newer socket has been created since this was scheduled
    if (state.generation === gen && state.userId && !state.connected) {
      connectSocket(state.userId).catch(console.error);
    }
  }, delay);
}

function waitForConnection(ms = 15_000): Promise<void> {
  if (state.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const poll = () => {
      if (state.connected) return resolve();
      if (Date.now() > deadline) return reject(new Error("timeout"));
      setTimeout(poll, 300);
    };
    poll();
  });
}

// ── Core: create socket and wire events ───────────────────────────────────────
async function connectSocket(userId: string): Promise<{ qr?: string; connected: boolean }> {
  // Safeguard: Check if AUTH_DIR exists but creds.json is corrupt/empty
  const credsFile = path.join(AUTH_DIR, "creds.json");
  if (fs.existsSync(credsFile)) {
    try {
      const stats = fs.statSync(credsFile);
      if (stats.size === 0) {
        console.warn("[whatsapp] creds.json is empty. Cleaning up auth directory.");
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        await (prisma as any).whatsAppSession.updateMany({
          where: { userId },
          data: { connected: false },
        }).catch(() => {});
      } else {
        const content = fs.readFileSync(credsFile, "utf-8");
        JSON.parse(content); // Test if valid JSON
      }
    } catch (e) {
      console.warn("[whatsapp] creds.json is corrupt. Cleaning up auth directory.");
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      await (prisma as any).whatsAppSession.updateMany({
        where: { userId },
        data: { connected: false },
      }).catch(() => {});
    }
  }

  // Bump generation FIRST, then drop old socket.
  // Any pending callbacks from the old socket will see a stale generation and no-op.
  dropSocket();
  state.reconnecting = true;

  const myGen = state.generation; // capture generation for this socket's lifetime

  const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
  } = await getBaileys();
  const { Boom } = await import("@hapi/boom");
  const pino = (await import("pino")).default;

  // Guard: another connectSocket may have started while we were awaiting getBaileys()
  if (state.generation !== myGen) return { connected: false };

  fs.mkdirSync(AUTH_DIR, { recursive: true });
  loadLidMap();

  const { state: authState, saveCreds } = await useRobustMultiFileAuthState(AUTH_DIR);

  // Guard again after the async auth-state load
  if (state.generation !== myGen) return { connected: false };

  let version: [number, number, number];
  try {
    const fetched = await fetchLatestBaileysVersion();
    version = fetched.version;
  } catch {
    version = [2, 3000, 1023625727];
    console.log("[whatsapp] Using fallback WA version");
  }

  if (state.generation !== myGen) return { connected: false };

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

  state.sock   = sock;
  state.userId = userId;

  return new Promise((resolve) => {
    let settled = false;
    const settle = (val: { qr?: string; connected: boolean }) => {
      if (!settled) { settled = true; state.reconnecting = false; resolve(val); }
    };

    // ── Connection state ──────────────────────────────────────
    sock.ev.on("connection.update", async (update: any) => {
      // If a newer socket has replaced this one, ignore all events from this socket
      if (state.generation !== myGen) return;

      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("[whatsapp] QR code ready. Go to Settings → WhatsApp to scan.");
        try {
          const QRCode = await import("qrcode");
          state.qr = await QRCode.toDataURL(qr);
        } catch {
          state.qr = qr;
        }
        settle({ qr: state.qr!, connected: false });
      }

      if (connection === "open") {
        state.connected    = true;
        state.lastConnectedAt = Date.now();
        state.qr           = null;
        state.phoneNumber  = sock.user?.id?.split(":")[0] ?? null;
        console.log(`[whatsapp] Connected as ${state.phoneNumber}`);
        try {
          await (prisma as any).whatsAppSession.upsert({
            where:  { userId },
            create: { userId, connected: true, phoneNumber: state.phoneNumber },
            update: { connected: true, phoneNumber: state.phoneNumber },
          });
        } catch (e) {
          console.error("[whatsapp] Failed to persist session:", e);
        }
        settle({ connected: true });
      }

      if (connection === "close") {
        state.connected = false;
        const code = (lastDisconnect?.error as InstanceType<typeof Boom>)?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut || code === 401;
        console.log(`[whatsapp] Disconnected — code=${code} loggedOut=${loggedOut}`);

        if (loggedOut) {
          try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
          await (prisma as any).whatsAppSession.deleteMany({ where: { userId } }).catch(() => {});
          console.log("[whatsapp] Logged out. Scan QR to reconnect.");
          settle({ connected: false });
        } else {
          settle({ connected: false });
          if (code === DisconnectReason.connectionReplaced || code === 440) {
            // 440 = another client (usually the phone) replaced this connection.
            // If we stayed connected < 5s, count it as a consecutive failure.
            const stayedMs = Date.now() - state.lastConnectedAt;
            if (stayedMs < 5_000) {
              state.consecutive440s++;
            } else {
              state.consecutive440s = 0; // stayed alive long enough — reset
            }
            // Exponential backoff: 10s → 20s → 40s → 60s cap
            // After 3+ fast 440s, use 60s to let the competing client stabilise
            const base = state.consecutive440s >= 3 ? 60_000 : 10_000 * Math.pow(2, Math.max(0, state.consecutive440s - 1));
            state.reconnectDelay = Math.min(base, 60_000);
            console.log(`[whatsapp] Connection replaced (440) — consecutive=${state.consecutive440s}, waiting ${state.reconnectDelay / 1000}s before reconnect`);
          } else {
            state.consecutive440s = 0;
            state.reconnectDelay = 0;
          }
          // Pass myGen so scheduleReconnect won't fire if a newer socket already exists
          scheduleReconnect(myGen);
        }
      }
    });

    // ── Credentials ───────────────────────────────────────────
    sock.ev.on("creds.update", saveCreds);

    // ── Historical messages ───────────────────────────────────
    sock.ev.on("messaging-history.set", async ({ messages: historicalMsgs, contacts }: any) => {
      if (state.generation !== myGen) return;
      if (contacts?.length) ingestContacts(contacts);
      if (!historicalMsgs?.length) return;
      console.log(`[whatsapp] Syncing ${historicalMsgs.length} historical messages…`);
      let saved = 0;
      for (const msg of historicalMsgs) {
        try { await processMessage(msg, true); saved++; } catch {}
      }
      console.log(`[whatsapp] History done — ${saved}/${historicalMsgs.length} saved`);
    });

    // ── Contact list updates (builds LID map) ────────────────
    sock.ev.on("contacts.upsert", (c: any[]) => { if (state.generation === myGen) ingestContacts(c); });
    sock.ev.on("contacts.update", (c: any[]) => { if (state.generation === myGen) ingestContacts(c); });

    // ── Live messages ─────────────────────────────────────────
    sock.ev.on("messages.upsert", async ({ messages: msgs }: any) => {
      if (state.generation !== myGen) return;
      for (const msg of msgs) {
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
            continue; // confirmed revoke — no need to run processMessage
          }
          await processMessage(msg);
        } catch (e) {
          console.error("[whatsapp] Message error:", e);
        }
      }
    });

    // ── Revocations / deletions ───────────────────────────────
    // Handles tombstones: Baileys sets message=null on the original when it's revoked
    sock.ev.on("messages.update", async (updates: any[]) => {
      if (state.generation !== myGen) return;
      for (const update of updates) {
        try {
          if (update.update?.message === null) {
            const revokedId = update.key?.id;
            if (!revokedId) continue;
            const result = await (prisma as any).inboxMessage.deleteMany({
              where: { platform: "whatsapp", externalId: revokedId },
            });
            if (result.count > 0) {
              console.log(`[whatsapp] Reflected deletion (tombstone) of ${revokedId}`);
              broadcastInboxEvent("message_deleted", { externalId: revokedId });
            }
          }
        } catch {}
      }
    });

    // Handles direct message deletions/clears synced from the primary phone
    sock.ev.on("messages.delete", async (item) => {
      if (state.generation !== myGen) return;
      try {
        if ("keys" in item) {
          for (const key of item.keys) {
            if (key.id) {
              const result = await (prisma as any).inboxMessage.deleteMany({
                where: { platform: "whatsapp", externalId: key.id },
              });
              if (result.count > 0) {
                console.log(`[whatsapp] Reflected deletion (messages.delete) of ${key.id}`);
                broadcastInboxEvent("message_deleted", { externalId: key.id });
              }
            }
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
    if (state.connected) {
      return { connected: true, qrAvailable: !!state.qr, phoneNumber: state.phoneNumber, lastSync: null };
    }
    const saved = await (prisma as any).whatsAppSession
      .findFirst({ where: { connected: true } })
      .catch(() => null);
    return {
      connected: !!(saved && fs.existsSync(AUTH_DIR)),
      qrAvailable: !!state.qr,
      phoneNumber: saved?.phoneNumber ?? state.phoneNumber,
      lastSync: null,
    };
  },

  getQR(): string | null {
    return state.qr;
  },

  async initSession(userId: string): Promise<{ qr?: string; connected: boolean }> {
    if (state.connected) return { connected: true };
    // If autoReconnect already started a socket, wait for it instead of creating a second one.
    // A second connectSocket would call dropSocket → bump generation → kill the first socket mid-handshake.
    if (state.reconnecting) {
      try { await waitForConnection(40_000); } catch {}
      return { connected: state.connected, qr: state.qr ?? undefined };
    }
    return connectSocket(userId);
  },

  async ensureConnected(): Promise<void> {
    if (!state.connected) {
      const saved = await (prisma as any).whatsAppSession
        .findFirst({ where: { connected: true } })
        .catch(() => null);
      if (!saved || !fs.existsSync(AUTH_DIR)) {
        throw new Error("WhatsApp is not connected. Go to Settings → WhatsApp to connect.");
      }
      if (!state.reconnecting && !state.sock) {
        console.log("[whatsapp] Starting reconnect for pending send…");
        const uid = state.userId ?? saved.userId;
        state.userId = uid;
        connectSocket(uid).catch(console.error);
      }
      try {
        await waitForConnection(35_000);
      } catch {
        throw new Error("WhatsApp is still reconnecting — please try again in a moment.");
      }
    }
    if (!state.sock) throw new Error("WhatsApp socket not initialized");
  },

  async sendMediaMessage(jid: string, filePath: string, caption?: string): Promise<unknown> {
    await whatsappService.ensureConnected();
    const resolved = resolveJid(jid);
    if (!resolved) throw new Error(`Invalid WhatsApp JID: ${jid}`);
    console.log(`[whatsapp] Sending image to ${resolved}`);

    const imageBuffer = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const isVideo = [".mp4", ".mov", ".avi", ".mkv"].includes(ext);

    let result: unknown;
    try {
      if (isVideo) {
        result = await state.sock.sendMessage(resolved, { video: imageBuffer, caption: caption ?? "" });
      } else {
        result = await state.sock.sendMessage(resolved, { image: imageBuffer, caption: caption ?? "" });
      }
    } catch (sendErr) {
      if (!state.connected) {
        console.log("[whatsapp] Socket closed during send — waiting for reconnect before retry…");
        await waitForConnection(35_000);
        if (!state.sock) throw new Error("WhatsApp socket unavailable after reconnect");
        result = isVideo
          ? await state.sock.sendMessage(resolved, { video: imageBuffer, caption: caption ?? "" })
          : await state.sock.sendMessage(resolved, { image: imageBuffer, caption: caption ?? "" });
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

  async sendReaction(jid: string, messageId: string, fromMe: boolean, emoji: string): Promise<void> {
    await whatsappService.ensureConnected();
    const resolved = resolveJid(jid);
    if (!resolved) throw new Error(`Invalid WhatsApp JID: ${jid}`);
    await state.sock.sendMessage(resolved, {
      react: { text: emoji, key: { remoteJid: resolved, fromMe, id: messageId } },
    });
  },

  async sendMessage(jid: string, text: string): Promise<unknown> {
    await whatsappService.ensureConnected();

    const resolved = resolveJid(jid);
    if (!resolved) throw new Error(`Invalid WhatsApp JID: ${jid}`);
    console.log(`[whatsapp] Sending to ${resolved}`);

    let result: unknown;
    try {
      result = await state.sock.sendMessage(resolved, { text });
    } catch (sendErr) {
      // Socket may have dropped mid-send (e.g. 440 reconnect) — wait for next connection and retry once
      if (!state.connected) {
        console.log("[whatsapp] Socket closed during send — waiting for reconnect before retry…");
        await waitForConnection(35_000);
        if (!state.sock) throw new Error("WhatsApp socket unavailable after reconnect");
        result = await state.sock.sendMessage(resolved, { text });
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

  async autoReconnect(): Promise<void> {
    if (state.connected || state.reconnecting) return;
    // Claim the reconnecting slot BEFORE the async DB query so that any concurrent
    // initSession call sees reconnecting=true and waits instead of spawning a second socket.
    state.reconnecting = true;
    const saved = await (prisma as any).whatsAppSession
      .findFirst({ where: { connected: true } })
      .catch(() => null);
    if (!saved || !fs.existsSync(AUTH_DIR)) {
      state.reconnecting = false; // nothing to reconnect — release the slot
      return;
    }
    console.log("[whatsapp] Auto-reconnecting saved session…");
    connectSocket(saved.userId).catch((e) => {
      state.reconnecting = false;
      console.error("[whatsapp] Auto-reconnect error:", e);
    });
  },

  async disconnect(userId: string): Promise<void> {
    if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
    endSocketForLogout(); // sends end() signal — proper logout, not a silent drop
    state.userId        = null;
    state.phoneNumber   = null;
    state.reconnectDelay = 0;
    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
    await (prisma as any).whatsAppSession.deleteMany({ where: { userId } }).catch(() => {});
    console.log("[whatsapp] Disconnected and session cleared.");
  },

  async importContacts(_userId: string): Promise<{ imported: number; updated: number; skipped: number }> {
    if (!state.connected || !state.sock) {
      throw new Error("WhatsApp not connected. Connect it in Settings first.");
    }

    let imported = 0, updated = 0, skipped = 0;

    for (const [jid, info] of contactsCache.entries()) {
      try {
        if (
          jid.endsWith("@g.us") ||
          jid.endsWith("@broadcast") ||
          jid === "status@broadcast"
        ) { skipped++; continue; }

        const name = info.name || info.verifiedName || info.notify;
        if (!name) { skipped++; continue; }

        const phoneDigits = jidDigits(jid);
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
};
