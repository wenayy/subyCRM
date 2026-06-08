import TelegramBot from "node-telegram-bot-api";
import OpenAI from "openai";
import { prisma } from "../lib/prisma";
import { inboxService } from "./inbox.service";
import { findSimilarContact } from "./dedup.service";

// Use global to survive hot-reloads in dev (prevents 409 Conflict)
const g = global as any;
let bot: TelegramBot | null = g.__telegramBot ?? null;
let _openai: OpenAI | null = null;
function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

async function getLinkedUser(chatId: number) {
  return (prisma as any).telegramBotLink.findUnique({ where: { chatId: String(chatId) } });
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface ParsedIntent {
  // Primary action. "note+reminder" means do both.
  action: "note" | "reminder" | "note+reminder" | "strength" | "new_contact" | "self_reminder" | "unknown";
  contactId: string | null;
  contactName: string | null;
  noteContent: string | null;      // content for the note (if action includes note)
  reminderContent: string | null;  // content for the reminder (if action includes reminder)
  dueDate: string | null;          // ISO datetime string, user's local time
  strength: "hot" | "warm" | "cold" | null;
  inferredRole: string | null;
  inferredCompany: string | null;
}

export interface CaptureResult {
  id: string;
  transcript: string;
  contactId: string | null;
  contactName: string | null;
  action: string;
  content: string | null;
  dueDate: string | null;
  strength: string | null;
  status: "processed" | "failed";
  processingMs: number;
  replyMessage: string;
}

// ── Transcribe via Whisper ────────────────────────────────────────────────────
async function transcribe(fileId: string): Promise<string> {
  const url = await bot!.getFileLink(fileId);
  const res = await fetch(url);
  const buffer = Buffer.from(await res.arrayBuffer());
  const file = new File([buffer], "voice.ogg", { type: "audio/ogg" });
  const result = await getOpenAI().audio.transcriptions.create({ file, model: "whisper-1", language: "en" });
  return result.text.trim();
}

// ── Parse intent with GPT-4o-mini ─────────────────────────────────────────────
async function parseIntent(text: string, userId: string): Promise<ParsedIntent> {
  const contacts = await prisma.contact.findMany({
    where: { userId },
    select: { id: true, name: true },
    orderBy: { lastContactDate: "desc" },
    take: 300,
  });
  const contactList = contacts.map((c) => `${c.name} — id:${c.id}`).join("\n");
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const timeNow = now.toTimeString().slice(0, 5);

  const system = `You are a smart CRM voice assistant for a founder. Parse voice notes into structured actions.
Today is ${today}, current time is ${timeNow} (use this to resolve relative times like "at 4pm" = today at 16:00, "tomorrow" = next day).

Known contacts:
${contactList}

Return ONLY valid JSON:
{
  "action": "note" | "reminder" | "note+reminder" | "strength" | "new_contact" | "self_reminder" | "unknown",
  "contactId": "<exact id from list, or null>",
  "contactName": "<matched or extracted name, or null>",
  "noteContent": "<concise note text, or null>",
  "reminderContent": "<concise reminder task text, or null>",
  "dueDate": "<ISO datetime like ${today}T16:00:00 or null>",
  "strength": "hot" | "warm" | "cold" | null,
  "inferredRole": "<job title if mentioned, else null>",
  "inferredCompany": "<company name if mentioned, else null>"
}

Action rules — be decisive, lean toward action over "unknown":
- "note": log info about an existing contact (meeting, call, update about them)
- "reminder": ONLY a reminder for an existing contact, no note needed
- "note+reminder": BOTH log info AND set a reminder for same contact (e.g. "met Yogesh, remind me to follow up Friday")
- "strength": update relationship warmth (hot/warm/cold) for existing contact
- "new_contact": person mentioned but NOT in the known list — extract details, contactId=null
- "self_reminder": reminder with NO specific contact (e.g. "remind me to check email at 3pm", "remind me to review the deck tonight")
- "unknown": truly unclear, no actionable intent at all

Reminder detection — if the user says ANY of these, it is a reminder:
  "remind me", "set a reminder", "follow up", "call [name] at", "meeting at", "don't forget", "reminder for"

Time parsing:
- "at 4pm" / "at 4" = today ${today}T16:00:00
- "tomorrow at X" = next day at X
- "on Friday" = next Friday at 09:00
- "tonight" = today at 20:00
- No time given → tomorrow at 09:00

Contact matching: fuzzy match names, ignore case. If someone says "Yogesh" and "Yogesh" is in the list, match it.
Keep noteContent and reminderContent concise (1 sentence max).`;

  const completion = await getOpenAI().chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "system", content: system }, { role: "user", content: text }],
    response_format: { type: "json_object" },
    temperature: 0.1,
  });

  return JSON.parse(completion.choices[0].message.content ?? "{}") as ParsedIntent;
}

