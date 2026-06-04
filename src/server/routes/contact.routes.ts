import { Router } from "express";
import { contactService } from "../services/contact.service";
import { enrichmentService } from "../services/enrichment.service";
import { queues, DEFAULT_JOB_OPTIONS } from "../lib/queues";
import { prisma } from "../lib/prisma";

import { cache, CACHE_KEYS } from "../lib/cache";

const router = Router();

async function clearCache() {
  try {
    await cache.invalidateContacts();
  } catch (err) {
    console.error("[cache] Failed to invalidate contacts cache:", err);
  }
}

// GET /api/contacts — list all with filters
router.get("/", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const filters = {
      type: req.query.type as string | undefined,
      domain: req.query.domain as string | undefined,
      strength: req.query.strength as string | undefined,
      tag: req.query.tag as string | undefined,
      search: req.query.search as string | undefined,
      stale_days: req.query.stale_days ? Number(req.query.stale_days) : undefined,
      page: req.query.page ? Number(req.query.page) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    };

    const cacheKey = CACHE_KEYS.contactsList(filters);
    const cached = await cache.get(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    const result = await contactService.getAll(userId, filters);
    await cache.set(cacheKey, result, 300); // cache for 5 min
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/contacts/stats — aggregated stats
router.get("/stats", async (_req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const cacheKey = CACHE_KEYS.contactsStats();
    const cached = await cache.get(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    const stats = await contactService.getStats(userId);
    await cache.set(cacheKey, stats, 300); // cache for 5 min
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

// GET /api/contacts/:id — single contact with relations
router.get("/:id", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const contact = await contactService.getById(userId, req.params.id);
    if (!contact) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }
    res.json(contact);
  } catch (err) {
    next(err);
  }
});

// POST /api/contacts — create contact
router.post("/", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const { name } = req.body;
    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "Missing name" });
      return;
    }
    const contact = await contactService.create(userId, req.body);
    await clearCache();
    res.status(201).json(contact);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/contacts/:id — update contact
router.patch("/:id", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const contact = await contactService.update(userId, req.params.id, req.body);
    await clearCache();
    res.json(contact);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/contacts/:id — delete contact
router.delete("/:id", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    await contactService.delete(userId, req.params.id);
    await clearCache();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/contacts/:id/merge — merge another contact into this one
router.post("/:id/merge", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const { mergeWithId } = req.body;
    if (!mergeWithId || typeof mergeWithId !== "string") {
      res.status(400).json({ error: "Missing mergeWithId" });
      return;
    }
    if (mergeWithId === req.params.id) {
      res.status(400).json({ error: "Cannot merge contact with itself" });
      return;
    }
    const result = await contactService.merge(userId, req.params.id, mergeWithId);
    await clearCache();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/contacts/:id/enrich — enrich via BullMQ worker, poll for result
router.post("/:id/enrich", async (req, res, next) => {
  try {
    const contactId = req.params.id;
    const job = await queues.enrichContact.add(
      "enrich",
      { contactId },
      { ...DEFAULT_JOB_OPTIONS, jobId: `enrich-${contactId}-${Date.now()}` },
    );
    res.json({ status: "queued", jobId: job.id });
  } catch (err) {
    next(err);
  }
});

// GET /api/contacts/enrich-job/:jobId — poll enrich job status
router.get("/enrich-job/:jobId", async (req, res, next) => {
  try {
    const job = await queues.enrichContact.getJob(req.params.jobId);
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    const state = await job.getState();
    res.json({ state, returnValue: job.returnvalue });
  } catch (err) {
    next(err);
  }
});

// POST /api/contacts/bulk-delete
router.post("/bulk-delete", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: "ids array required" });
      return;
    }
    await prisma.contact.deleteMany({ where: { id: { in: ids }, userId } });
    await clearCache();
    res.json({ deleted: ids.length });
  } catch (err) {
    next(err);
  }
});

// POST /api/contacts/bulk-tag
router.post("/bulk-tag", async (req, res, next) => {
  try {
    const { ids, tagId } = req.body;
    if (!Array.isArray(ids) || ids.length === 0 || !tagId) {
      res.status(400).json({ error: "ids array and tagId required" });
      return;
    }
    // createMany skips duplicates via skipDuplicates
    await prisma.contactTag.createMany({
      data: ids.map((contactId: string) => ({ contactId, tagId })),
      skipDuplicates: true,
    });
    await clearCache();
    res.json({ tagged: ids.length });
  } catch (err) {
    next(err);
  }
});

function normalizePlatformId(type: string, raw: string): string {
  const v = raw.trim();
  if (type === "telegram" || type === "x") {
    // If it's a telegram phone number, it might have spaces or dashes. Let's strip them if it starts with + or is all digits.
    if (/^[\+\d\s\-\(\)]+$/.test(v)) {
      return v.replace(/[^\d+]/g, "");
    }
    return v.replace(/^@+/, "");
  }
  if (type === "whatsapp") {
    return v.replace(/[^\d+]/g, "");
  }
  return v;
}

// POST /api/contacts/:id/platforms — add a platform
router.post("/:id/platforms", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const { type, displayName, profileUrl } = req.body;
    const platformId = normalizePlatformId(type, req.body.platformId ?? "");
    if (!type || !platformId) {
      res.status(400).json({ error: "type and platformId are required" });
      return;
    }
    const platform = await contactService.addPlatform(userId, req.params.id, { type, platformId, displayName, profileUrl });
    await clearCache();
    if (type === "whatsapp") {
      const { invalidatePlatformCache } = await import("../services/whatsapp.service");
      invalidatePlatformCache();
    }
    res.status(201).json(platform);
  } catch (err) {
    next(err);
  }
});

// PUT /api/contacts/:id/platforms/:pid — update a platform
router.put("/:id/platforms/:pid", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const { displayName, profileUrl } = req.body;
    const platformId = req.body.platformId ? normalizePlatformId(req.body.type ?? "", req.body.platformId) : undefined;
    const platform = await contactService.updatePlatform(userId, req.params.id, req.params.pid, { platformId, displayName, profileUrl });
    await clearCache();
    res.json(platform);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/contacts/:id/platforms/:pid — delete a platform
router.delete("/:id/platforms/:pid", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    await contactService.deletePlatform(userId, req.params.id, req.params.pid);
    await clearCache();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
