import { Router } from "express";
import { linkedinService } from "../services/linkedin.service";

const router = Router();

export const linkedinCallbackRouter = Router();
linkedinCallbackRouter.get("/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query as { code?: string; state?: string; error?: string; error_description?: string };
  if (error || !code || !state) {
    console.error("[linkedin-callback] LinkedIn returned error:", error, error_description);
    res.redirect(linkedinService.callbackErrorRedirect);
    return;
  }
  try {
    await linkedinService.handleCallback(code, state);
    res.redirect(linkedinService.callbackRedirect);
  } catch (err) {
    console.error("[linkedin-callback] handleCallback error:", err);
    res.redirect(linkedinService.callbackErrorRedirect);
  }
});

router.get("/status", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    res.json(await linkedinService.getStatus(userId));
  } catch (err) { next(err); }
});

router.get("/connect-url", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const url = linkedinService.buildAuthUrl(userId);
    res.json({ url });
  } catch (err) { next(err); }
});

router.delete("/disconnect", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    await linkedinService.disconnect(userId);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post("/cookie", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const { cookie } = req.body as { cookie?: string };
    if (!cookie?.trim()) {
      res.status(400).json({ error: "cookie is required" });
      return;
    }
    await linkedinService.saveCookie(userId, cookie.trim());
    // Trigger an immediate sync after saving cookie
    const { queues, DEFAULT_JOB_OPTIONS } = await import("../lib/queues");
    await queues.linkedinSync.add("linkedin-sync-immediate", { userId }, DEFAULT_JOB_OPTIONS);
    res.json({ ok: true });
  } catch (err: any) { next(err); }
});

router.post("/sync", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const { queues, DEFAULT_JOB_OPTIONS } = await import("../lib/queues");
    await queues.linkedinSync.add("linkedin-sync-manual", { userId }, DEFAULT_JOB_OPTIONS);
    res.json({ ok: true, message: "Sync queued" });
  } catch (err) { next(err); }
});

export default router;
