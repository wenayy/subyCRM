import "dotenv/config";
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err.message);
});
process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err);
});

import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./lib/auth";
import { errorMiddleware } from "./middlewares/error";
import { requireAuth } from "./middlewares/auth";

// Routes
import contactRoutes from "./routes/contact.routes";
import { tagRouter, contactTagRouter } from "./routes/tag.routes";
import { contactNoteRouter, noteRouter } from "./routes/note.routes";
import importRoutes from "./routes/import.routes";
import aiRoutes from "./routes/ai.routes";
import companyRoutes from "./routes/company.routes";
import reminderRoutes, { contactReminderRouter } from "./routes/reminder.routes";
import { calendarRouter, calendarCallbackRouter } from "./routes/calendar.routes";
import { gmailRouter, gmailCallbackRouter } from "./routes/gmail.routes";
import { voiceRouter } from "./routes/voice.routes";
import inboxRouter from "./routes/inbox.routes";
import discordRouter, { discordCallbackRouter } from "./routes/discord.routes";
import slackRouter, { slackCallbackRouter } from "./routes/slack.routes";
import { emailRouter } from "./routes/email.routes";
import xRouter, { xCallbackRouter } from "./routes/x.routes";
import whatsappRouter from "./routes/whatsapp.routes";
import telegramPersonalRouter from "./routes/telegram-personal.routes";
import linkedinRouter, { linkedinCallbackRouter } from "./routes/linkedin.routes";
import sequenceRouter from "./routes/sequence.routes";
import pipelineRouter from "./routes/pipeline.routes";
import telegramBotRouter from "./routes/telegram-bot.routes";
import matrixRouter from "./routes/matrix.routes";

const app = express();
const PORT = process.env.PORT || process.env.API_PORT || 4002;

// Trust Railway/Render/Heroku proxy so req.protocol and req.secure reflect HTTPS
app.set("trust proxy", 1);

// ─── CORS ────────────────────────────────────────────────────
const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(",").map((s) => s.trim())
  : [];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, server-to-server)
    if (!origin) return callback(null, true);
    // Allow all in dev
    if (process.env.NODE_ENV !== "production") return callback(null, true);
    // Check allowed origins in prod
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error("CORS not allowed"));
  },
  credentials: true,
}));

// ─── Bull Board (queue dashboard — dev only) ─────────────────
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { queues } from "./lib/queues";

const bullServerAdapter = new ExpressAdapter();
bullServerAdapter.setBasePath("/admin/queues");
createBullBoard({
  queues: Object.values(queues).map((q) => new BullMQAdapter(q)),
  serverAdapter: bullServerAdapter,
});
app.use("/admin/queues", bullServerAdapter.getRouter());
console.log("[bull-board] Dashboard at http://localhost:4002/admin/queues");

app.all("/api/auth/{*any}", toNodeHandler(auth));
app.use("/api/calendar", calendarCallbackRouter); // callback must bypass requireAuth
app.use("/api/gmail", gmailCallbackRouter);       // callback must bypass requireAuth
app.use("/api/slack", slackCallbackRouter);       // callback must bypass requireAuth
app.use("/api/x", xCallbackRouter);              // callback must bypass requireAuth
app.use("/api/linkedin", linkedinCallbackRouter); // callback must bypass requireAuth
app.use("/api/discord", discordCallbackRouter);   // callback must bypass requireAuth
app.use("/api/matrix", matrixRouter);             // Matrix appservice webhook — no user auth

app.use(express.json({ limit: "20mb" }));

// ─── Rate limiting ──────────────────────────────────────────
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 2000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, try again later" },
  })
);

// ─── Health check ────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "suby-contacts" });
});

// ─── Routes ──────────────────────────────────────────────────
app.use("/api", requireAuth);