// ── Core: process a transcript → DB writes → return result ───────────────────
async function getUserIdForChat(chatId: number): Promise<string> {
  const link = await (prisma as any).telegramBotLink.findUnique({
    where: { chatId: String(chatId) },
    select: { userId: true },
  });
  if (link) return link.userId;
  // Fall back to first registered user if no link exists
  const user = await prisma.user.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
  return user?.id ?? "default";
}

function parseDueDate(raw: string | null): Date {
  if (raw) {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) return d;
  }
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}

function fmtDue(d: Date): string {
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: true });
}

export async function processVoiceCapture(transcript: string, chatId?: number): Promise<CaptureResult> {
  const startMs = Date.now();
  const userId = chatId ? await getUserIdForChat(chatId) : await getUserIdForChat(0);

  let intent: ParsedIntent;
  try {
    intent = await parseIntent(transcript, userId);
    console.log("[voice] intent:", JSON.stringify(intent));
  } catch (err) {
    const cap = await (prisma as any).voiceCapture.create({
      data: { userId, transcript, action: "unknown", status: "failed", processingMs: Date.now() - startMs },
    });
    return { ...cap, replyMessage: "❌ Failed to parse intent. Try again.", dueDate: cap.dueDate?.toISOString() ?? null };
  }

  const processingMs = Date.now() - startMs;
  let replyMessage = "";

  // ── Unknown ───────────────────────────────────────────────────────────────
  if (intent.action === "unknown") {
    const cap = await (prisma as any).voiceCapture.create({
      data: { userId, transcript, contactName: null, action: "unknown", content: null, status: "processed", processingMs },
    });
    replyMessage = `❓ No action detected.\n\n_"${transcript}"_\n\nExamples:\n• _"Met Yogesh, great call, remind me to follow up Friday"_\n• _"Remind me to call Rahul at 4pm"_\n• _"Remind me to check the deck tonight"_\n• _"Just met Priya from Sequoia, she's a partner"_`;
    return { ...cap, replyMessage, dueDate: null };
  }

  // ── Self-reminder (no contact needed) ────────────────────────────────────
  if (intent.action === "self_reminder") {
    const content = intent.reminderContent ?? intent.noteContent ?? transcript;
    const dueDate = parseDueDate(intent.dueDate);
    await (prisma as any).reminder.create({ data: { content, dueDate } });
    const cap = await (prisma as any).voiceCapture.create({
      data: { userId, transcript, contactId: null, contactName: null, action: "reminder", content, dueDate, status: "processed", processingMs },
    });
    replyMessage = `⏰ *Reminder set*\n_"${content}"_\n📅 ${fmtDue(dueDate)}`;
    return { ...cap, replyMessage, dueDate: dueDate.toISOString() };
  }

  // ── Resolve contact (existing or new) ────────────────────────────────────
  let contact = intent.contactId ? await prisma.contact.findUnique({ where: { id: intent.contactId } }) : null;

  // GPT sometimes returns null contactId even for known contacts — fuzzy match as fallback
  if (!contact && intent.contactName) {
    const fuzzy = await findSimilarContact(intent.contactName, userId);
    if (fuzzy) contact = await prisma.contact.findUnique({ where: { id: fuzzy.id } });
  }

  let isNewContact = false;
  if (!contact && intent.contactName) {
    // Create new contact
    contact = await prisma.contact.create({
      data: {
        userId, name: intent.contactName,
        role: intent.inferredRole ?? undefined,
        company: intent.inferredCompany ?? undefined,
        type: "other", domain: "other", relationshipStrength: "cold",
        firstContactDate: new Date(), lastContactDate: new Date(),
      },
    });
    isNewContact = true;
  }

  if (!contact) {
    const cap = await (prisma as any).voiceCapture.create({
      data: { userId, transcript, action: "unknown", status: "failed", processingMs },
    });
    replyMessage = `❓ Couldn't find or create the contact. Try mentioning their name clearly.`;
    return { ...cap, replyMessage, dueDate: null };
  }

  const contactId = contact.id;
  const contactName = contact.name;
  const lines: string[] = [];
  let savedDueDate: Date | null = null;

  if (isNewContact) {
    const detail = [intent.inferredRole, intent.inferredCompany].filter(Boolean).join(" @ ");
    lines.push(`👤 *New contact:* ${contact.name}${detail ? `\n_${detail}_` : ""}`);
  } else {
    lines.push(`🔗 *${contact.name}*`);
  }

  // ── Note ─────────────────────────────────────────────────────────────────
  const needsNote = intent.action === "note" || intent.action === "note+reminder";
  if (needsNote && intent.noteContent) {
    await prisma.note.create({ data: { contactId: contact.id, content: intent.noteContent } });
    await prisma.contact.update({ where: { id: contact.id }, data: { lastContactDate: new Date() } });
    lines.push(`📝 Note: _"${intent.noteContent}"_`);
  }

  // ── Reminder ─────────────────────────────────────────────────────────────
  const needsReminder = intent.action === "reminder" || intent.action === "note+reminder";
  if (needsReminder) {
    const content = intent.reminderContent ?? intent.noteContent ?? transcript;
    const dueDate = parseDueDate(intent.dueDate);
    savedDueDate = dueDate;
    await prisma.reminder.create({ data: { contactId: contact.id, content, dueDate } });
    lines.push(`⏰ Reminder: _"${content}"_\n📅 ${fmtDue(dueDate)}`);
  }

  // ── Strength ─────────────────────────────────────────────────────────────
  if (intent.action === "strength" && intent.strength) {
    await prisma.contact.update({ where: { id: contact.id }, data: { relationshipStrength: intent.strength } });
    const emoji = intent.strength === "hot" ? "🔥" : intent.strength === "warm" ? "☀️" : "🧊";
    lines.push(`${emoji} Marked as *${intent.strength}*`);
  }

  const content = intent.noteContent ?? intent.reminderContent ?? null;
  const action = isNewContact ? "new_contact" : intent.action;
  const cap = await (prisma as any).voiceCapture.create({
    data: { userId, transcript, contactId, contactName, action, content, dueDate: savedDueDate, status: "processed", processingMs },
  });

  replyMessage = lines.join("\n");
  return { ...cap, replyMessage, dueDate: savedDueDate?.toISOString() ?? null };
}

