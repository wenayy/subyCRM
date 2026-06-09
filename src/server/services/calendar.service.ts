import { google } from "googleapis";
import { createHmac } from "crypto";
import { prisma } from "../lib/prisma";
import { encrypt, decrypt } from "../lib/encryption";

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const REDIRECT_URI = `${process.env.AUTH_BASE_URL || "http://localhost:4002"}/api/calendar/callback`;

function oauthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    REDIRECT_URI,
  );
}

// ── State signing — no in-memory map, survives backend restarts ───────────────
const STATE_SECRET = process.env.BETTER_AUTH_SECRET || "suby-calendar-state-secret";

export function buildState(userId: string): string {
  const payload = `${userId}:${Date.now()}`;
  const sig = createHmac("sha256", STATE_SECRET).update(payload).digest("hex");
  return Buffer.from(`${payload}:${sig}`).toString("base64url");
}

export function verifyState(state: string): string | null {
  try {
    const decoded = Buffer.from(state, "base64url").toString("utf8");
    const parts = decoded.split(":");
    if (parts.length !== 3) return null;
    const [userId, ts, sig] = parts;
    // Expire after 15 minutes
    if (Date.now() - parseInt(ts) > 15 * 60_000) return null;
    const expected = createHmac("sha256", STATE_SECRET).update(`${userId}:${ts}`).digest("hex");
    if (sig !== expected) return null;
    return userId;
  } catch {
    return null;
  }
}

export function buildAuthUrl(userId: string): string {
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    scope: CALENDAR_SCOPE,
    prompt: "consent",
    state: buildState(userId),
  });
}

export async function exchangeCode(code: string) {
  const { tokens } = await oauthClient().getToken(code);
  return tokens;
}

export async function saveTokens(
  userId: string,
  tokens: { access_token?: string | null; refresh_token?: string | null; expiry_date?: number | null },
) {
  await prisma.googleCalendarToken.upsert({
    where: { userId },
    create: {
      userId,
      accessToken: encrypt(tokens.access_token!),
      refreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
      expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    },
    update: {
      accessToken: encrypt(tokens.access_token!),
      ...(tokens.refresh_token ? { refreshToken: encrypt(tokens.refresh_token) } : {}),
      expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    },
  });
}

export async function getStatus(userId: string) {
  const token = await prisma.googleCalendarToken.findUnique({ where: { userId } });
  return { connected: !!token, lastSync: token?.lastSyncAt?.toISOString() ?? null };
}

async function authedClient(userId: string) {
  const token = await prisma.googleCalendarToken.findUnique({ where: { userId } });
  if (!token) throw new Error("Google Calendar not connected");

  const client = oauthClient();
  client.setCredentials({
    access_token: decrypt(token.accessToken),
    refresh_token: token.refreshToken ? decrypt(token.refreshToken) : null,
    expiry_date: token.expiresAt?.getTime(),
  });

  // Persist refreshed tokens automatically
  client.on("tokens", async (fresh) => {
    if (fresh.access_token) {
      await saveTokens(userId, fresh);
    }
  });

  return client;
}

