import { Router } from "express";
import { prisma } from "../lib/prisma";
import {
  buildAuthUrl,
  verifyState,
  exchangeCode,
  saveTokens,
  getStatus,
  syncEvents,
  getEvents,
} from "../services/calendar.service";

// ── Routes that require auth (registered after requireAuth in index.ts) ────────
export const calendarRouter = Router();

// GET /api/calendar/debug
calendarRouter.get("/debug", async (_req, res, next) => {
  try {
    const userId = res.locals.session.user.id as string;
    const token = await prisma.googleCalendarToken.findUnique({ where: { userId } }).catch(() => null);
    const eventCount = await prisma.calendarEvent.count().catch(() => -1);
    const sample = await prisma.calendarEvent.findMany({ take: 3, orderBy: { start: "asc" } }).catch(() => []);
    res.json({ userId, hasToken: !!token, lastSync: token?.lastSyncAt, eventCount, sample });
  } catch (err) {
    next(err);
  }
});

// GET /api/calendar/status
calendarRouter.get("/status", async (_req, res, next) => {
  try {
    const userId = res.locals.session.user.id as string;
    const result = await getStatus(userId);
    console.log(`[calendar] status userId=${userId} connected=${result.connected}`);
    res.json(result);
  } catch (err) {
    console.error("[calendar] status error:", err);
    next(err);
  }
});

// GET /api/calendar/connect-url — builds OAuth URL with signed state (no in-memory map)
calendarRouter.get("/connect-url", (req, res, next) => {
  try {
    const userId = res.locals.session.user.id as string;
    const url = buildAuthUrl(userId);
    console.log(`[calendar] connect-url for user ${userId}`);
    res.json({ url });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/calendar/disconnect
calendarRouter.delete("/disconnect", async (_req, res, next) => {
  try {
    const userId = res.locals.session.user.id as string;
    await prisma.googleCalendarToken.deleteMany({ where: { userId } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/calendar/sync
calendarRouter.post("/sync", async (_req, res, next) => {
  try {
    const userId = res.locals.session.user.id as string;
    const count = await syncEvents(userId);
    res.json({ synced: count });
  } catch (err) {
    next(err);
  }
});

// GET /api/calendar/events
calendarRouter.get("/events", async (req, res, next) => {
  try {
    const start = req.query.start ? new Date(req.query.start as string) : undefined;
    const end = req.query.end ? new Date(req.query.end as string) : undefined;
    const events = await getEvents(start, end);
    res.json(
      events.map((e) => ({
        id: e.id,
        googleId: e.googleId,
        title: e.title,
        start: e.start.toISOString(),
        end: e.end.toISOString(),
        contactId: e.contactId ?? "",
        contactName: e.contactName ?? e.title,
        channel: e.channel,
        location: e.location ?? undefined,
        description: e.description ?? undefined,
        htmlLink: e.htmlLink ?? undefined,
      })),
    );
  } catch (err) {
    next(err);
  }
});

// ── OAuth callback — registered BEFORE requireAuth in index.ts ────────────────
export const calendarCallbackRouter = Router();

// GET /api/calendar/callback
calendarCallbackRouter.get("/callback", async (req, res) => {
  const { code, state, error } = req.query as Record<string, string>;
  const frontendBase = process.env.FRONTEND_URL?.split(",")[0] || "http://localhost:3000";

  console.log("[calendar callback] received", { hasCode: !!code, hasState: !!state, error });

  if (error || !code || !state) {
    console.error("[calendar callback] missing params:", { error, hasCode: !!code, hasState: !!state });
    return res.redirect(`${frontendBase}/dashboard/prep?calendar=error&reason=missing_params`);
  }

  // Verify signed state — extracts userId without any in-memory map
  const userId = verifyState(state);
  if (!userId) {
    console.error("[calendar callback] invalid or expired state");
    return res.redirect(`${frontendBase}/dashboard/prep?calendar=error&reason=expired_state`);
  }

  console.log(`[calendar callback] verified state for user ${userId}`);

  try {
    const tokens = await exchangeCode(code);
    console.log("[calendar callback] got tokens, access_token:", !!tokens.access_token, "refresh_token:", !!tokens.refresh_token);
    await saveTokens(userId, tokens);
    console.log("[calendar callback] tokens saved");
  } catch (err) {
    console.error("[calendar callback] token exchange/save failed:", err);
    return res.redirect(`${frontendBase}/dashboard/prep?calendar=error&reason=token_save`);
  }

  // Sync in background
  syncEvents(userId)
    .then((n) => console.log(`[calendar] synced ${n} events for user ${userId}`))
    .catch((err) => console.error("[calendar] sync failed:", err));

  return res.redirect(`${frontendBase}/dashboard/prep?calendar=connected`);
});
