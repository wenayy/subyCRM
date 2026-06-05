import { Router } from "express";
import { xService } from "../services/x.service";

const router = Router();

// Unauthenticated callback router (registered before requireAuth in index.ts)
export const xCallbackRouter = Router();
xCallbackRouter.get("/callback", async (req, res) => {
  const { oauth_token, oauth_verifier } = req.query as { oauth_token?: string; oauth_verifier?: string };
  if (!oauth_token || !oauth_verifier) {
    res.redirect(xService.callbackErrorRedirect);
    return;
  }
  try {
    await xService.handleCallback(oauth_token, oauth_verifier);
    res.redirect(xService.callbackRedirect);
  } catch (err) {
    console.error("[x-callback]", err);
    res.redirect(xService.callbackErrorRedirect);
  }
});

router.get("/status", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    res.json(await xService.getStatus(userId));
  } catch (err) { next(err); }
});

router.get("/connect-url", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const url = await xService.buildAuthUrl(userId);
    res.json({ url });
  } catch (err) { next(err); }
});

router.post("/cookie", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const { authToken, ct0 } = req.body as { authToken: string; ct0: string };
    if (!authToken?.trim() || !ct0?.trim()) {
      res.status(400).json({ error: "auth_token and ct0 are required" });
      return;
    }
    const result = await xService.saveCookie(userId, authToken.trim(), ct0.trim());
    xService.syncWithCookie(userId).catch(console.error);
    res.json({ connected: true, screenName: result.screenName });
  } catch (err) { next(err); }
});

// Legacy manual credentials (kept as fallback)
router.post("/connect", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const { accessToken, accessTokenSecret, apiKey, apiSecret } = req.body as {
      accessToken: string; accessTokenSecret: string; apiKey?: string; apiSecret?: string;
    };
    const resolvedApiKey = apiKey || process.env.X_CONSUMER_KEY;
    const resolvedApiSecret = apiSecret || process.env.X_CONSUMER_SECRET;
    
    if (!accessToken || !accessTokenSecret || !resolvedApiKey || !resolvedApiSecret) {
      res.status(400).json({ error: "Access tokens and API credentials required" });
      return;
    }
    const result = await xService.saveCredentials(userId, {
      accessToken,
      accessTokenSecret,
      apiKey: resolvedApiKey,
      apiSecret: resolvedApiSecret
    });
    xService.sync(userId).catch(console.error);
    res.json({ connected: true, ...result });
  } catch (err) { next(err); }
});

router.post("/sync", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    res.json(await xService.sync(userId));
  } catch (err) { next(err); }
});

router.delete("/disconnect", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    await xService.disconnect(userId);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
