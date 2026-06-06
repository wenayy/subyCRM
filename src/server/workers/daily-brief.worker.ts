import { Worker, Job } from "bullmq";
import { redis } from "../lib/redis";
import { QUEUE_NAMES, DEFAULT_JOB_OPTIONS } from "../lib/queues";
import { prisma } from "../lib/prisma";
import { sendBotReply } from "../services/telegram-bot.service";

export interface DailyBriefJobData {
  userId: string;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

export function startDailyBriefWorker() {
  const worker = new Worker<DailyBriefJobData>(
    QUEUE_NAMES.DAILY_BRIEF,
    async (job: Job<DailyBriefJobData>) => {
      const { userId } = job.data;

      const now = new Date();
      const todayStart = new Date(now);
      todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date(now);
      todayEnd.setHours(23, 59, 59, 999);
      const fourteenDaysAgo = new Date(now.getTime() - 14 * 86400_000);
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400_000);

      // Gather data in parallel
      const [staleVCs, overdueReminders, todayEvents] = await Promise.all([
        prisma.contact.findMany({
          where: {
            type: "vc",
            lastContactDate: { lt: thirtyDaysAgo },
          },
          orderBy: { lastContactDate: "asc" },
          take: 5,
          select: { id: true, name: true, lastContactDate: true, company: true },
        }),
        prisma.reminder.findMany({
          where: {
            status: "pending",
            dueDate: { lte: now },
          },
          include: { contact: { select: { name: true } } },
          orderBy: { dueDate: "asc" },
          take: 10,
        }),
        prisma.calendarEvent.findMany({
          where: {
            start: { gte: todayStart, lte: todayEnd },
          },
          orderBy: { start: "asc" },
          select: {
            id: true,
            title: true,
            start: true,
            end: true,
            contactName: true,
          },
        }),
      ]);

      // Cooling hot contacts (hot but no contact in 14+ days)
      const coolingHot = await prisma.contact.findMany({
        where: {
          relationshipStrength: "hot",
          lastContactDate: { lt: fourteenDaysAgo },
        },
        take: 3,
        select: { id: true, name: true, lastContactDate: true },
      });

      // Build brief message
      const lines: string[] = [
        `📋 *Good morning — your daily brief for ${formatDate(now)}*`,
        "",
      ];

      // Today's meetings
      if (todayEvents.length > 0) {
        lines.push("📅 *Today's meetings:*");
        for (const ev of todayEvents) {
          const time = ev.start.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
          lines.push(`• ${time} — ${ev.title}${ev.contactName ? ` _(${ev.contactName})_` : ""}`);
        }
        lines.push("");
      }

      // Overdue reminders
      if (overdueReminders.length > 0) {
        lines.push("⏰ *Overdue reminders:*");
        for (const r of overdueReminders) {
          const when = formatDate(r.dueDate);
          lines.push(`• *${r.contact.name}* — ${r.content} _(due ${when})_`);
        }
        lines.push("");
      }

      // Cooling hot contacts
      if (coolingHot.length > 0) {
        lines.push("🔥 *Hot contacts going cold:*");
        for (const c of coolingHot) {
          const days = c.lastContactDate
            ? Math.floor((now.getTime() - c.lastContactDate.getTime()) / 86400_000)
            : "?";
          lines.push(`• *${c.name}* — last contact ${days} days ago`);
        }
        lines.push("");
      }

      // Stale VCs
      if (staleVCs.length > 0) {
        lines.push("💼 *Stale VCs to re-engage:*");
        for (const c of staleVCs) {
          const days = c.lastContactDate
            ? Math.floor((now.getTime() - c.lastContactDate.getTime()) / 86400_000)
            : "?";
          lines.push(`• *${c.name}*${c.company ? ` @ ${c.company}` : ""} — ${days} days`);
        }
        lines.push("");
      }

      if (
        todayEvents.length === 0 &&
        overdueReminders.length === 0 &&
        coolingHot.length === 0 &&
        staleVCs.length === 0
      ) {
        lines.push("✅ All clear — no urgent items today!");
      }

      lines.push("_Have a great day!_");

      const message = lines.join("\n");

      // Get user's Telegram chat ID from allowed IDs env var
      // In this system the owner's chat ID is configured via TELEGRAM_ALLOWED_CHAT_IDS
      const allowedChatIds = (process.env.TELEGRAM_ALLOWED_CHAT_IDS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      if (allowedChatIds.length === 0) {
        console.warn("[daily-brief] No TELEGRAM_ALLOWED_CHAT_IDS configured — cannot send brief");
        return { sent: false, reason: "No chat IDs configured" };
      }

      // Send to first (primary) chat ID
      const chatId = allowedChatIds[0];
      await sendBotReply(chatId, message);

      console.log(`[daily-brief] Brief sent to chat ${chatId} for userId=${userId}`);
      return {
        sent: true,
        chatId,
        meetings: todayEvents.length,
        reminders: overdueReminders.length,
        coolingHot: coolingHot.length,
        staleVCs: staleVCs.length,
      };
    },
    {
      connection: redis.connection,
      concurrency: 1,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    },
  );

  worker.on("failed", (job, err) => {
    console.error(`[daily-brief] job ${job?.id} failed:`, err.message);
  });

  return worker;
}
