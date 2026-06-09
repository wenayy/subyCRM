import { Router } from "express";
import { whatsappService } from "../services/whatsapp.service";
import { queues } from "../lib/queues";
import { prisma } from "../lib/prisma";

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

// POST /api/whatsapp/sync-contacts — re-trigger WhatsApp contacts import
router.post("/sync-contacts", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const contacts = whatsappService.getContactsForImport(userId);
    if (!contacts.length) {
      res.status(400).json({ error: "WhatsApp not connected or no contacts in cache. Make sure WhatsApp is connected." });
      return;
    }
    const job = await prisma.importJob.create({
      data: { userId, source: "whatsapp_export", status: "running", startedAt: new Date() },
    });
    await queues.whatsappImport.add("whatsapp-import", { userId, importJobId: job.id });
    res.json({ ok: true, jobId: job.id, contactCount: contacts.length });
  } catch (err) { next(err); }
});

export default router;
