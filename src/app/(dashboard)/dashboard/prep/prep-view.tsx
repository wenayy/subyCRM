"use client";

import { useState, useMemo, useEffect } from "react";
import { type CalendarEvent, type CallChannel } from "@/lib/mock-events";
import type { Contact } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { calendarApi, aiApi, contactsApi } from "@/lib/api";

const HOUR_HEIGHT = 48; // px per hour
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const CHANNEL_META: Record<CallChannel, { label: string; bg: string; color: string; border: string; icon: string }> = {
  zoom:      { label: "Zoom",         bg: "rgba(45,140,255,0.18)",  color: "#93c5fd", border: "#2D8CFF", icon: "🎥" },
  meet:      { label: "Google Meet",  bg: "rgba(52,168,83,0.18)",   color: "#86efac", border: "#34A853", icon: "📹" },
  phone:     { label: "Phone call",   bg: "rgba(234,179,8,0.18)",   color: "#fde047", border: "#ca8a04", icon: "📞" },
  in_person: { label: "In person",    bg: "rgba(249,115,22,0.18)",  color: "#fdba74", border: "#ea580c", icon: "🤝" },
  telegram:  { label: "Telegram",     bg: "rgba(34,158,217,0.18)",  color: "#7dd3fc", border: "#229ED9", icon: "✈️" },
  x_space:   { label: "X Space",      bg: "rgba(139,92,246,0.18)",  color: "#c4b5fd", border: "#8b5cf6", icon: "🎙️" },
};

// For real synced events that may not match a CallChannel, derive a vivid color from the title hash
const HASH_PALETTE = [
  { bg: "rgba(59,130,246,0.18)",  border: "#3b82f6", color: "#93c5fd" },  // blue
  { bg: "rgba(16,185,129,0.18)",  border: "#10b981", color: "#6ee7b7" },  // emerald
  { bg: "rgba(236,72,153,0.18)",  border: "#ec4899", color: "#f9a8d4" },  // pink
  { bg: "rgba(139,92,246,0.18)",  border: "#8b5cf6", color: "#c4b5fd" },  // violet
  { bg: "rgba(249,115,22,0.18)",  border: "#f97316", color: "#fdba74" },  // orange
  { bg: "rgba(234,179,8,0.18)",   border: "#eab308", color: "#fde047" },  // yellow
  { bg: "rgba(6,182,212,0.18)",   border: "#06b6d4", color: "#67e8f9" },  // cyan
  { bg: "rgba(244,63,94,0.18)",   border: "#f43f5e", color: "#fda4af" },  // rose
  { bg: "rgba(34,197,94,0.18)",   border: "#22c55e", color: "#86efac" },  // green
  { bg: "rgba(168,85,247,0.18)",  border: "#a855f7", color: "#d8b4fe" },  // purple
];

function hashColor(str: string) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return HASH_PALETTE[h % HASH_PALETTE.length];
}


function startOfWeek(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function fmtRange(start: Date, end: Date): string {
  const s = `${start.getDate()} ${MONTHS[start.getMonth()]}`;
  const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
  const e = sameMonth
    ? `${end.getDate()}, ${end.getFullYear()}`
    : `${end.getDate()} ${MONTHS[end.getMonth()]}, ${end.getFullYear()}`;
  return `${s} – ${e}`;
}

function fmtTime(d: Date): string {
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || "").join("");
}

function eventTone(e: CalendarEvent): { bg: string; border: string; color: string } {
  // Hash on the event ID so every event gets its own distinct color
  return hashColor(e.id ?? e.title ?? "");
}

