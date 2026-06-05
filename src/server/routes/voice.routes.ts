import { Router } from "express";
import { prisma } from "../lib/prisma";
import { processVoiceCapture } from "../services/telegram-bot.service";

export const voiceRouter = Router();

// GET /api/voice/captures
voiceRouter.get("/captures", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const rows = await (prisma as any).voiceCapture.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    res.json(rows.map((r: any) => ({
      ...r,
      dueDate: r.dueDate?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })));
  } catch (err) { next(err); }
});

// GET /api/voice/stats
voiceRouter.get("/stats", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const all = await (prisma as any).voiceCapture.findMany({
      where: { userId },
      select: { action: true, status: true },
    });
    res.json({
      total: all.length,
      processed: all.filter((r: any) => r.status === "processed").length,
      failed: all.filter((r: any) => r.status === "failed").length,
      actions: all.filter((r: any) => r.action !== "unknown" && r.status === "processed").length,
    });
  } catch (err) { next(err); }
});

// POST /api/voice/simulate  { transcript: string }
voiceRouter.post("/simulate", async (req, res, next) => {
  try {
    const { transcript } = req.body as { transcript: string };
    if (!transcript?.trim()) { res.status(400).json({ error: "transcript required" }); return; }
    const result = await processVoiceCapture(transcript.trim());
    res.json(result);
  } catch (err) { next(err); }
});