function detectChannel(event: {
  conferenceData?: { conferenceSolution?: { name?: string }; entryPoints?: { entryPointType: string; uri: string }[] };
  description?: string | null;
  location?: string | null;
}): string {
  const desc = (event.description ?? "").toLowerCase();
  const loc = (event.location ?? "").toLowerCase();
  const confName = (event.conferenceData?.conferenceSolution?.name ?? "").toLowerCase();

  if (confName.includes("zoom") || desc.includes("zoom.us") || loc.includes("zoom.us")) return "zoom";
  if (confName.includes("meet") || desc.includes("meet.google.com") || loc.includes("meet.google.com")) return "meet";
  if (event.conferenceData?.entryPoints?.length) return "meet";
  if (/^https?:\/\//.test(event.location ?? "")) return "zoom";
  if (!event.location) return "phone";
  return "in_person";
}

function getMeetLink(event: {
  conferenceData?: { entryPoints?: { entryPointType: string; uri: string }[] };
  location?: string | null;
}): string | null {
  const video = event.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video");
  if (video) return video.uri;
  if (/^https?:\/\//.test(event.location ?? "")) return event.location!;
  return null;
}

export async function syncEvents(userId: string): Promise<number> {
  console.log("[syncEvents] starting for user", userId);
  const client = await authedClient(userId);
  const cal = google.calendar({ version: "v3", auth: client });

  const now = new Date();
  const timeMin = new Date(now.getTime() - 14 * 86400_000).toISOString();
  const timeMax = new Date(now.getTime() + 60 * 86400_000).toISOString();

  console.log("[syncEvents] fetching events from Google...");
  const res = await cal.events.list({
    calendarId: "primary",
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 500,
  });

  const items = res.data.items ?? [];
  console.log(`[syncEvents] Google returned ${items.length} events`);

  // Check if CalendarEvent model exists on Prisma client
  if (!(prisma as any).calendarEvent) {
    console.error("[syncEvents] FATAL: prisma.calendarEvent is undefined — run npm run db:generate");
    throw new Error("prisma.calendarEvent undefined — db:generate not run");
  }

  // Load contacts with email platforms for attendee matching
  console.log("[syncEvents] loading contacts from DB...");
  const contacts = await prisma.contact.findMany({
    include: { platforms: { where: { type: "email" } } },
  });
  console.log(`[syncEvents] loaded ${contacts.length} contacts`);
  const emailMap = new Map<string, { id: string; name: string }>();
  for (const c of contacts) {
    for (const p of c.platforms) {
      emailMap.set(p.platformId.toLowerCase(), { id: c.id, name: c.name });
    }
  }
  const nameMap = new Map<string, { id: string; name: string }>();
  for (const c of contacts) nameMap.set(c.name.toLowerCase(), { id: c.id, name: c.name });

  // Build rows to insert (skip cancelled / events with no dates)
  const rows: {
    googleId: string; title: string; start: Date; end: Date;
    contactId: string | null; contactName: string | null;
    channel: string; location: string | null;
    description: string | null; htmlLink: string | null;
  }[] = [];

  for (const ev of items) {
    if (!ev.id) continue;
    if (ev.status === "cancelled") continue;
    const startStr = ev.start?.dateTime ?? ev.start?.date;
    const endStr   = ev.end?.dateTime   ?? ev.end?.date;
    if (!startStr || !endStr) continue;

    const attendees = ev.attendees ?? [];
    let matched: { id: string; name: string } | null = null;
    for (const a of attendees) {
      if (a.self) continue;
      if (a.email && emailMap.has(a.email.toLowerCase())) { matched = emailMap.get(a.email.toLowerCase())!; break; }
      if (a.displayName && nameMap.has(a.displayName.toLowerCase())) { matched = nameMap.get(a.displayName.toLowerCase())!; break; }
    }

    const firstExternal = attendees.find((a) => !a.self);
    rows.push({
      googleId: ev.id,
      title: ev.summary ?? "Untitled",
      start: new Date(startStr),
      end: new Date(endStr),
      contactId: matched?.id ?? null,
      contactName: matched?.name ?? firstExternal?.displayName ?? firstExternal?.email ?? null,
      channel: detectChannel(ev),
      location: getMeetLink(ev) ?? ev.location ?? null,
      description: ev.description ?? null,
      htmlLink: ev.htmlLink ?? null,
    });
  }

  console.log(`[syncEvents] built ${rows.length} rows, saving to DB...`);

  const googleIds = rows.map((r) => r.googleId);

  // Remove any DB event in this time window that Google no longer returns (deleted on device)
  await (prisma as any).calendarEvent.deleteMany({
    where: {
      start: { gte: new Date(timeMin), lte: new Date(timeMax) },
      googleId: { notIn: googleIds },
    },
  });

  // Delete then re-insert the current batch (avoids pgbouncer upsert hangs)
  await (prisma as any).calendarEvent.deleteMany({ where: { googleId: { in: googleIds } } });
  await (prisma as any).calendarEvent.createMany({ data: rows });

  console.log(`[syncEvents] saved ${rows.length} events`);
  await prisma.googleCalendarToken.update({
    where: { userId },
    data: { lastSyncAt: new Date() },
  });

  return rows.length;
}

export async function getEvents(start?: Date, end?: Date) {
  return prisma.calendarEvent.findMany({
    where: {
      start: {
        ...(start ? { gte: start } : {}),
        ...(end ? { lte: end } : {}),
      },
    },
    orderBy: { start: "asc" },
  });
}