// GET /api/me — current user info
app.get("/api/me", (req, res) => {
  const user = res.locals.session?.user;
  res.json({ id: user?.id ?? null, name: user?.name ?? null, email: user?.email ?? null });
});
app.use("/api/contacts", contactRoutes);
app.use("/api/contacts", contactTagRouter);
app.use("/api/contacts", contactNoteRouter);
app.use("/api/tags", tagRouter);
app.use("/api/notes", noteRouter);
app.use("/api/imports", importRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/companies", companyRoutes);
app.use("/api/reminders", reminderRoutes);
app.use("/api/contacts", contactReminderRouter);
app.use("/api/calendar", calendarRouter);
app.use("/api/gmail", gmailRouter);
app.use("/api/voice", voiceRouter);
app.use("/api/inbox", inboxRouter);
app.use("/api/discord", discordRouter);
app.use("/api/email", emailRouter);
app.use("/api/slack", slackRouter);
app.use("/api/x", xRouter);
app.use("/api/whatsapp", whatsappRouter);
app.use("/api/telegram-personal", telegramPersonalRouter);
app.use("/api/linkedin", linkedinRouter);
app.use("/api/sequences", sequenceRouter);
app.use("/api/pipeline", pipelineRouter);
app.use("/api/telegram-bot", telegramBotRouter);

// ─── Error handler ───────────────────────────────────────────
app.use(errorMiddleware);

// ─── Cron: stale contact check (daily) ──────────────────────
import cron from "node-cron";
import { runStaleCheck } from "./cron/staleCheck";
cron.schedule("0 8 * * *", () => runStaleCheck().catch(console.error));

// ─── Telegram bot ────────────────────────────────────────────
import { startBot } from "./services/telegram-bot.service";
startBot();

// ─── WhatsApp auto-reconnect ─────────────────────────────────
import { whatsappService } from "./services/whatsapp.service";
whatsappService.autoReconnect();

// ─── Discord auto-reconnect ───────────────────────────────────
import { discordService } from "./services/discord.service";
discordService.autoReconnect();

// ─── Start server ────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`Suby Contacts API running on port ${PORT}`);

  // ── Schema migration: platform unique constraint per-contact ───
  // Drop any 2-column (type, platform_id) unique constraint (regardless of name),
  // then add/keep the correct 3-column (type, platform_id, contact_id) one.
  void (async () => {
    try {
      const { prisma } = await import("./lib/prisma");
      await prisma.$executeRawUnsafe(`
        DO $mig$
        DECLARE v_conname text;
        BEGIN
          -- Drop any unique constraint on exactly (type, platform_id) — name may vary
          FOR v_conname IN
            SELECT c.conname
            FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE t.relname = 'platforms'
              AND n.nspname = 'contacts'
              AND c.contype = 'u'
              AND array_length(c.conkey, 1) = 2
              AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid = t.oid AND attname = 'type' AND attnum = ANY(c.conkey))
              AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid = t.oid AND attname = 'platform_id' AND attnum = ANY(c.conkey))
          LOOP
            EXECUTE 'ALTER TABLE contacts.platforms DROP CONSTRAINT IF EXISTS ' || quote_ident(v_conname);
            RAISE NOTICE 'Dropped old platform constraint: %', v_conname;
          END LOOP;

          -- Add 3-column constraint if not already present
          IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE t.relname = 'platforms' AND n.nspname = 'contacts'
              AND c.contype = 'u'
              AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid = t.oid AND attname = 'type'        AND attnum = ANY(c.conkey))
              AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid = t.oid AND attname = 'platform_id' AND attnum = ANY(c.conkey))
              AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid = t.oid AND attname = 'contact_id'  AND attnum = ANY(c.conkey))
          ) THEN
            ALTER TABLE contacts.platforms
              ADD CONSTRAINT platforms_type_platform_id_contact_id_key
              UNIQUE (type, platform_id, contact_id);
            RAISE NOTICE 'Added per-contact platform uniqueness constraint';
          END IF;
        END
        $mig$
      `);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS platforms_type_platform_id_idx ON contacts.platforms (type, platform_id)`);
      console.log("[startup] Platform constraint migration OK");
    } catch (e: any) {
      console.error("[startup] Platform constraint migration error:", e.message);
    }
  })();

  // ── Backfill: link contacts to companies by name string ────────
  // Contacts created from the contacts page have company: "Acme" but no companyId.
  // This one-time pass sets companyId on any such contacts so company detail pages
  // correctly show their linked people.
  void (async () => {
    try {
      const { prisma } = await import("./lib/prisma");
      const companies = await prisma.company.findMany({ select: { id: true, name: true, userId: true } });
      let linked = 0;
      for (const c of companies) {
        const { count } = await prisma.contact.updateMany({
          where: { userId: c.userId, companyId: null, company: { equals: c.name, mode: "insensitive" } },
          data: { companyId: c.id },
        });
        linked += count;
      }
      if (linked > 0) console.log(`[startup] Auto-linked ${linked} contact(s) to companies by name`);
    } catch (e: any) {
      console.error("[startup] Company backfill error:", e.message);
    }
  })();

  // ── Backfill: claim "default" contacts for the first real user ──
  void (async () => {
    try {
      const { prisma } = await import("./lib/prisma");
      const defaultCount = await prisma.contact.count({ where: { userId: "default" } });
      if (defaultCount === 0) return;
      // Find the oldest user account (the app owner)
      const firstUser = await (prisma as any).user.findFirst({ orderBy: { createdAt: "asc" } });
      if (!firstUser) return;
      const { count } = await prisma.contact.updateMany({
        where: { userId: "default" },
        data: { userId: firstUser.id },
      });
      if (count > 0) console.log(`[startup] Claimed ${count} default contacts for user ${firstUser.email}`);
      // Also claim default inbox messages
      await (prisma as any).inboxMessage.updateMany({
        where: { userId: "default" },
        data: { userId: firstUser.id },
      });
      // Also claim default tags and companies
      await (prisma as any).tag.updateMany({ where: { userId: "default" }, data: { userId: firstUser.id } });
      await (prisma as any).company.updateMany({ where: { userId: "default" }, data: { userId: firstUser.id } });
    } catch (e: any) {
      console.error("[startup] Default data claim error:", e.message);
    }
  })();

  // X (Twitter) uses scheduled BullMQ sync — no persistent socket to reconnect

  const { telegramPersonalService } = await import("./services/telegram-personal.service");
  telegramPersonalService.autoReconnect();

  // ── BullMQ workers ──────────────────────────────────────────
  const { startAllWorkers } = await import("./workers/index");
  startAllWorkers();

  // ── BullMQ: Daily brief at 07:55 every day ─────────────────
  const { queues, DEFAULT_JOB_OPTIONS } = await import("./lib/queues");
  const DAILY_BRIEF_USER_ID = process.env.OWNER_USER_ID || "owner";

  // Remove existing repeatable job and re-add (idempotent on restart)
  await queues.dailyBrief
    .removeRepeatable("daily-brief", { cron: "55 7 * * *" })
    .catch(() => {});

  await queues.dailyBrief.add(
    "daily-brief",
    { userId: DAILY_BRIEF_USER_ID },
    { repeat: { cron: "55 7 * * *" }, ...DEFAULT_JOB_OPTIONS },
  );
  console.log("[server] Daily brief scheduled at 07:55");

  // ── BullMQ: Sequence tick every hour ───────────────────────
  await queues.sequenceTick
    .removeRepeatable("sequence-tick", { cron: "0 * * * *" })
    .catch(() => {});

  await queues.sequenceTick.add(
    "sequence-tick",
    {},
    { repeat: { cron: "0 * * * *" }, ...DEFAULT_JOB_OPTIONS },
  );
  console.log("[server] Sequence tick scheduled every hour");

  // ── BullMQ: Gmail sync every 5 minutes ─────────────────────
  await queues.gmailSync
    .removeRepeatable("gmail-sync", { cron: "*/5 * * * *" })
    .catch(() => {});
  await queues.gmailSync.add(
    "gmail-sync",
    {},
    { repeat: { cron: "*/5 * * * *" }, ...DEFAULT_JOB_OPTIONS },
  );
  console.log("[server] Gmail sync scheduled every 5 minutes");

  // ── BullMQ: X DM sync every 10 minutes ─────────────────────
  await queues.xDmSync
    .removeRepeatable("x-dm-sync", { cron: "*/10 * * * *" })
    .catch(() => {});
  await queues.xDmSync.add(
    "x-dm-sync",
    {},
    { repeat: { cron: "*/10 * * * *" }, ...DEFAULT_JOB_OPTIONS },
  );
  console.log("[server] X DM sync scheduled every 10 minutes");

  // ── BullMQ: Slack DM sync every 5 minutes ──────────────────
  await queues.slackSync
    .removeRepeatable("slack-sync", { cron: "*/5 * * * *" })
    .catch(() => {});
  await queues.slackSync.add(
    "slack-sync",
    {},
    { repeat: { cron: "*/5 * * * *" }, ...DEFAULT_JOB_OPTIONS },
  );
  console.log("[server] Slack sync scheduled every 5 minutes");

  // ── BullMQ: Discord sync every 15 minutes (fallback for bot) ─
  await queues.discordSync
    .removeRepeatable("discord-sync", { cron: "*/15 * * * *" })
    .catch(() => {});
  await queues.discordSync.add(
    "discord-sync",
    {},
    { repeat: { cron: "*/15 * * * *" }, ...DEFAULT_JOB_OPTIONS },
  );
  console.log("[server] Discord sync scheduled every 15 minutes");

  // ── BullMQ: LinkedIn sync every 15 minutes ─────────────────
  await queues.linkedinSync
    .removeRepeatable("linkedin-sync", { cron: "*/15 * * * *" })
    .catch(() => {});
  await queues.linkedinSync.add(
    "linkedin-sync",
    {},
    { repeat: { cron: "*/15 * * * *" }, ...DEFAULT_JOB_OPTIONS },
  );
  console.log("[server] LinkedIn sync scheduled every 15 minutes");
});

export default app;
