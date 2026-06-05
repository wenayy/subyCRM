import { Router } from "express";
import { prisma } from "../lib/prisma";

const router = Router();

const TYPE_TO_CHANNEL: Record<string, string> = {
  email: "email",
  linkedin_message: "linkedin",
  twitter_dm: "x",
  telegram_message: "telegram",
  whatsapp_message: "whatsapp",
  wait: "wait",
  task: "task",
};

const CHANNEL_TO_TYPE: Record<string, string> = {
  email: "email",
  linkedin: "linkedin_message",
  x: "twitter_dm",
  telegram: "telegram_message",
  whatsapp: "whatsapp_message",
};

function fmtStep(s: any) {
  return {
    id: s.id,
    index: s.stepNumber,
    channel: TYPE_TO_CHANNEL[s.type] ?? s.type,
    delayDays: s.delayDays,
    scheduledFor: s.scheduledFor?.toISOString() ?? new Date().toISOString(),
    status: s.stepStatus ?? "waiting",
    draft: s.draft ?? s.body ?? "",
    rationale: s.rationale ?? "",
  };
}

function fmtSeq(seq: any) {
  return {
    id: seq.id,
    contactId: seq.contactId ?? null,
    contactName: seq.contactName ?? seq.name ?? "",
    company: seq.company ?? null,
    goal: seq.goal ?? seq.name ?? "",
    startedAt: seq.startedAt?.toISOString() ?? seq.createdAt.toISOString(),
    paused: seq.status === "paused",
    steps: (seq.steps ?? []).map(fmtStep),
  };
}

// GET /api/sequences
router.get("/", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const sequences = await (prisma as any).sequence.findMany({
      where: { userId },
      include: { steps: { orderBy: { stepNumber: "asc" } } },
      orderBy: { createdAt: "desc" },
    });
    res.json(sequences.map(fmtSeq));
  } catch (err) { next(err); }
});

// GET /api/sequences/:id
router.get("/:id", async (req, res, next) => {
  try {
    const seq = await (prisma as any).sequence.findUnique({
      where: { id: req.params.id },
      include: { steps: { orderBy: { stepNumber: "asc" } } },
    });
    if (!seq) { res.status(404).json({ error: "Not found" }); return; }
    res.json(fmtSeq(seq));
  } catch (err) { next(err); }
});

// POST /api/sequences
router.post("/", async (req, res, next) => {
  try {
    const { contactId, contactName, company, goal, steps } = req.body as {
      contactId?: string; contactName: string; company?: string; goal: string;
      steps?: Array<{ channel: string; delayDays?: number; draft?: string; rationale?: string; scheduledFor?: string }>;
    };
    if (!contactName?.trim() || !goal?.trim()) {
      res.status(400).json({ error: "contactName and goal are required" }); return;
    }

    // Try to auto-link a contact by name
    let resolvedContactId = contactId || null;
    if (!resolvedContactId && contactName) {
      const found = await prisma.contact.findFirst({
        where: { name: { contains: contactName, mode: "insensitive" } },
        select: { id: true },
      });
      if (found) resolvedContactId = found.id;
    }

    const userId = res.locals.session?.user?.id ?? "default";
    const seq = await (prisma as any).sequence.create({
      data: {
        userId,
        name: goal,
        contactId: resolvedContactId,
        contactName: contactName.trim(),
        company: company?.trim() || null,
        goal: goal.trim(),
        startedAt: new Date(),
        status: "active",
        steps: steps?.length ? {
          create: steps.map((s, i) => ({
            stepNumber: i + 1,
            type: CHANNEL_TO_TYPE[s.channel] ?? "email",
            delayDays: s.delayDays ?? 0,
            draft: s.draft ?? "",
            rationale: s.rationale ?? "",
            scheduledFor: s.scheduledFor ? new Date(s.scheduledFor) : new Date(Date.now() + (s.delayDays ?? 0) * 86400000),
            stepStatus: "waiting",
          })),
        } : undefined,
      },
      include: { steps: { orderBy: { stepNumber: "asc" } } },
    });
    res.status(201).json(fmtSeq(seq));
  } catch (err) { next(err); }
});

// PATCH /api/sequences/:id  (pause/resume, update goal)
router.patch("/:id", async (req, res, next) => {
  try {
    const { paused, goal, contactName, company } = req.body as {
      paused?: boolean; goal?: string; contactName?: string; company?: string;
    };
    const data: any = {};
    if (paused !== undefined) data.status = paused ? "paused" : "active";
    if (goal !== undefined) { data.goal = goal; data.name = goal; }
    if (contactName !== undefined) data.contactName = contactName;
    if (company !== undefined) data.company = company;
    const seq = await (prisma as any).sequence.update({
      where: { id: req.params.id },
      data,
      include: { steps: { orderBy: { stepNumber: "asc" } } },
    });
    res.json(fmtSeq(seq));
  } catch (err) { next(err); }
});

// PATCH /api/sequences/:id/steps/:stepId
router.patch("/:id/steps/:stepId", async (req, res, next) => {
  try {
    const { status, draft, rationale, scheduledFor } = req.body as {
      status?: string; draft?: string; rationale?: string; scheduledFor?: string;
    };
    const data: any = {};
    if (status !== undefined) data.stepStatus = status;
    if (draft !== undefined) data.draft = draft;
    if (rationale !== undefined) data.rationale = rationale;
    if (scheduledFor !== undefined) data.scheduledFor = new Date(scheduledFor);
    const step = await (prisma as any).sequenceStep.update({
      where: { id: req.params.stepId },
      data,
    });
    res.json(fmtStep(step));
  } catch (err) { next(err); }
});

// DELETE /api/sequences/:id
router.delete("/:id", async (req, res, next) => {
  try {
    await (prisma as any).sequence.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
