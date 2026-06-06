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

// ─── Static media files (uploaded attachments, WA/Telegram media) ────────────
import path from "path";
import fs from "fs";
const mediaDir = path.join(process.cwd(), "public", "media");
fs.mkdirSync(mediaDir, { recursive: true });
app.use("/media", express.static(path.join(process.cwd(), "public", "media"), {
  maxAge: "7d",
  setHeaders: (res) => { res.setHeader("Access-Control-Allow-Origin", "*"); },
}));

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

          -- Add 3-column constraint if not already present (check by name)
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = 'contacts'
              AND t.relname = 'platforms'
              AND c.contype = 'u'
              AND c.conname = 'platforms_type_platform_id_contact_id_key'
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
      if (e.message?.includes("already exists")) {
        console.log("[startup] Platform constraint already exists — OK");
      } else {
        console.error("[startup] Platform constraint migration error:", e.message);
      }
    }
  })();

  // ── Schema migration: inbox_messages unique constraint per-user ──
  void (async () => {
    try {
      const { prisma } = await import("./lib/prisma");
      // Drop ALL unique constraints on inbox_messages that cover only (platform, external_id)
      // regardless of what name they were given — catches any naming variant.
      await prisma.$executeRawUnsafe(`
        DO $$
        DECLARE v_conname text;
        BEGIN
          FOR v_conname IN
            SELECT c.conname
            FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = 'contacts'
              AND t.relname = 'inbox_messages'
              AND c.contype = 'u'
              AND (
                -- old 2-col constraint (platform + external_id only) — check by cast to avoid name[]=text[] error
                (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
                 FROM pg_attribute a
                 WHERE a.attrelid = c.conrelid
                   AND a.attnum = ANY(c.conkey)
                ) = ARRAY['external_id','platform']
              )
          LOOP
            EXECUTE 'ALTER TABLE contacts.inbox_messages DROP CONSTRAINT IF EXISTS ' || quote_ident(v_conname);
            RAISE NOTICE 'Dropped old inbox constraint: %', v_conname;
          END LOOP;

          -- Deduplicate before adding 3-col constraint
          DELETE FROM contacts.inbox_messages a
          USING contacts.inbox_messages b
          WHERE a.id > b.id
            AND a.platform    = b.platform
            AND a.external_id = b.external_id
            AND a.user_id     = b.user_id;

          -- Add 3-col constraint if not already present (check by name)
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = 'contacts'
              AND t.relname = 'inbox_messages'
              AND c.contype = 'u'
              AND c.conname = 'inbox_messages_platform_external_id_user_id_key'
          ) THEN
            ALTER TABLE contacts.inbox_messages
              ADD CONSTRAINT inbox_messages_platform_external_id_user_id_key
              UNIQUE (platform, external_id, user_id);
            RAISE NOTICE 'Added 3-col inbox constraint';
          END IF;
        END$$;
      `);
      console.log("[startup] Inbox constraint migration OK");
    } catch (e: any) {
      if (e.message?.includes("already exists")) {
        console.log("[startup] Inbox constraint already exists — OK");
      } else {
        console.error("[startup] Inbox constraint migration error:", e.message);
      }
    }
  })();

  // ── Schema migration: reminders.contact_id nullable ───────────
  void (async () => {
    try {
      const { prisma } = await import("./lib/prisma");
      await prisma.$executeRawUnsafe(`
        ALTER TABLE contacts.reminders
          ALTER COLUMN contact_id DROP NOT NULL
      `);
    } catch { /* already nullable */ }
  })();

  // ── Schema migration: WhatsApp creds_json + auth_files_json columns ───────────────
  void (async () => {
    try {
      const { prisma } = await import("./lib/prisma");
      await prisma.$executeRawUnsafe(`
        ALTER TABLE contacts.whatsapp_sessions
        ADD COLUMN IF NOT EXISTS creds_json TEXT,
        ADD COLUMN IF NOT EXISTS auth_files_json TEXT
      `);
      console.log("[startup] WhatsApp session columns OK");
    } catch (e: any) {
      console.error("[startup] WhatsApp session column migration error:", e.message);
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

  // ── Backfill: link inbox messages to contacts retroactively ───
  // Messages saved before their contact existed have contactId=null.
  // This pass matches them to CRM platform records so threads/timelines are populated.
  void (async () => {
    try {
      const { prisma } = await import("./lib/prisma");
      const { inboxService } = await import("./services/inbox.service");

      // Fetch all platform records
      const platforms = await prisma.platform.findMany({
        select: { contactId: true, type: true, platformId: true },
      });

      // Only process platforms that are known messaging channels
      const messagingPlatforms = platforms.filter((p) =>
        ["telegram", "whatsapp", "email", "slack", "discord"].includes(p.type)
      );

      let total = 0;
      for (const p of messagingPlatforms) {
        const unlinked = await (prisma as any).inboxMessage.count({
          where: { platform: p.type, contactId: null, senderId: { contains: p.platformId } },
        });
        if (unlinked > 0) {
          await inboxService.linkMessagesToContact(p.contactId, p.type, p.platformId).catch(() => {});
          total += unlinked;
        }
      }

      if (total > 0) console.log(`[startup] Inbox backfill: linked ${total} message(s) to contacts`);
    } catch (e: any) {
      console.error("[startup] Inbox backfill error:", e.message);
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
