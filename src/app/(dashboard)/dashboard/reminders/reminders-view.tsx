"use client";

import { useState, useEffect, useMemo } from "react";
import { remindersApi, contactsApi } from "@/lib/api";
import { MOCK_REMINDERS } from "@/lib/mock-reminders";
import { PlatformIcon } from "@/components/platform-icon";
import type { Reminder, ReminderStatus, PlatformType, Contact } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent } from "@/components/ui/dialog";

type Bucket = "overdue" | "today" | "this_week" | "later";

const BUCKETS: { key: Bucket; label: string; tone: string }[] = [
  { key: "overdue", label: "Overdue", tone: "var(--rc)" },
  { key: "today", label: "Today", tone: "var(--oc)" },
  { key: "this_week", label: "This week", tone: "var(--bc)" },
  { key: "later", label: "Later", tone: "var(--t3)" },
];

const BUCKET_BG: Record<Bucket, string> = {
  overdue: "var(--rb)",
  today: "var(--ob)",
  this_week: "var(--bb)",
  later: "var(--al)",
};

function bucketOf(dueDate: string): Bucket {
  const now = new Date();
  const due = new Date(dueDate);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const endOfToday = startOfToday + 86400000;
  const endOfWeek = startOfToday + 7 * 86400000;
  const t = due.getTime();
  if (t < startOfToday) return "overdue";
  if (t < endOfToday) return "today";
  if (t < endOfWeek) return "this_week";
  return "later";
}

function formatDue(dueDate: string): string {
  const now = new Date();
  const due = new Date(dueDate);
  const diffMs = due.getTime() - now.getTime();
  const days = Math.round(diffMs / 86400000);
  const sameDay = due.toDateString() === now.toDateString();
  if (sameDay) {
    const h = due.getHours().toString().padStart(2, "0");
    const m = due.getMinutes().toString().padStart(2, "0");
    return `${h}:${m}`;
  }
  if (days < -1) return `${-days}d ago`;
  if (days === -1) return "Yesterday";
  if (days === 1) return "Tomorrow";
  if (days < 7) return `In ${days}d`;
  return due.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || "").join("");
}

function platformLink(type: string, id: string): string | null {
  // Handle full URLs stored as platformId (e.g. www.linkedin.com/in/...)
  if (id.includes("linkedin.com")) return id.startsWith("http") ? id : `https://${id}`;
  switch (type) {
    case "x": return `https://x.com/${id.replace(/^@/, "")}`;
    case "linkedin": return `https://linkedin.com/in/${id.replace(/^@/, "")}`;
    case "telegram": return `https://t.me/${id.replace(/^@/, "")}`;
    case "whatsapp": return `https://wa.me/${id.replace(/\D/g, "")}`;
    case "email": return `mailto:${id}`;
    default: return null;
  }
}

function lastChannel(contact: Contact | null): PlatformType | null {
  if (!contact) return null;
  const interactions = contact.interactions || [];
  if (interactions.length > 0) {
    const latest = [...interactions].sort(
      (a, b) => +new Date(b.occurredAt) - +new Date(a.occurredAt),
    )[0];
    return latest.platform;
  }
  return contact.platforms?.[0]?.type || null;
}

const API_BASE = "";

