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
      for (let i = 1; i < lines.length; i++) {
        try {
          // Basic CSV split (handles simple cases — no quoted commas)
          const row = lines[i].split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
          const name = col(row, "name", "full_name", "fullname", "contact_name");
          if (!name) { skipped++; continue; }

          const email    = col(row, "email", "email_address");
          const company  = col(row, "company", "company_name", "organization");
          const role     = col(row, "role", "title", "job_title", "position");
          const linkedin = col(row, "linkedin", "linkedin_url", "linkedin_profile");
          const twitter  = col(row, "twitter", "x", "x_handle", "twitter_handle");
          const notes    = col(row, "notes", "note", "description");
          const tags     = col(row, "tags", "tag", "labels");

          // Check for duplicate by name + userId
          const existing = await prisma.contact.findFirst({
            where: { userId, name: { equals: name, mode: "insensitive" } },
          });
          if (existing) { skipped++; continue; }

          const contact = await prisma.contact.create({
            data: {
              userId,
              name,
              company: company || null,
              role: role || null,
              type: "other",
              domain: "other",
              relationshipStrength: "cold",
            },
          });

          if (email) {
            await prisma.platform.create({
              data: { contactId: contact.id, type: "email", platformId: email, displayName: name },
            }).catch(() => {});
          }

          if (linkedin) {
            const slug = linkedin.match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1] ?? linkedin;
            await prisma.platform.create({
              data: { contactId: contact.id, type: "linkedin", platformId: slug, profileUrl: linkedin.startsWith("http") ? linkedin : `https://www.linkedin.com/in/${slug}`, displayName: name },
            }).catch(() => {});
          }

          if (twitter) {
            const handle = twitter.replace(/^@/, "").replace(/.*(?:twitter|x)\.com\//, "");
            await prisma.platform.create({
              data: { contactId: contact.id, type: "x", platformId: handle, profileUrl: `https://x.com/${handle}`, displayName: handle },
            }).catch(() => {});
          }

          if (notes) {
            await prisma.note.create({
              data: { contactId: contact.id, content: notes },
            }).catch(() => {});
          }

          if (tags) {
            for (const tagName of tags.split(";").map((t: string) => t.trim()).filter(Boolean)) {
              const tag = await prisma.tag.upsert({
                where: { userId_name: { userId, name: tagName } },
                create: { userId, name: tagName, color: "#6366f1" },
                update: {},
              });
              await prisma.contactTag.upsert({
                where: { contactId_tagId: { contactId: contact.id, tagId: tag.id } },
                create: { contactId: contact.id, tagId: tag.id },
                update: {},
              }).catch(() => {});
            }
          }

          imported++;
        } catch (err: any) {
          const msg = err?.message ?? String(err);
          console.error(`[import/csv] row ${i} failed:`, msg);
          errorMessages.push(`row ${i}: ${msg}`);
          errors++;
        }
      }

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
