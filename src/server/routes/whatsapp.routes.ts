import { Router } from "express";
import { whatsappService } from "../services/whatsapp.service";

const router = Router();

router.get("/status", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    res.json(await whatsappService.getStatus(userId));
  } catch (err) { next(err); }
});

router.post("/init", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const result = await whatsappService.initSession(userId);
    res.json(result);
  } catch (err) { next(err); }
});

router.get("/qr", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const qr = whatsappService.getQR(userId);
    res.json({ qr });
  } catch (err) { next(err); }
});

router.delete("/disconnect", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    await whatsappService.disconnect(userId);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
