import { Router } from "express";
import { prisma } from "../lib/prisma";
import { contactService } from "../services/contact.service";
import { importService } from "../services/import.service";
import { telegramPersonalService } from "../services/telegram-personal.service";
import { discordService } from "../services/discord.service";
import { slackService } from "../services/slack.service";
import { whatsappService } from "../services/whatsapp.service";
import { queues } from "../lib/queues";
import type { CsvImportJobData } from "../workers/csv-import.worker";

const router = Router();

// On startup: mark any orphaned "running" jobs as failed (they were interrupted by a server restart)
prisma.importJob.updateMany({
  where: { status: "running" },
  data: { status: "failed", errorLog: { error: "Interrupted by server restart" }, completedAt: new Date() },
}).catch(() => {});

// GET /api/imports — list import jobs for current user
router.get("/", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const jobs = await prisma.importJob.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    res.json(jobs);
  } catch (err) {
    next(err);
  }
});

// GET /api/imports/:id — single import job
router.get("/:id", async (req, res, next) => {
  try {
    const job = await prisma.importJob.findUnique({
      where: { id: req.params.id },
    });
    if (!job) {
      res.status(404).json({ error: "Import job not found" });
      return;
    }
    res.json(job);
  } catch (err) {
    next(err);
  }
});

// POST /api/imports/manual — manually create a contact via import flow
router.post("/manual", async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "Missing name" });
      return;
    }

    // Create an import job record
    const job = await prisma.importJob.create({
      data: {
        source: "manual",
        status: "completed",
        totalFound: 1,
        imported: 1,
        startedAt: new Date(),
        completedAt: new Date(),
      },
    });

    // Create the contact, owned by the logged-in user
    const userId = res.locals.session?.user?.id ?? "default";
    const contact = await contactService.create(userId, req.body);

    res.status(201).json({ job, contact });
  } catch (err) {
    next(err);
  }
});

// POST /api/imports/beeper — trigger Beeper import
router.post("/beeper", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const job = await prisma.importJob.create({
      data: { userId, source: "beeper", status: "running", startedAt: new Date() },
    });
    res.json({ status: "started", jobId: job.id });
    importService.runBeeperImport(job.id).catch(console.error);
  } catch (err) {
    next(err);
  }
});

// POST /api/imports/telegram — import contacts from Telegram MTProto dialogs
router.post("/telegram", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const rec = await (prisma as any).telegramPersonalSession.findUnique({ where: { userId } });
    if (!rec?.sessionStr) {
      res.status(400).json({ error: "Telegram personal not connected. Connect it in Settings first." });
      return;
    }

    const job = await prisma.importJob.create({
      data: { userId, source: "telegram_api", status: "running", startedAt: new Date() },
    });

    await queues.telegramImport.add("telegram-import", { userId, importJobId: job.id });
    res.json({ status: "started", jobId: job.id });
  } catch (err) {
    next(err);
  }
});

// POST /api/imports/discord — import contacts from Discord servers
router.post("/discord", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";

    // Check connection status
    const status = await discordService.getStatus(userId);
    if (!status.connected) {
      res.status(400).json({ error: "Discord not connected. Connect it in Settings first." });
      return;
    }

    const job = await prisma.importJob.create({
      data: { userId, source: "discord_api", status: "running", startedAt: new Date() },
    });

    await queues.discordImport.add("discord-import", { userId, importJobId: job.id });
    res.json({ status: "started", jobId: job.id });
  } catch (err) {
    next(err);
  }
});

// POST /api/imports/whatsapp — import contacts from WhatsApp
router.post("/whatsapp", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";

    const status = await whatsappService.getStatus(userId);
    if (!status.connected) {
      res.status(400).json({ error: "WhatsApp not connected. Connect it in Settings first." });
      return;
    }

    const job = await prisma.importJob.create({
      data: { userId, source: "whatsapp_export", status: "running", startedAt: new Date() },
    });

    await queues.whatsappImport.add("whatsapp-import", { userId, importJobId: job.id });
    res.json({ status: "started", jobId: job.id });
  } catch (err) {
    next(err);
  }
});

// POST /api/imports/csv — parse CSV and enqueue for processing
router.post("/csv", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const { csv } = req.body as { csv: string };
    if (!csv || typeof csv !== "string") {
      res.status(400).json({ error: "Missing csv field" });
      return;
    }

    const lines = csv.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) {
      res.status(400).json({ error: "CSV must have a header row and at least one data row" });
      return;
    }

    const headers = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_"));
    const col = (row: string[], ...names: string[]): string => {
      for (const name of names) {
        const idx = headers.indexOf(name);
        if (idx !== -1 && row[idx]?.trim()) return row[idx].trim();
      }
      return "";
    };

    // Parse all rows upfront — fast, in-memory, no DB
    const rows: CsvImportJobData["rows"] = [];
    for (let i = 1; i < lines.length; i++) {
      const row = lines[i].split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
      const name = col(row, "name", "full_name", "fullname", "contact_name");
      if (!name) continue;
      rows.push({
        name,
        email:    col(row, "email", "email_address"),
        company:  col(row, "company", "company_name", "organization"),
        role:     col(row, "role", "title", "job_title", "position"),
        linkedin: col(row, "linkedin", "linkedin_url", "linkedin_profile"),
        twitter:  col(row, "twitter", "x", "x_handle", "twitter_handle"),
        notes:    col(row, "notes", "note", "description"),
        tags:     col(row, "tags", "tag", "labels"),
      });
    }

    if (rows.length === 0) {
      res.status(400).json({ error: "No valid rows found (name column is required)" });
      return;
    }

    const job = await prisma.importJob.create({
      data: { userId, source: "manual", status: "running", startedAt: new Date() },
    });

    // Enqueue — worker handles all DB work, HTTP responds immediately
    await queues.csvImport.add("csv-import", { jobId: job.id, userId, rows, totalFound: rows.length } satisfies CsvImportJobData);

    res.json({ status: "started", jobId: job.id });
  } catch (err) {
    next(err);
  }
});

// POST /api/imports/slack — import contacts from Slack workspace
router.post("/slack", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";

    const status = await slackService.getStatus(userId);
    if (!status.connected) {
      res.status(400).json({ error: "Slack not connected. Connect it in Settings first." });
      return;
    }

    const job = await prisma.importJob.create({
      data: { userId, source: "slack_api", status: "running", startedAt: new Date() },
    });

    await queues.slackImport.add("slack-import", { userId, importJobId: job.id });
    res.json({ status: "started", jobId: job.id });
  } catch (err) {
    next(err);
  }
});

export default router;