// ── Bot message handler ───────────────────────────────────────────────────────
async function handleMessage(msg: TelegramBot.Message) {
  const chatId = msg.chat.id;
  const send = (text: string) => bot!.sendMessage(chatId, text, { parse_mode: "Markdown" });

  // ── Account linking (manual code OR /start deep link) ────
  const linkPayload = msg.text?.match(/^LINK-[A-F0-9]{8}$/i)
    ? msg.text.trim().toUpperCase()
    : msg.text?.match(/^\/start (LINK-[A-F0-9]{8})$/i)?.[1]?.toUpperCase() ?? null;

  if (linkPayload) {
    const token = linkPayload;
    const record = await (prisma as any).telegramBotLinkToken.findUnique({ where: { token } });
    if (!record) {
      await send("❌ Invalid or expired code. Generate a new one in Settings → Voice Bot.");
      return;
    }
    if (new Date(record.expiresAt) < new Date()) {
      await (prisma as any).telegramBotLinkToken.delete({ where: { token } });
      await send("❌ Code expired. Generate a new one in Settings → Voice Bot.");
      return;
    }
    await (prisma as any).telegramBotLink.upsert({
      where: { userId: record.userId },
      create: { userId: record.userId, chatId: String(chatId) },
      update: { chatId: String(chatId) },
    });
    await (prisma as any).telegramBotLinkToken.delete({ where: { token } });
    await send("✅ *Linked\\!* Your Suby CRM account is now connected to this Telegram account\\.");
    await send(`🚀 You're all set\\! Send me a *voice note* or *text*:\n• _"Had a great call with Lena, she's in for the round"_\n• _"Remind me to follow up with Marc on Friday"_\n• _"Mark Sophie as hot"_\n• _"Just met Thomas from Sequoia, he's a partner"_\n\nI'll log it straight into Suby CRM\\.`);
    return;
  }

  if (msg.text === "/start") {
    console.log(`[telegram-bot] /start from chatId=${chatId}`);
    const isLinked = await (prisma as any).telegramBotLink.findUnique({ where: { chatId: String(chatId) } });
    if (isLinked) {
      await send(`✅ Already linked\\! Send me a *voice note* or *text*:\n• _"Had a great call with Lena, she's in for the round"_\n• _"Remind me to follow up with Marc on Friday"_\n• _"Mark Sophie as hot"_\n• _"Just met Thomas from Sequoia, he's a partner"_\n\nI'll log it straight into Suby CRM\\. 🚀`);
    } else {
      await send("👋 Hey\\! I'm *subyassistant\\_bot*\\.\n\nTo link your account, go to *Settings → Voice Assistant* in the Suby CRM app and click *Connect your account*\\.");
    }
    return;
  }

  // Require a linked account for all commands beyond /start and linking
  const linked = await getLinkedUser(chatId);
  if (!linked) {
    await send("🔒 Your Telegram is not linked to a Suby CRM account.\n\nGo to *Settings → Voice Assistant* and click *Connect your account* to link.");
    return;
  }

  let transcript: string;
  if (msg.voice) {
    await send("🎙️ Transcribing…");
    try {
      transcript = await transcribe(msg.voice.file_id);
      console.log(`[telegram-bot] transcript: "${transcript}"`);
    } catch {
      await send("❌ Transcription failed. Try again."); return;
    }
  } else if (msg.text && !msg.text.startsWith("/")) {
    transcript = msg.text;
    const userId = await getUserIdForChat(chatId);
    const senderName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || msg.from?.username || String(chatId);
    const contact = await prisma.contact.findFirst({
      where: { userId, name: { contains: senderName.split(" ")[0], mode: "insensitive" } },
    });
    if (contact) {
      await inboxService.upsert({
        platform: "telegram",
        externalId: `bot-${msg.message_id}`,
        contactId: contact.id,
        contactName: contact.name,
        senderId: String(chatId),
        preview: msg.text.slice(0, 120),
        body: msg.text,
        receivedAt: new Date(msg.date * 1000),
        needsReply: true,
      }).catch(() => {});
    }
  } else {
    return;
  }

  await send(`📝 _"${transcript}"_\n\n⏳ Processing…`);
  try {
    const result = await processVoiceCapture(transcript, chatId);
    await send(result.replyMessage);
  } catch (err) {
    console.error("[telegram-bot] processVoiceCapture failed:", err);
    await send("❌ Processing failed. Try again.");
  }
}

