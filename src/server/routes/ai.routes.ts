import { Router } from "express";
import { prisma } from "../lib/prisma";
import { aiService } from "../services/ai.service";
import { queues, DEFAULT_JOB_OPTIONS } from "../lib/queues";
import { cache, CACHE_KEYS } from "../lib/cache";

const router = Router();

// ── POST /api/ai/classify/:id ─────────────────────────────────────────────────
// Enqueues classification job, returns immediately with jobId
router.post("/classify/:id", async (req, res, next) => {
  try {
    const contactId = req.params.id;

    // Verify contact exists
    const exists = await prisma.contact.findUnique({
      where: { id: contactId },
      select: { id: true },
    });
    if (!exists) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }

    // Use contactId as jobId for deduplication
    const job = await queues.aiClassify.add(
      "classify",
      { contactId },
      { ...DEFAULT_JOB_OPTIONS, jobId: contactId },
    );

    res.json({ jobId: job.id, status: "queued", contactId });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/ai/classify-batch ───────────────────────────────────────────────
// Enqueues a job per unclassified contact
router.post("/classify-batch", async (_req, res, next) => {
  try {
    const unclassified = await prisma.contact.findMany({
      where: { type: "other", domain: "other" },
      select: { id: true },
      take: 100,
    });

    const jobs = await queues.aiClassify.addBulk(
      unclassified.map((c) => ({
        name: "classify",
        data: { contactId: c.id },
        opts: { ...DEFAULT_JOB_OPTIONS, jobId: c.id },
      })),
    );

    res.json({ status: "queued", total: jobs.length, jobIds: jobs.map((j) => j.id) });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/ai/summary/:id ──────────────────────────────────────────────────
// Action endpoint: always bypasses/invalidates cache and triggers a fresh generation job
router.post("/summary/:id", async (req, res, next) => {
  try {
    const contactId = req.params.id;

    const exists = await prisma.contact.findUnique({
      where: { id: contactId },
      select: { id: true, aiSummary: true },
    });
    if (!exists) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }

    // Explicit generation action — delete cached copy
    await cache.del(CACHE_KEYS.contactSummary(contactId));

    // Enqueue generation and return queued status (jobId uses timestamp to prevent cache hits on previous completed jobs)
    const job = await queues.aiSummary.add(
      "summary",
      { contactId },
      { ...DEFAULT_JOB_OPTIONS, jobId: `${contactId}-${Date.now()}` },
    );

    res.json({ status: "queued", jobId: job.id });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/ai/prep/:id ─────────────────────────────────────────────────────
// Action endpoint: always bypasses/invalidates cache and triggers a fresh generation job
router.post("/prep/:id", async (req, res, next) => {
  try {
    const contactId = req.params.id;

    const exists = await prisma.contact.findUnique({
      where: { id: contactId },
      select: { id: true },
    });
    if (!exists) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }

    // Explicit generation action — delete cached copy
    await cache.del(CACHE_KEYS.contactBriefing(contactId));

    // Enqueue and respond with queued status (jobId uses timestamp to prevent cache hits on previous completed jobs)
    const job = await queues.aiPrep.add(
      "prep",
      { contactId },
      { ...DEFAULT_JOB_OPTIONS, jobId: `${contactId}-${Date.now()}` },
    );

    res.json({ status: "queued", jobId: job.id });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/ai/alerts ────────────────────────────────────────────────────────
// Still synchronous (uses its own in-memory cache in ai.service)
router.get("/alerts", async (_req, res, next) => {
  try {
    const alerts = await aiService.getAlerts();
    res.json(alerts);
  } catch (err) {
    next(err);
  }
});

// ── GET /api/ai/job/:queue/:jobId ─────────────────────────────────────────────
// Poll job status
router.get("/job/:queue/:jobId", async (req, res, next) => {
  try {
    const { queue: queueName, jobId } = req.params;

    const queueMap: Record<string, (typeof queues)[keyof typeof queues]> = {
      "ai-classify": queues.aiClassify,
      "ai-summary": queues.aiSummary,
      "ai-prep": queues.aiPrep,
    };

    const q = queueMap[queueName];
    if (!q) {
      res.status(400).json({ error: "Unknown queue" });
      return;
    }

    const job = await q.getJob(jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    const state = await job.getState();
    const returnValue = job.returnvalue;

    res.json({ jobId: job.id, state, returnValue });
  } catch (err) {
    next(err);
  }
});

export default router;