export function RemindersView() {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<Bucket | null>(null);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [contactLoading, setContactLoading] = useState(false);
  // Cache fetched contacts so re-opens are instant
  const [contactCache, setContactCache] = useState<Record<string, Contact>>({});

  const openContact = async (contactId: string) => {
    if (contactCache[contactId]) { setSelectedContact(contactCache[contactId]); return; }
    setContactLoading(true);
    try {
      const c = await contactsApi.getById(contactId);
      setContactCache((prev) => ({ ...prev, [contactId]: c }));
      setSelectedContact(c);
    } catch { /* ignore */ }
    finally { setContactLoading(false); }
  };

  const fetchReminders = () =>
    remindersApi.getAll()
      .then((data) => setReminders(data?.length ? data : MOCK_REMINDERS))
      .catch(() => setReminders(MOCK_REMINDERS));

  useEffect(() => {
    fetchReminders().finally(() => setLoading(false));

    // SSE: refresh whenever a reminder is created, updated, or deleted anywhere in the app
    // (e.g. voice bot creates a reminder, or another tab marks one done)
    const es = new EventSource(`${API_BASE}/api/inbox/events`, { withCredentials: true });
    es.addEventListener("reminder_created", fetchReminders);
    es.addEventListener("reminder_updated", fetchReminders);
    es.addEventListener("reminder_deleted", fetchReminders);
    es.onerror = () => es.close(); // SSE will reconnect via fallback polling below

    // Fallback: re-sync every 30s in case SSE is unavailable
    const poll = setInterval(fetchReminders, 30_000);

    return () => { es.close(); clearInterval(poll); };
  }, []);

  const setStatus = (id: string, next: ReminderStatus) => {
    setReminders((prev) => prev.map((r) => (r.id === id ? { ...r, status: next } : r)));
    remindersApi.update(id, { status: next }).catch(() => {});
  };

  const moveToBucket = (id: string, target: Bucket) => {
    const now = new Date();
    let due = new Date();
    if (target === "overdue") due = new Date(now.getTime() - 2 * 86400000);
    else if (target === "today") due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 17, 0);
    else if (target === "this_week") due = new Date(now.getTime() + 3 * 86400000);
    else due = new Date(now.getTime() + 14 * 86400000);

    const iso = due.toISOString();
    setReminders((prev) =>
      prev.map((r) => (r.id === id ? { ...r, dueDate: iso, status: "pending" } : r)),
    );
    remindersApi.update(id, { dueDate: iso, status: "pending" }).catch(() => {});
  };

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const groups: Record<Bucket, Reminder[]> = { overdue: [], today: [], this_week: [], later: [] };
    for (const r of reminders) {
      if (r.status !== "pending") continue;
      if (q) {
        const hay = [r.content, r.contact?.name].filter(Boolean).join(" ").toLowerCase();
        const tokens = q.split(/\s+/).filter(Boolean);
        if (!tokens.every((t) => hay.includes(t))) continue;
      }
      groups[bucketOf(r.dueDate)].push(r);
    }
    for (const k of Object.keys(groups) as Bucket[]) {
      groups[k].sort((a, b) => +new Date(a.dueDate) - +new Date(b.dueDate));
    }
    return groups;
  }, [reminders, query]);

  const totalPending = reminders.filter((r) => r.status === "pending").length;
  const overdueCount = grouped.overdue.length;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <span className="inline-block size-5 rounded-full border-2 border-current border-t-transparent animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Reminders</h1>
          <p className="text-muted-foreground text-[13px] mt-1">
            {totalPending} pending
            {overdueCount > 0 && (
              <span className="text-status-red font-medium"> · {overdueCount} overdue</span>
            )}
          </p>
        </div>
        <input
          placeholder="Search..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-60 px-3 py-1.5 text-sm rounded-lg border border-border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>

      <div className="grid grid-cols-4 gap-3 items-start max-[1100px]:grid-cols-2 max-[640px]:grid-cols-1">
        {BUCKETS.map(({ key, label, tone }) => {
          const items = grouped[key];
          const isDragTarget = dragOver === key;
          return (
            <div
              key={key}
              className="rounded-xl p-2.5 flex flex-col gap-2.5 min-h-[240px] transition-[background,outline-color]"
              onDragOver={(e) => { e.preventDefault(); setDragOver(key); }}
              onDragLeave={() => setDragOver((d) => (d === key ? null : d))}
              onDrop={(e) => {
                e.preventDefault();
                if (draggedId) moveToBucket(draggedId, key);
                setDraggedId(null);
                setDragOver(null);
              }}
              style={{
                background: isDragTarget ? BUCKET_BG[key] : "var(--sf2)",
                outline: isDragTarget ? `2px dashed ${tone}` : "1px solid var(--bd)",
                outlineOffset: isDragTarget ? -2 : 0,
              }}
            >
              <div className="flex items-center justify-between py-0.5 px-1">
                <div className="flex items-center gap-2">
                  <span className="size-2 rounded-full" style={{ background: tone }} />
                  <span className="text-xs font-semibold text-foreground uppercase tracking-wider">
                    {label}
                  </span>
                </div>
                <span className="text-[11px] font-semibold text-muted-foreground bg-card px-2 py-0.5 rounded-full border border-border">
                  {items.length}
                </span>
              </div>

              <div className="flex flex-col gap-2">
                {items.length === 0 ? (
                  <div className="text-xs text-muted-foreground text-center py-4 px-2">
                    Nothing here.
                  </div>
                ) : (
                  items.map((r) => (
                    <ReminderCard
                      key={r.id}
                      reminder={r}
                      channel={lastChannel(contactCache[r.contactId] ?? null)}
                      tone={tone}
                      onDragStart={() => setDraggedId(r.id)}
                      onDragEnd={() => { setDraggedId(null); setDragOver(null); }}
                      onDone={() => setStatus(r.id, "done")}
                      onOpen={() => openContact(r.contactId)}
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      <Dialog open={!!selectedContact || contactLoading} onOpenChange={(open) => { if (!open) { setSelectedContact(null); } }}>
        <DialogContent className="max-w-[560px] p-0 overflow-hidden gap-0">
          {contactLoading && (
            <div className="flex items-center justify-center py-20">
              <span className="inline-block size-5 rounded-full border-2 border-current border-t-transparent animate-spin text-muted-foreground" />
            </div>
          )}
          {selectedContact && <ContactModal contact={selectedContact} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ReminderCard({
  reminder,
  channel,
  tone,
  onDragStart,
  onDragEnd,
  onDone,
  onOpen,
}: {
  reminder: Reminder;
  channel: PlatformType | null;
  tone: string;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDone: () => void;
  onOpen: () => void;
}) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      style={{ borderLeft: `3px solid ${tone}` }}
      className="bg-card border border-border rounded-xl p-2.5 cursor-grab shadow-sm transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md flex flex-col gap-2 group"
    >
      <div className="text-[13px] font-medium text-foreground leading-relaxed">
        {reminder.content}
      </div>

      {reminder.contact && (
        <button
          onClick={onOpen}
          className="flex items-center gap-2 bg-secondary/50 border border-border py-0.5 pl-1 pr-2 rounded-full cursor-pointer text-left self-start transition-colors hover:bg-card hover:border-muted-foreground"
        >
          <span className="size-5 rounded-full bg-card text-muted-foreground flex items-center justify-center text-[10px] font-bold shrink-0 border border-border">
            {initials(reminder.contact.name)}
          </span>
          <span className="text-xs text-foreground font-medium truncate max-w-[120px]">
            {reminder.contact.name}
          </span>
          {channel && (
            <span
              title={`Last talked on ${channel}`}
              className="inline-flex items-center justify-center size-[18px] rounded bg-card border border-border shrink-0"
            >
              <PlatformIcon type={channel} size={11} />
            </span>
          )}
        </button>
      )}

      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] tabular-nums font-semibold" style={{ color: tone }}>
          {formatDue(reminder.dueDate)}
        </span>
        <button
          aria-label="Mark done"
          onClick={onDone}
          className="opacity-0 group-hover:opacity-100 transition-opacity bg-status-green-bg text-status-green border-0 rounded-md px-2 py-0.5 text-[11px] font-semibold cursor-pointer flex items-center gap-1"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          Done
        </button>
      </div>
    </div>
  );
}

function ContactModal({ contact }: { contact: Contact }) {
  const recent = (contact.interactions || []).slice(0, 5);
  const notes = contact.notes || [];

  return (
    <>
      {/* Header */}
      <div className="p-4 px-5 border-b border-border flex items-start gap-3.5">
        <div className="size-12 rounded-full bg-secondary text-muted-foreground flex items-center justify-center text-base font-bold shrink-0">
          {initials(contact.name)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-lg font-bold text-foreground tracking-tight">
            {contact.name}
          </div>
          {(contact.role || contact.company) && (
            <div className="text-xs text-muted-foreground mt-0.5">
              {[contact.role, contact.company].filter(Boolean).join(" @ ")}
            </div>
          )}
          <div className="flex gap-1.5 mt-2 flex-wrap">
            <Badge variant="purple">{contact.type}</Badge>
            <Badge variant="blue">{contact.domain}</Badge>
            <Badge variant={contact.relationshipStrength === "hot" ? "red" : contact.relationshipStrength === "warm" ? "orange" : "blue"}>
              {contact.relationshipStrength}
            </Badge>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="overflow-y-auto max-h-[60vh] p-4 px-5 flex flex-col gap-4">
        {/* Platforms */}
        {contact.platforms && contact.platforms.length > 0 && (
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.04em] text-muted-foreground mb-2">Reach on</div>
            <div className="flex gap-1.5 flex-wrap">
              {contact.platforms.map((p) => {
                const href = platformLink(p.type, p.platformId);
                const Chip = href ? "a" : "span";
                return (
                  <Chip
                    key={p.id}
                    {...(href ? { href, target: "_blank", rel: "noopener noreferrer" } : {})}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-secondary border border-border text-xs text-foreground transition-colors hover:bg-accent hover:border-muted-foreground"
                    style={href ? { cursor: "pointer", textDecoration: "none" } : undefined}
                  >
                    <PlatformIcon type={p.type as PlatformType} size={12} />
                    <span className="font-mono text-[11px] tabular-nums">{p.platformId}</span>
                  </Chip>
                );
              })}
            </div>
          </div>
        )}

        {/* Recent exchanges */}
        {recent.length > 0 && (
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.04em] text-muted-foreground mb-2">Recent exchanges</div>
            <div className="flex flex-col gap-2">
              {recent.map((i) => (
                <div
                  key={i.id}
                  className="flex items-start gap-2.5 p-2 px-2.5 bg-accent border border-border rounded-lg"
                >
                  <PlatformIcon type={i.platform} size={14} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-foreground leading-relaxed">
                      {i.contentSnippet}
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-1">
                      {i.direction === "outbound" ? "Sent" : "Received"} ·{" "}
                      {new Date(i.occurredAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Notes */}
        {notes.length > 0 && (
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.04em] text-muted-foreground mb-2">Notes</div>
            <div className="flex flex-col gap-2">
              {notes.map((n) => (
                <div
                  key={n.id}
                  className="p-2.5 px-3 bg-status-yellow-bg border border-status-yellow/20 rounded-lg text-xs text-foreground leading-relaxed"
                >
                  {n.content}
                </div>
              ))}
            </div>
          </div>
        )}

        {recent.length === 0 && notes.length === 0 && (
          <div className="py-6 px-4 text-center text-muted-foreground text-xs">
            No history yet for this contact.
          </div>
        )}
      </div>
    </>
  );
}