// ── Start / stop ──────────────────────────────────────────────────────────────
export function startBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { console.warn("[telegram-bot] TELEGRAM_BOT_TOKEN not set — bot disabled"); return; }

  if (g.__telegramBot) {
    console.log("[telegram-bot] already running — reusing existing instance");
    bot = g.__telegramBot;
    return;
  }

  bot = new TelegramBot(token, { polling: { interval: 2000, params: { timeout: 0 } } });
  g.__telegramBot = bot;
  console.log("[telegram-bot] polling started");

  bot.on("voice", handleMessage);
  bot.on("message", (msg: TelegramBot.Message) => { if (!msg.voice) handleMessage(msg); });
  bot.on("polling_error", (err: Error) => console.error("[telegram-bot] polling error:", err.message));
}

export function stopBot() { bot?.stopPolling(); bot = null; g.__telegramBot = null; }

let _cachedUsername: string | null = null;
export async function getBotUsername(): Promise<string> {
  if (_cachedUsername) return _cachedUsername;
  if (bot) {
    try {
      const me = await bot.getMe();
      _cachedUsername = me.username ?? "subyassistant_bot";
      return _cachedUsername;
    } catch {}
  }
  return "subyassistant_bot";
}

export async function sendBotReply(chatId: string, text: string): Promise<void> {
  if (!bot) throw new Error("Telegram bot not running");

  const { parseMediaMarkdown } = await import("./inbox.service");
  const media = parseMediaMarkdown(text);

  if (media) {
    const fs = await import("fs");
    const path = await import("path");
    const ext = path.extname(media.filePath).toLowerCase();
    const imageBuffer = fs.readFileSync(media.filePath);

    const isVideo = [".mp4", ".mov", ".avi", ".mkv"].includes(ext);
    const isImage = [".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext);

    if (isImage) {
      await bot.sendPhoto(Number(chatId), imageBuffer, { caption: media.caption || undefined });
    } else if (isVideo) {
      await bot.sendVideo(Number(chatId), imageBuffer, { caption: media.caption || undefined });
    } else {
      await bot.sendDocument(
        Number(chatId),
        imageBuffer,
        { caption: media.caption || undefined },
        { filename: path.basename(media.filePath) }
      );
    }
  } else {
    await bot.sendMessage(Number(chatId), text);
  }
}
