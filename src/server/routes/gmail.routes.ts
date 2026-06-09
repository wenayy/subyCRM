import { Router } from "express";
import {
  buildAuthUrl,
  verifyState,
  exchangeCode,
  saveTokens,
  getStatus,
  syncThreads,
  getThreads,
} from "../services/gmail.service";
import { prisma } from "../lib/prisma";

// ── Auth-protected routes (registered after requireAuth) ─────────────────────
export const gmailRouter = Router();

// GET /api/gmail/status
gmailRouter.get("/status", async (_req, res, next) => {
  try {
    const userId = res.locals.session.user.id as string;
    const result = await getStatus(userId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/gmail/connect-url
gmailRouter.get("/connect-url", (_req, res, next) => {
  try {
    const userId = res.locals.session.user.id as string;
    const url = buildAuthUrl(userId);
    console.log(`[gmail] connect-url for user ${userId}`);
    res.json({ url });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/gmail/disconnect
gmailRouter.delete("/disconnect", async (_req, res, next) => {
  try {
    const userId = res.locals.session.user.id as string;
    await (prisma as any).gmailToken.deleteMany({ where: { userId } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/gmail/sync
gmailRouter.post("/sync", async (_req, res, next) => {
  try {
    const userId = res.locals.session.user.id as string;
    const count = await syncThreads(userId);
    res.json({ synced: count });
  } catch (err) {
    next(err);
  }
});

// GET /api/gmail/threads
gmailRouter.get("/threads", async (req, res, next) => {
  try {
    const contactId = req.query.contactId as string | undefined;
    const threads = await getThreads(contactId);
    res.json(threads);
  } catch (err) {
    next(err);
  }
});

// ── OAuth callback — registered BEFORE requireAuth ────────────────────────────
export const gmailCallbackRouter = Router();

// GET /api/gmail/callback
gmailCallbackRouter.get("/callback", async (req, res) => {
  const { code, state, error } = req.query as Record<string, string>;
  const frontendBase = process.env.FRONTEND_URL?.split(",")[0] || "http://localhost:3000";

  console.log("[gmail callback] received", { hasCode: !!code, hasState: !!state, error });

  if (error || !code || !state) {
    return res.redirect(`${frontendBase}/dashboard/settings?gmail=error&reason=missing_params`);
  }

  const userId = verifyState(state);
  if (!userId) {
    console.error("[gmail callback] invalid or expired state");
    return res.redirect(`${frontendBase}/dashboard/settings?gmail=error&reason=expired_state`);
  }

  console.log(`[gmail callback] verified state for user ${userId}`);

  try {
    const tokens = await exchangeCode(code);
    await saveTokens(userId, tokens);
    console.log("[gmail callback] tokens saved");
  } catch (err) {
    console.error("[gmail callback] token exchange failed:", err);
    return res.redirect(`${frontendBase}/dashboard/settings?gmail=error&reason=token_save`);
  }

  // Sync in background
  syncThreads(userId)
    .then((n) => console.log(`[gmail] synced ${n} threads for user ${userId}`))
    .catch((err) => console.error("[gmail] sync failed:", err));

  return res.redirect(`${frontendBase}/dashboard/settings?gmail=connected`);
});
