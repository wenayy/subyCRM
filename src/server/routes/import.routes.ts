import { Router } from "express";
import { prisma } from "../lib/prisma";
import { contactService } from "../services/contact.service";
import { importService } from "../services/import.service";
import { telegramPersonalService } from "../services/telegram-personal.service";
import { discordService } from "../services/discord.service";
import { whatsappService } from "../services/whatsapp.service";

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

    // Create the contact
    const contact = await contactService.create(req.body);

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
    // Use first authenticated user from session table
    const session = await (prisma as any).telegramPersonalSession.findFirst({
      where: { connected: true },
      select: { userId: true },
    });
    if (!session) {
      res.status(400).json({ error: "Telegram personal not connected. Connect it in Settings first." });
      return;
    }

    const userId = res.locals.session?.user?.id ?? "default";
    const job = await prisma.importJob.create({
      data: { userId, source: "telegram_api", status: "running", startedAt: new Date() },
    });

    res.json({ status: "started", jobId: job.id });

    // Run in background
    telegramPersonalService.importContacts(session.userId)
      .then(async ({ imported, updated, skipped }) => {
        await prisma.importJob.update({
          where: { id: job.id },
          data: {
            status: "completed",
            totalFound: imported + updated + skipped,
            imported,
            deduplicated: updated,
            errors: skipped,
            completedAt: new Date(),
          },
        });
      })
      .catch(async (err) => {
        console.error("[import/telegram]", err);
        await prisma.importJob.update({
          where: { id: job.id },
          data: { status: "failed", errorLog: { error: err.message }, completedAt: new Date() },
        });
      });
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

    res.json({ status: "started", jobId: job.id });

    // Run in background
    discordService.importContacts(userId)
      .then(async ({ imported, updated, skipped }) => {
        await prisma.importJob.update({
          where: { id: job.id },
          data: {
            status: "completed",
            totalFound: imported + updated + skipped,
            imported,
            deduplicated: updated,
            errors: skipped,
            completedAt: new Date(),
          },
        });
      })
      .catch(async (err) => {
        console.error("[import/discord]", err);
        await prisma.importJob.update({
          where: { id: job.id },
          data: { status: "failed", errorLog: { error: err.message }, completedAt: new Date() },
        });
      });
  } catch (err) {
    next(err);
  }
});

// POST /api/imports/whatsapp — import contacts from WhatsApp
router.post("/whatsapp", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";

    // Check connection status
    const status = await whatsappService.getStatus(userId);
    if (!status.connected) {
      res.status(400).json({ error: "WhatsApp not connected. Connect it in Settings first." });
      return;
    }

    const job = await prisma.importJob.create({
      data: { userId, source: "whatsapp_export", status: "running", startedAt: new Date() },
    });

    res.json({ status: "started", jobId: job.id });

    // Run in background
    whatsappService.importContacts(userId)
      .then(async ({ imported, updated, skipped }) => {
        await prisma.importJob.update({
          where: { id: job.id },
          data: {
            status: "completed",
            totalFound: imported + updated + skipped,
            imported,
            deduplicated: updated,
            errors: skipped,
            completedAt: new Date(),
          },
        });
      })
      .catch(async (err) => {
        console.error("[import/whatsapp]", err);
        await prisma.importJob.update({
          where: { id: job.id },
          data: { status: "failed", errorLog: { error: err.message }, completedAt: new Date() },
        });
      });
  } catch (err) {
    next(err);
  }
});