export function PrepView() {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [selected, setSelected] = useState<CalendarEvent | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [calStatus, setCalStatus] = useState<{ connected: boolean; lastSync: string | null } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [calError, setCalError] = useState<string | null>(null);

  // Check connection status and load real events on mount
  useEffect(() => {
    calendarApi.status()
      .then((status) => {
        setCalStatus(status);
        if (status.connected) {
          return calendarApi.getEvents().then((data) => {
            // Replace mock data with real data (even if empty — real empty is better than fake data)
            setEvents(data as unknown as CalendarEvent[]);
          });
        }
      })
      .catch((err) => { console.warn("[prep] calendar status failed:", err); });

    const params = new URLSearchParams(window.location.search);
    const cal = params.get("calendar");

    if (cal === "error") {
      window.history.replaceState({}, "", window.location.pathname);
      setCalError("Google Calendar connection failed. Check backend logs — likely db:push not run.");
      return;
    }
    if (cal === "expired") {
      window.history.replaceState({}, "", window.location.pathname);
      setCalError("OAuth state expired. Try connecting again.");
      return;
    }

    // After OAuth redirect, poll until sync finishes (runs in background on server)
    if (cal === "connected") {
      window.history.replaceState({}, "", window.location.pathname);
      setSyncing(true);
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        try {
          const status = await calendarApi.status();
          setCalStatus(status);
          if (status.lastSync || attempts >= 8) {
            clearInterval(poll);
            setSyncing(false);
            const data = await calendarApi.getEvents();
            setEvents(data as unknown as CalendarEvent[]);
          }
        } catch {
          clearInterval(poll);
          setSyncing(false);
        }
      }, 1500);
    }
  }, []);

  async function handleConnect() {
    try {
      const { url } = await calendarApi.connectUrl();
      window.location.href = url;
    } catch { /* ignore */ }
  }

  async function handleSync() {
    setSyncing(true);
    try {
      await calendarApi.sync();
      const data = await calendarApi.getEvents();
      setEvents(data as unknown as CalendarEvent[]);
      const status = await calendarApi.status();
      setCalStatus(status);
    } catch { /* ignore */ } finally {
      setSyncing(false);
    }
  }

  const hourStart = 0;
  const hourEnd = 24;

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const weekEnd = useMemo(() => addDays(weekStart, 6), [weekStart]);

  const eventsByDay = useMemo(() => {
    const map: Record<number, CalendarEvent[]> = {};
    for (let i = 0; i < 7; i++) map[i] = [];
    for (const e of events) {
      const start = new Date(e.start);
      for (let i = 0; i < 7; i++) {
        if (start.toDateString() === days[i].toDateString()) {
          map[i].push(e);
          break;
        }
      }
    }
    for (const k of Object.keys(map)) {
      map[+k].sort((a, b) => +new Date(a.start) - +new Date(b.start));
    }
    return map;
  }, [days, events]);

  const totalEvents = Object.values(eventsByDay).reduce((s, v) => s + v.length, 0);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {calError && (
        <div style={{ padding: "10px 14px", background: "var(--rb)", border: "1px solid var(--rc)", borderRadius: 8, fontSize: 13, color: "var(--rc)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>{calError}</span>
          <button onClick={() => setCalError(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--rc)", fontWeight: 700 }}>×</button>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 className="text-xl font-bold tracking-tight">Pre-call</h1>
          <p style={{ color: "var(--t2)", fontSize: 13, marginTop: 4 }}>
            {totalEvents} call{totalEvents !== 1 ? "s" : ""} this week
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Button size="sm" variant="outline" onClick={() => setWeekStart(addDays(weekStart, -7))}>← Prev</Button>
          <Button size="sm" variant="outline" onClick={() => setWeekStart(startOfWeek(new Date()))}>This week</Button>
          <Button size="sm" variant="outline" onClick={() => setWeekStart(addDays(weekStart, 7))}>Next →</Button>
          <span style={{ fontSize: 13, color: "var(--t2)", marginLeft: 8, fontWeight: 500 }}>
            {fmtRange(weekStart, weekEnd)}
          </span>
          {calStatus?.connected ? (
            <Button size="sm" variant="outline" onClick={handleSync} disabled={syncing}>
              {syncing ? "Syncing…" : "↻ Sync"}
            </Button>
          ) : calStatus !== null ? (
            <Button size="sm" variant="outline" onClick={handleConnect} style={{ borderColor: "#4285F4", color: "#4285F4" }}>
              Connect Google Calendar
            </Button>
          ) : null}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card shadow-sm" style={{ overflow: "auto" }}>
        <div className="agenda">
          {/* Day headers */}
          <div className="agenda-corner" />
          {days.map((d, i) => {
            const isToday = d.getTime() === today.getTime();
            return (
              <div key={i} className="agenda-dayhead" style={{ background: isToday ? "var(--bb)" : "var(--sf2)" }}>
                <div style={{ fontSize: 11, color: isToday ? "var(--bc)" : "var(--t3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.04 }}>
                  {DAY_LABELS[i]}
                </div>
                <div style={{ fontSize: 16, color: isToday ? "var(--bc)" : "var(--t1)", fontWeight: 700, marginTop: 2 }}>
                  {d.getDate()}
                </div>
              </div>
            );
          })}

          {/* Hour rows + day columns */}
          <div className="agenda-times">
            {Array.from({ length: hourEnd - hourStart }, (_, i) => {
              const h = hourStart + i;
              return (
                <div key={h} className="agenda-time" style={{ height: HOUR_HEIGHT }}>
                  <span>{h.toString().padStart(2, "0")}:00</span>
                </div>
              );
            })}
          </div>

          {days.map((d, dayIdx) => {
            const isToday = d.getTime() === today.getTime();
            return (
              <div key={dayIdx} className="agenda-day" style={{ height: HOUR_HEIGHT * (hourEnd - hourStart), background: isToday ? "rgba(37,99,235,0.03)" : "transparent" }}>
                {/* Hour gridlines */}
                {Array.from({ length: hourEnd - hourStart }, (_, i) => (
                  <div key={i} className="agenda-gridline" style={{ top: i * HOUR_HEIGHT }} />
                ))}

                {/* Events */}
                {eventsByDay[dayIdx].map((e) => {
                  const start = new Date(e.start);
                  const end = new Date(e.end);
                  const hourFromStart = start.getHours() + start.getMinutes() / 60 - hourStart;
                  const durHours = (end.getTime() - start.getTime()) / 3600000;
                  const top = Math.max(0, hourFromStart) * HOUR_HEIGHT;
                  const gridHeight = (hourEnd - hourStart) * HOUR_HEIGHT;
                  const rawHeight = Math.max(30, durHours * HOUR_HEIGHT - 2);
                  const height = Math.min(rawHeight, gridHeight - top);
                  if (height <= 0) return null;
                  const tone = eventTone(e);
                  const showContact = e.contactName && e.contactName !== e.title;
                  return (
                    <button
                      key={e.id}
                      onClick={() => setSelected(e)}
                      className="agenda-event"
                      style={{
                        top,
                        height,
                        background: tone.bg,
                        borderLeft: `3px solid ${tone.border}`,
                      }}
                    >
                      <div style={{ fontSize: 11, fontWeight: 700, color: tone.color, lineHeight: 1.25, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {e.title}
                      </div>
                      <div style={{ fontSize: 10, color: tone.color, opacity: 0.7, marginTop: 1 }}>
                        {fmtTime(start)}{showContact ? ` · ${e.contactName}` : ""}
                      </div>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      <Dialog open={!!selected} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <DialogContent className="max-w-[560px] p-0 overflow-hidden gap-0">
          {selected && <EventModalContent event={selected} />}
        </DialogContent>
      </Dialog>

      <style>{`
        .agenda {
          display: grid;
          grid-template-columns: 56px repeat(7, minmax(120px, 1fr));
          grid-template-rows: 56px auto;
          min-width: 880px;
        }
        .agenda-corner {
          background: var(--sf2);
          border-bottom: 1px solid var(--bd);
          border-right: 1px solid var(--bd);
        }
        .agenda-dayhead {
          padding: 8px 12px;
          border-bottom: 1px solid var(--bd);
          border-right: 1px solid var(--bd);
          text-align: left;
        }
        .agenda-dayhead:last-child {
          border-right: none;
        }
        .agenda-times {
          border-right: 1px solid var(--bd);
          position: relative;
        }
        .agenda-time {
          font-size: 10px;
          color: var(--t3);
          font-variant-numeric: tabular-nums;
          padding: 2px 6px 0 0;
          text-align: right;
          border-bottom: 1px dashed transparent;
          position: relative;
        }
        .agenda-time span {
          position: relative;
          top: -6px;
        }
        .agenda-day {
          position: relative;
          border-right: 1px solid var(--bd);
        }
        .agenda-day:last-child {
          border-right: none;
        }
        .agenda-gridline {
          position: absolute;
          left: 0;
          right: 0;
          border-bottom: 1px solid var(--bd);
          height: 0;
        }
        .agenda-event {
          position: absolute;
          left: 4px;
          right: 4px;
          padding: 4px 8px;
          border-radius: 6px;
          border: 1px solid transparent;
          cursor: pointer;
          text-align: left;
          overflow: hidden;
          transition: box-shadow 0.12s, transform 0.12s;
        }
        .agenda-event:hover {
          box-shadow: var(--shadow);
          transform: translateY(-1px);
        }
      `}</style>
    </div>
  );
}

function EventModalContent({ event }: { event: CalendarEvent }) {
  const start = new Date(event.start);
  const end = new Date(event.end);
  const channelMeta = event.channel ? CHANNEL_META[event.channel as CallChannel] ?? null : null;
  const fallbackTone = hashColor(event.id ?? event.title ?? "");
  const isLink = event.location && /^https?:\/\//.test(event.location);

  const [contact, setContact] = useState<Contact | null>(null);
  const [briefing, setBriefing] = useState<string | null>(null);
  const [briefingLoading, setBriefingLoading] = useState(false);

  useEffect(() => {
    if (!event.contactId) return;
    contactsApi.getById(event.contactId).then(setContact).catch(() => {});
    setBriefingLoading(true);
    aiApi.prep(event.contactId)
      .then((res) => setBriefing(res.briefing ?? null))
      .catch(() => setBriefing("Could not generate briefing."))
      .finally(() => setBriefingLoading(false));
  }, [event.contactId]);

  const sections = useMemo(() => (briefing ? parseBriefing(briefing) : []), [briefing]);

  const bg = channelMeta?.bg ?? fallbackTone.bg;
  const borderColor = channelMeta?.color ?? fallbackTone.border;
  const iconColor = channelMeta?.color ?? fallbackTone.color;

  return (
    <>
      {/* Header */}
      <div style={{ padding: "18px 22px", borderBottom: "1px solid var(--bd)", display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, color: "var(--t3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.04 }}>
            {start.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })} · {fmtTime(start)}–{fmtTime(end)}
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, color: "var(--t1)", letterSpacing: "-0.02em", marginTop: 2 }}>
            {event.contactName || event.title}
          </div>
          {contact && [contact.role, contact.company].filter(Boolean).length > 0 && (
            <div style={{ fontSize: 12, color: "var(--t2)", marginTop: 2 }}>
              {[contact.role, contact.company].filter(Boolean).join(" @ ")}
            </div>
          )}
        </div>
      </div>

      {/* Body */}
      <div style={{ overflowY: "auto", padding: "18px 22px", display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Call link / channel */}
        {isLink ? (
          <a
            href={event.location}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "flex", alignItems: "center", gap: 12,
              padding: "12px 14px",
              background: bg, borderRadius: 10,
              border: `1px solid ${borderColor}30`,
              textDecoration: "none",
              transition: "border-color 0.12s",
            }}
          >
            <span style={{ fontSize: 22 }}>{channelMeta?.icon ?? "📅"}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--t1)" }}>
                Join {channelMeta?.label ?? "Meeting"}
              </div>
              <div className="font-mono text-xs tabular-nums" style={{ fontSize: 11, color: "var(--t2)", marginTop: 2, wordBreak: "break-all" }}>
                {event.location}
              </div>
            </div>
            <span style={{ fontSize: 13, color: iconColor, fontWeight: 600 }}>→</span>
          </a>
        ) : (event.location || channelMeta) ? (
          <div
            style={{
              display: "flex", alignItems: "center", gap: 12,
              padding: "12px 14px",
              background: bg, borderRadius: 10,
              border: `1px solid ${borderColor}30`,
            }}
          >
            <span style={{ fontSize: 22 }}>{channelMeta?.icon ?? "📅"}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--t1)" }}>{channelMeta?.label ?? "Meeting"}</div>
              {event.location && (
                <div style={{ fontSize: 12, color: "var(--t2)", marginTop: 2 }}>{event.location}</div>
              )}
            </div>
          </div>
        ) : null}

        {/* Pre-qualification */}
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <div className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">Pre-qualification</div>
            <Badge variant="purple" style={{ fontSize: 10 }}>AI</Badge>
          </div>

          {!event.contactId ? (
            <div style={{ fontSize: 12, color: "var(--t2)", padding: "10px 14px", background: "var(--sf2)", border: "1px solid var(--bd)", borderRadius: 8 }}>
              No contact matched for this event. Save this person as a contact to get AI briefings.
            </div>
          ) : briefingLoading ? (
            <div style={{ fontSize: 12, color: "var(--t2)", padding: "10px 14px", background: "var(--sf2)", border: "1px solid var(--bd)", borderRadius: 8 }}>
              Generating briefing…
            </div>
          ) : sections.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {sections.filter((s) => s.content.trim()).map((s, i) => (
                <div
                  key={i}
                  style={{
                    padding: "10px 14px",
                    background: "var(--sf2)",
                    border: "1px solid var(--bd)",
                    borderRadius: 8,
                  }}
                >
                  {s.title && (
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--t1)", marginBottom: 4 }}>
                      {s.title}
                    </div>
                  )}
                  <div style={{ fontSize: 12, color: "var(--t2)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                    {s.content}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "var(--t2)", padding: "10px 14px", background: "var(--sf2)", border: "1px solid var(--bd)", borderRadius: 8 }}>
              No briefing available.
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function parseBriefing(text: string): { title: string; content: string }[] {
  const sections: { title: string; content: string }[] = [];
  const lines = text.split("\n");
  let title = "";
  let buf: string[] = [];
  for (const line of lines) {
    const m = line.match(/^#{1,3}\s+(.+)/) || line.match(/^\*\*(.+?)\*\*\s*$/);
    if (m) {
      if (title || buf.length) sections.push({ title, content: buf.join("\n").trim() });
      title = m[1].replace(/\*\*/g, "").trim();
      buf = [];
    } else {
      buf.push(line);
    }
  }
  if (title || buf.length) sections.push({ title, content: buf.join("\n").trim() });
  return sections.length ? sections : [{ title: "", content: text }];
}
