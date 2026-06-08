import { Router } from "express";
import { prisma } from "../lib/prisma";
import crypto from "crypto";

const router = Router();

// GET /api/telegram-bot/username — returns the configured bot's username
router.get("/username", async (_req, res, next) => {
  try {
    const { getBotUsername } = await import("../services/telegram-bot.service");
    res.json({ username: await getBotUsername() });
  } catch (err) { next(err); }
});

// GET /api/telegram-bot/status
router.get("/status", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const link = await (prisma as any).telegramBotLink.findUnique({ where: { userId } });
    res.json({ linked: !!link, chatId: link?.chatId ?? null, linkedAt: link?.linkedAt ?? null });
  } catch (err) { next(err); }
});

// POST /api/telegram-bot/generate-token — returns a one-time code the user sends to the bot
router.post("/generate-token", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    // Invalidate any previous tokens for this user
    await (prisma as any).telegramBotLinkToken.deleteMany({ where: { userId } });
    const token = "LINK-" + crypto.randomBytes(4).toString("hex").toUpperCase();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
    await (prisma as any).telegramBotLinkToken.create({ data: { userId, token, expiresAt } });
    res.json({ token });
  } catch (err) { next(err); }
});

// POST /api/telegram-bot/unlink
router.post("/unlink", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    await (prisma as any).telegramBotLink.deleteMany({ where: { userId } });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