// POST /api/imports/csv — parse CSV text and create contacts
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

    // Parse header — normalize to lowercase, trim spaces
    const headers = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_"));

    const col = (row: string[], ...names: string[]): string => {
      for (const name of names) {
        const idx = headers.indexOf(name);
        if (idx !== -1 && row[idx]?.trim()) return row[idx].trim();
      }
      return "";
    };

    const job = await prisma.importJob.create({
      data: { source: "manual", status: "running", startedAt: new Date() },
    });
    res.json({ status: "started", jobId: job.id });

    // Run import in background
    (async () => {
      let imported = 0, skipped = 0, errors = 0;
      const errorMessages: string[] = [];

      // Parse all rows first
      type ParsedRow = { name: string; email: string; company: string; role: string; linkedin: string; twitter: string; notes: string; tags: string };
      const parsed: ParsedRow[] = [];
      for (let i = 1; i < lines.length; i++) {
        const row = lines[i].split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
        const name = col(row, "name", "full_name", "fullname", "contact_name");
        if (!name) { skipped++; continue; }
        parsed.push({
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

      // 1 query: load all existing contact names for this user
      const existing = await prisma.contact.findMany({
        where: { userId },
        select: { name: true },
      });
      const existingNames = new Set(existing.map((c) => c.name.toLowerCase().trim()));

      const toCreate = parsed.filter((r) => {
        if (existingNames.has(r.name.toLowerCase().trim())) { skipped++; return false; }
        return true;
      });

      if (toCreate.length === 0) {
        await prisma.importJob.update({
          where: { id: job.id },
          data: { status: "completed", totalFound: lines.length - 1, imported: 0, deduplicated: skipped, errors: 0, completedAt: new Date() },
        });
        return;
      }

      // Batch create all contacts in one query
      await prisma.contact.createMany({
        data: toCreate.map((r) => ({
          userId,
          name: r.name,
          company: r.company || null,
          role: r.role || null,
          type: "other" as const,
          domain: "other" as const,
          relationshipStrength: "cold" as const,
        })),
        skipDuplicates: true,
      });

      // Fetch back the created contacts to get their IDs
      const createdContacts = await prisma.contact.findMany({
        where: { userId, name: { in: toCreate.map((r) => r.name) } },
        select: { id: true, name: true },
      });
      const idByName = new Map(createdContacts.map((c) => [c.name.toLowerCase().trim(), c.id]));

      // Build platform/note data
      const platformData: any[] = [];
      const noteData: any[] = [];
      const tagWork: Array<{ contactId: string; tagNames: string[] }> = [];

      for (const r of toCreate) {
        const contactId = idByName.get(r.name.toLowerCase().trim());
        if (!contactId) { errors++; continue; }

        if (r.email) platformData.push({ contactId, type: "email", platformId: r.email, displayName: r.name });
        if (r.linkedin) {
          const slug = r.linkedin.match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1] ?? r.linkedin;
          platformData.push({ contactId, type: "linkedin", platformId: slug, profileUrl: r.linkedin.startsWith("http") ? r.linkedin : `https://www.linkedin.com/in/${slug}`, displayName: r.name });
        }
        if (r.twitter) {
          const handle = r.twitter.replace(/^@/, "").replace(/.*(?:twitter|x)\.com\//, "");
          platformData.push({ contactId, type: "x", platformId: handle, profileUrl: `https://x.com/${handle}`, displayName: handle });
        }
        if (r.notes) noteData.push({ contactId, content: r.notes });
        if (r.tags) tagWork.push({ contactId, tagNames: r.tags.split(";").map((t: string) => t.trim()).filter(Boolean) });

        imported++;
      }

      // Batch create platforms and notes in parallel
      await Promise.all([
        platformData.length > 0 ? prisma.platform.createMany({ data: platformData, skipDuplicates: true }).catch(() => {}) : Promise.resolve(),
        noteData.length > 0 ? prisma.note.createMany({ data: noteData }).catch(() => {}) : Promise.resolve(),
      ]);

      // Tags: upsert each unique tag then link — run all in parallel
      await Promise.all(tagWork.map(async ({ contactId, tagNames }) => {
        for (const tagName of tagNames) {
          try {
            const tag = await prisma.tag.upsert({
              where: { userId_name: { userId, name: tagName } },
              create: { userId, name: tagName, color: "#6366f1" },
              update: {},
            });
            await prisma.contactTag.upsert({
              where: { contactId_tagId: { contactId, tagId: tag.id } },
              create: { contactId, tagId: tag.id },
              update: {},
            }).catch(() => {});
          } catch { /* ignore tag errors */ }
        }
      }));

      await prisma.importJob.update({
        where: { id: job.id },
        data: {
          status: "completed",
          totalFound: lines.length - 1,
          imported,
          deduplicated: skipped,
          errors,
          completedAt: new Date(),
          ...(errorMessages.length > 0 && { errorLog: { errors: errorMessages.slice(0, 5) } }),
        },
      });
    })().catch(async (err) => {
      await prisma.importJob.update({
        where: { id: job.id },
        data: { status: "failed", errorLog: { error: err.message }, completedAt: new Date() },
      });
    });
  } catch (err) {
    next(err);
  }
});

export default router;
