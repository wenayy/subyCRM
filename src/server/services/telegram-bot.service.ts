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
  action: "note" | "reminder" | "strength" | "new_contact" | "unknown";
  contactId: string | null;
  contactName: string | null;
  content: string;
  dueDate: string | null;
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
async function parseIntent(text: string): Promise<ParsedIntent> {
  const contacts = await prisma.contact.findMany({
    select: { id: true, name: true },
    orderBy: { name: "asc" },
    take: 200,
  });
  const contactList = contacts.map((c) => `${c.name} — id:${c.id}`).join("\n");
  const today = new Date().toISOString().slice(0, 10);

  const system = `You are a CRM assistant for a founder's personal CRM.
Today is ${today}.

Your job: parse a voice-note transcript into one structured action.

Known contacts:
${contactList}

Return ONLY valid JSON (no markdown):
{
  "action": "note" | "reminder" | "strength" | "new_contact" | "unknown",
  "contactId": "<id from list above, or null>",
  "contactName": "<matched or extracted name>",
  "content": "<concise note/reminder text>",
  "dueDate": "<ISO datetime like 2026-06-03T09:00:00 or null>",
  "strength": "hot" | "warm" | "cold" | null,
  "inferredRole": "<job title if mentioned, else null>",
  "inferredCompany": "<company name if mentioned, else null>"
}

Rules:
- "note": log something about an EXISTING contact (contactId found in list)
- "reminder": set a follow-up task for an EXISTING contact
- "strength": update relationship warmth for an EXISTING contact
- "new_contact": person clearly mentioned but NOT in the list — extract name/role/company, set contactId to null
- "unknown": no person mentioned, or no clear action
- Match existing contacts by name similarity (fuzzy is fine)
- For reminders without a time, default to 09:00
- Keep content short (1-2 sentences max)`;

  const completion = await getOpenAI().chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "system", content: system }, { role: "user", content: text }],
    response_format: { type: "json_object" },
    temperature: 0.2,
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

