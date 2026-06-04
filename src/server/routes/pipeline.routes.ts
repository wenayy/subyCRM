import { Router } from "express";
import { prisma } from "../lib/prisma";

const router = Router();

function fmt(d: any) {
  return {
    id: d.id,
    contactId: d.contactId ?? null,
    contactName: d.contactName,
    companyId: d.companyId ?? null,
    companyName: d.companyName ?? "",
    stage: d.stage,
    value: d.value,
    probability: d.probability,
    enteredStageAt: d.enteredStageAt.toISOString(),
    nextStep: d.nextStep ?? null,
    source: d.source,
  };
}

// GET /api/pipeline
router.get("/", async (_req, res, next) => {
  try {
    const deals = await prisma.deal.findMany({ orderBy: { createdAt: "asc" } });
    res.json(deals.map(fmt));
  } catch (err) { next(err); }
});

// POST /api/pipeline
router.post("/", async (req, res, next) => {
  try {
    const { contactId, contactName, companyId, companyName, stage, value, probability, nextStep, source } = req.body as {
      contactId?: string; contactName: string; companyId?: string; companyName?: string;
      stage?: string; value?: number; probability?: number; nextStep?: string; source?: string;
    };
    if (!contactName?.trim()) { res.status(400).json({ error: "contactName is required" }); return; }
    const deal = await prisma.deal.create({
      data: {
        contactId: contactId || null,
        contactName: contactName.trim(),
        companyId: companyId || null,
        companyName: companyName?.trim() || null,
        stage: (stage as any) || "intro",
        value: value ?? 0,
        probability: probability ?? 20,
        nextStep: nextStep?.trim() || null,
        source: (source as any) || "outbound",
      },
    });
    res.status(201).json(fmt(deal));
  } catch (err) { next(err); }
});

// PATCH /api/pipeline/:id
router.patch("/:id", async (req, res, next) => {
  try {
    const { stage, value, probability, nextStep, source, contactName, companyName } = req.body as {
      stage?: string; value?: number; probability?: number; nextStep?: string;
      source?: string; contactName?: string; companyName?: string;
    };
    const data: any = {};
    if (stage !== undefined) { data.stage = stage; data.enteredStageAt = new Date(); }
    if (value !== undefined) data.value = value;
    if (probability !== undefined) data.probability = probability;
    if (nextStep !== undefined) data.nextStep = nextStep;
    if (source !== undefined) data.source = source;
    if (contactName !== undefined) data.contactName = contactName;
    if (companyName !== undefined) data.companyName = companyName;
    const deal = await prisma.deal.update({ where: { id: req.params.id }, data });
    res.json(fmt(deal));
  } catch (err) { next(err); }
});

// DELETE /api/pipeline/:id
router.delete("/:id", async (req, res, next) => {
  try {
    await prisma.deal.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
