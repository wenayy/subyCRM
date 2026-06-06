import { Worker, Job } from "bullmq";
import { redis } from "../lib/redis";
import { QUEUE_NAMES, DEFAULT_JOB_OPTIONS } from "../lib/queues";
import { prisma } from "../lib/prisma";
import { sendBotReply } from "../services/telegram-bot.service";

export interface OutcomePromptJobData {
  contactId: string;
  eventId: string;
}

export function startOutcomePromptWorker() {
  const worker = new Worker<OutcomePromptJobData>(
    QUEUE_NAMES.OUTCOME_PROMPT,
    async (job: Job<OutcomePromptJobData>) => {
      const { contactId, eventId } = job.data;

      // Fetch event and contact in parallel
      const [event, contact] = await Promise.all([
        prisma.calendarEvent.findUnique({ where: { id: eventId } }),
        prisma.contact.findUnique({
          where: { id: contactId },
          select: { name: true },
        }),
      ]);

      if (!event) {
        console.warn(`[outcome-prompt] Event ${eventId} not found — skipping`);
        return null;
      }

      const contactName = contact?.name ?? event.contactName ?? "your contact";
      const eventTitle = event.title;

      const message =
        `🗓️ *How did it go?*\n\n` +
        `You just had: _${eventTitle}_ with *${contactName}*.\n\n` +
        `Quick voice note or reply:\n` +
        `• _"It went great, they're interested in..."_\n` +
        `• _"Set a reminder to follow up in 2 weeks"_\n` +
        `• _"Mark ${contactName} as hot"_`;

      const allowedChatIds = (process.env.TELEGRAM_ALLOWED_CHAT_IDS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      if (allowedChatIds.length === 0) {
        console.warn("[outcome-prompt] No TELEGRAM_ALLOWED_CHAT_IDS configured — cannot send prompt");
        return { sent: false, reason: "No chat IDs configured" };
      }

      const chatId = allowedChatIds[0];
      await sendBotReply(chatId, message);

      console.log(`[outcome-prompt] Sent outcome prompt for event=${eventId} contact=${contactId}`);
      return { sent: true, chatId, contactName, eventTitle };
    },
    {
      connection: redis.connection,
      concurrency: 2,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    },
  );

  worker.on("failed", (job, err) => {
    console.error(`[outcome-prompt] job ${job?.id} failed:`, err.message);
  });

  return worker;
}