export async function processVoiceCapture(transcript: string, chatId?: number): Promise<CaptureResult> {
  const startMs = Date.now();
  const userId = chatId ? await getUserIdForChat(chatId) : await getUserIdForChat(0);

  let intent: ParsedIntent;
  try {
    intent = await parseIntent(transcript);
    console.log("[voice] intent:", intent);
  } catch (err) {
    const cap = await (prisma as any).voiceCapture.create({
      data: { userId, transcript, action: "unknown", status: "failed", processingMs: Date.now() - startMs },
    });
    return { ...cap, replyMessage: "❌ Failed to parse intent. Try again.", dueDate: cap.dueDate?.toISOString() ?? null };
  }

  const processingMs = Date.now() - startMs;
  let contactId: string | null = null;
  let contactName: string | null = intent.contactName;
  let replyMessage = "";

  // ── Unknown ───────────────────────────────────────────────
  if (intent.action === "unknown") {
    const cap = await (prisma as any).voiceCapture.create({
      data: { userId, transcript, contactName: null, action: "unknown", content: null, status: "processed", processingMs },
    });
    replyMessage = `❓ No action detected.\n\n_"${transcript}"_\n\nTry: _"Met John from Stripe, he's the CTO"_ or _"Remind me to call Sarah on Friday"_`;
    return { ...cap, createdAt: undefined, replyMessage, dueDate: null };
  }

  // ── Auto-create new contact (with dedup check) ───────────
  if (intent.action === "new_contact" || (!intent.contactId && intent.contactName)) {
    if (!intent.contactName) {
      const cap = await (prisma as any).voiceCapture.create({
        data: { userId, transcript, action: "unknown", status: "failed", processingMs },
      });
      replyMessage = `❓ Couldn't extract a name. Try mentioning their name clearly.`;
      return { ...cap, replyMessage, dueDate: null };
    }

    // Check if a similar contact already exists to avoid duplicates
    const existing = await findSimilarContact(intent.contactName, userId);
    if (existing) {
      contactId = existing.id;
      contactName = existing.name;
      if (intent.content) {
        await prisma.note.create({ data: { contactId: existing.id, content: intent.content } });
      }
      const cap = await (prisma as any).voiceCapture.create({
        data: { userId, transcript, contactId, contactName, action: "note", content: intent.content ?? null, status: "processed", processingMs },
      });
      replyMessage = `🔗 *Matched existing contact:* ${existing.name}${intent.content ? `\n✅ Note: _"${intent.content}"_` : ""}`;
      return { ...cap, replyMessage, dueDate: null };
    }

    const newContact = await prisma.contact.create({
      data: {
        userId,
        name: intent.contactName,
        role: intent.inferredRole ?? undefined,
        company: intent.inferredCompany ?? undefined,
        type: "other", domain: "other",
        relationshipStrength: "cold",
        firstContactDate: new Date(), lastContactDate: new Date(),
      },
    });
    contactId = newContact.id;
    contactName = newContact.name;
    const detailLine = [intent.inferredRole, intent.inferredCompany].filter(Boolean).join(" @ ");

    if (intent.content) {
      await prisma.note.create({ data: { contactId: newContact.id, content: intent.content } });
    }

    const cap = await (prisma as any).voiceCapture.create({
      data: { userId, transcript, contactId, contactName, action: "new_contact", content: intent.content ?? null, status: "processed", processingMs },
    });
    replyMessage = `👤 *New contact:* ${newContact.name}${detailLine ? `\n_${detailLine}_` : ""}${intent.content ? `\n✅ Note: _"${intent.content}"_` : ""}`;
    return { ...cap, replyMessage, dueDate: null };
  }

  // ── Existing contact ──────────────────────────────────────
  const contact = await prisma.contact.findUnique({ where: { id: intent.contactId! } });
  if (!contact) {
    const cap = await (prisma as any).voiceCapture.create({
      data: { userId, transcript, action: "unknown", status: "failed", processingMs },
    });
    replyMessage = `❓ Contact not found. Try again.`;
    return { ...cap, replyMessage, dueDate: null };
  }
  contactId = contact.id;
  contactName = contact.name;

  if (intent.action === "note") {
    await prisma.note.create({ data: { contactId: contact.id, content: intent.content } });
    await prisma.contact.update({ where: { id: contact.id }, data: { lastContactDate: new Date() } });
    const cap = await (prisma as any).voiceCapture.create({
      data: { userId, transcript, contactId, contactName, action: "note", content: intent.content, status: "processed", processingMs },
    });
    replyMessage = `✅ *Note saved* for *${contact.name}*\n_"${intent.content}"_`;
    return { ...cap, replyMessage, dueDate: null };
  }

  if (intent.action === "reminder") {
    const dueDate = intent.dueDate ? new Date(intent.dueDate) : (() => {
      const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d;
    })();
    await prisma.reminder.create({ data: { contactId: contact.id, content: intent.content, dueDate } });
    const cap = await (prisma as any).voiceCapture.create({
      data: { userId, transcript, contactId, contactName, action: "reminder", content: intent.content, dueDate, status: "processed", processingMs },
    });
    const when = dueDate.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    replyMessage = `⏰ *Reminder set* for *${contact.name}*\n_"${intent.content}"_\n📅 ${when}`;
    return { ...cap, replyMessage, dueDate: dueDate.toISOString() };
  }

  if (intent.action === "strength" && intent.strength) {
    await prisma.contact.update({ where: { id: contact.id }, data: { relationshipStrength: intent.strength } });
    const cap = await (prisma as any).voiceCapture.create({
      data: { userId, transcript, contactId, contactName, action: "strength", content: `Marked as ${intent.strength}`, strength: intent.strength, status: "processed", processingMs },
    });
    const emoji = intent.strength === "hot" ? "🔥" : intent.strength === "warm" ? "☀️" : "🧊";
    replyMessage = `${emoji} *${contact.name}* marked as *${intent.strength}*`;
    return { ...cap, replyMessage, dueDate: null };
  }

  const cap = await (prisma as any).voiceCapture.create({
    data: { userId, transcript, contactId, contactName, action: "unknown", status: "failed", processingMs },
  });
  replyMessage = `❓ Couldn't determine action.`;
  return { ...cap, replyMessage, dueDate: null };
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
    await send("✅ *Linked!* Your Suby CRM account is now connected to this Telegram account. Send voice notes to log contacts.");
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
