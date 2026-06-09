import { Router } from "express";
import { slackService } from "../services/slack.service";

const router = Router();
export const slackCallbackRouter = Router();

router.get("/status", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    res.json(await slackService.getStatus(userId));
  } catch (err) { next(err); }
});

router.get("/connect-url", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    res.json({ url: slackService.buildAuthUrl(userId) });
  } catch (err) { next(err); }
});

router.post("/sync", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    res.json(await slackService.sync(userId));
  } catch (err) { next(err); }
});

router.delete("/disconnect", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    await slackService.disconnect(userId);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// OAuth callback — no auth required
slackCallbackRouter.get("/callback", async (req, res) => {
  const { code, state, error } = req.query as Record<string, string>;
  if (error || !code) {
    console.error("[slack callback] Slack returned error or no code:", { error, hasCode: !!code, query: req.query });
    res.redirect(`${process.env.FRONTEND_URL || "http://localhost:3000"}/dashboard/settings?slack=error`);
    return;
  }
  try {
    await slackService.handleCallback(code, state);
    res.redirect(`${process.env.FRONTEND_URL || "http://localhost:3000"}/dashboard/settings?slack=connected`);
  } catch (err) {
    console.error("[slack callback]", err);
    res.redirect(`${process.env.FRONTEND_URL || "http://localhost:3000"}/dashboard/settings?slack=error`);
  }
});

export default router;
