"use client";

import { useState, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import { contactsApi, aiApi, tagsApi, remindersApi } from "@/lib/api";
import { MOCK_CONTACTS, MOCK_TAGS } from "@/lib/mock-contacts";
import { MOCK_REMINDERS } from "@/lib/mock-reminders";
import { MOCK_EVENTS, type CalendarEvent } from "@/lib/mock-events";
import type {
  Contact, Tag, ContactType, ContactDomain, RelationshipStrength,
  Reminder, Interaction, Note, PlatformType,
} from "@/lib/types";
import { PlatformIcon } from "@/components/platform-icon";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

type TimelineItem =
  | { kind: "interaction"; date: string; data: Interaction }
  | { kind: "note"; date: string; data: Note }
  | { kind: "reminder"; date: string; data: Reminder }
  | { kind: "event"; date: string; data: CalendarEvent };

function buildTimeline(contact: Contact, reminders: Reminder[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const i of contact.interactions || []) items.push({ kind: "interaction", date: i.occurredAt, data: i });
  for (const n of contact.notes || []) items.push({ kind: "note", date: n.createdAt, data: n });
  for (const r of reminders) items.push({ kind: "reminder", date: r.dueDate, data: r });
  for (const e of MOCK_EVENTS.filter((ev) => ev.contactId === contact.id)) {
    items.push({ kind: "event", date: e.start, data: e });
  }
  items.sort((a, b) => +new Date(b.date) - +new Date(a.date));
  return items;
}

const TYPES: ContactType[] = ["vc", "lead", "partner", "friend", "prospect", "team", "advisor", "media", "other"];
const DOMAINS: ContactDomain[] = ["payment", "blockchain", "saas", "ecommerce", "ai", "marketing", "legal", "finance", "other"];
const STRENGTHS: RelationshipStrength[] = ["cold", "warm", "hot"];

const TYPE_COLORS: Record<string, "green" | "yellow" | "blue" | "red" | "purple" | "orange"> = {
  vc: "purple", lead: "blue", partner: "green", friend: "yellow", prospect: "orange",
  team: "blue", advisor: "purple", media: "orange", other: "blue",
};
const DOMAIN_COLORS: Record<string, "green" | "yellow" | "blue" | "red" | "purple" | "orange"> = {
  payment: "green", blockchain: "purple", saas: "blue", ecommerce: "orange",
  ai: "purple", marketing: "yellow", legal: "red", finance: "green", other: "blue",
};
const STRENGTH_COLORS: Record<string, "green" | "yellow" | "blue" | "red" | "purple" | "orange"> = {
  cold: "blue", warm: "orange", hot: "red",
};

const PLATFORM_LINKS: Record<string, (id: string) => string | null> = {
  x: (id) => `https://x.com/${id}`,
  linkedin: (id) => id.includes("linkedin.com") ? (id.startsWith("http") ? id : `https://${id}`) : `https://linkedin.com/in/${id}`,
  telegram: (id) => `https://t.me/${id}`,
  whatsapp: (id) => `https://wa.me/${id.replace(/\D/g, "")}`,
  discord: () => null,
  slack: () => null,
  email: (id) => `mailto:${id}`,
  matrix: () => null,
};

const PLATFORM_LABELS: Record<string, string> = {
  x: "username (@ optional)",
  linkedin: "username",
  telegram: "username (@ optional)",
  whatsapp: "+CountryCode + number e.g. +918958695497",
  email: "user@example.com",
  discord: "username",
  slack: "username",
  matrix: "@user:server.org",
};

const ALL_PLATFORM_TYPES = ["telegram", "x", "linkedin", "whatsapp", "email", "discord", "slack"] as const;

const HASHTAG_PALETTE = ["#4f46e5", "#dc2626", "#16a34a", "#2563eb", "#ea580c", "#ca8a04"];

function extractHashtags(text: string): string[] {
  const matches = text.match(/#([\p{L}0-9_-]+)/gu) || [];
  return Array.from(new Set(matches.map((m) => m.slice(1))));
}

function renderWithHashtags(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /#([\p{L}0-9_-]+)/gu;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <span
        key={i++}
        style={{
          display: "inline-block",
          padding: "1px 6px",
          margin: "0 1px",
          borderRadius: 4,
          background: "var(--pb)",
          color: "var(--pc)",
          fontSize: 11,
          fontWeight: 600,
        }}
      >
        #{m[1]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function relativeDate(dateStr: string | null): string {
  if (!dateStr) return "Never";
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function InlineSelect<T extends string>({ value, options, colorMap, onChange }: {
  value: T;
  options: T[];
  colorMap: Record<string, string>;
  onChange: (v: T) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <select
        value={value}
        autoFocus
        onChange={(e) => { onChange(e.target.value as T); setEditing(false); }}
        onBlur={() => setEditing(false)}
        style={{ fontSize: 12, padding: "2px 6px", borderRadius: "var(--r)", border: "1px solid var(--bd)", background: "var(--sf)" }}
      >
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }

  return (
    <Badge
      variant={colorMap[value] as any || "blue"}
      className="cursor-pointer"
      onClick={() => setEditing(true)}
      title="Click to edit"
    >
      {value}
    </Badge>
  );
}

export function ContactDetailView({ paramsPromise }: { paramsPromise: Promise<{ id: string }> }) {
  const { id } = use(paramsPromise);
  const router = useRouter();
  const [contact, setContact] = useState<Contact | null>(null);
  const [loading, setLoading] = useState(true);
  const [noteText, setNoteText] = useState("");
  const [addingNote, setAddingNote] = useState(false);
  const [classifying, setClassifying] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [prepping, setPrepping] = useState(false);
  const [prepResult, setPrepResult] = useState<string | null>(null);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [selectedTag, setSelectedTag] = useState("");
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [reminderContent, setReminderContent] = useState("");
  const [reminderDate, setReminderDate] = useState("");
  const [addingReminder, setAddingReminder] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [enrichResult, setEnrichResult] = useState<{
    role?: string; company?: string; followers?: string;
    linkedinSnippet?: string; twitterSnippet?: string;
    companyLinked?: string;
    platformsAdded: { type: string; id: string }[];
    error?: string; empty?: boolean;
  } | null>(null);
  const [addingPlatform, setAddingPlatform] = useState(false);
  const [newPlatformType, setNewPlatformType] = useState("telegram");
  const [newPlatformId, setNewPlatformId] = useState("");
  const [editingPlatformId, setEditingPlatformId] = useState<string | null>(null);
  const [editPlatformValue, setEditPlatformValue] = useState("");

  useEffect(() => {
    const mock = MOCK_CONTACTS.find((c) => c.id === id);
    if (mock) {
      setContact(mock);
      setLoading(false);
    } else {
      contactsApi.getById(id)
        .then(setContact)
        .catch(() => {})
        .finally(() => setLoading(false));
    }
    tagsApi.getAll()
      .then((t) => setAllTags(t.length ? t : MOCK_TAGS))
      .catch(() => setAllTags(MOCK_TAGS));
    loadReminders();
  }, [id]);

  const loadReminders = () => {
    remindersApi.getAll()
      .then((all) => {
        const list = all.length ? all : MOCK_REMINDERS;
        setReminders(list.filter((r) => r.contactId === id));
      })
      .catch(() => setReminders(MOCK_REMINDERS.filter((r) => r.contactId === id)));
  };

  const reload = () => {
    const mock = MOCK_CONTACTS.find((c) => c.id === id);
    if (mock) { setContact(mock); return Promise.resolve(); }
    return contactsApi.getById(id).then(setContact).catch(() => {});
  };

  const handleAddNote = async () => {
    if (!noteText.trim()) return;
    setAddingNote(true);
    const hashtags = extractHashtags(noteText);
    try {
      await contactsApi.addNote(id, noteText.trim());
      // Auto-create + attach extracted hashtags locally (mock-friendly)
      if (hashtags.length > 0) {
        setAllTags((prev) => {
          const existingNames = new Set(prev.map((t) => t.name.toLowerCase()));
          const created = hashtags
            .filter((h) => !existingNames.has(h.toLowerCase()))
            .map((h, i) => ({ id: `tag-${Date.now()}-${i}`, name: h, color: HASHTAG_PALETTE[i % HASHTAG_PALETTE.length], createdAt: new Date().toISOString() }));
          return [...prev, ...created];
        });
        setContact((prev) => {
          if (!prev) return prev;
          const existingTagNames = new Set((prev.contactTags || []).map((ct) => ct.tag?.name.toLowerCase()));
          const newCts = hashtags
            .filter((h) => !existingTagNames.has(h.toLowerCase()))
            .map((h) => ({
              id: `ct-${Date.now()}-${h}`,
              contactId: id,
              tagId: `tag-${h}`,
              tag: { id: `tag-${h}`, name: h, color: HASHTAG_PALETTE[h.length % HASHTAG_PALETTE.length], createdAt: new Date().toISOString() },
              createdAt: new Date().toISOString(),
            }));
          return { ...prev, contactTags: [...(prev.contactTags || []), ...newCts] };
        });
      }
      setNoteText("");
      await reload();
    }
    catch {}
    finally { setAddingNote(false); }
  };

  const handleDeleteNote = (noteId: string) => {
    setContact((prev) => prev ? { ...prev, notes: (prev.notes || []).filter((n) => n.id !== noteId) } : prev);
    contactsApi.deleteNote(id, noteId).catch(() => reload());
  };

  const handleClassify = async () => {
    setClassifying(true);
    try { await aiApi.classify(id); await reload(); }
    catch {}
    finally { setClassifying(false); }
  };

  const handleSummary = async () => {
    setSummarizing(true);
    try {
      await aiApi.summary(id, true); // polls until worker finishes, forces refresh
      await reload();           // then re-fetch contact — aiSummary field is now populated
    } catch (e: any) {
      console.error("[summary]", e?.message);
    } finally { setSummarizing(false); }
  };

  const handlePrep = async () => {
    setPrepping(true);
    setPrepResult(null);
    try {
      const res = await aiApi.prep(id, true); // polls until worker finishes, returns { briefing }, forces refresh
      setPrepResult(res?.briefing ?? "No briefing returned.");
    } catch {
      setPrepResult("Failed to generate prep. Try again.");
    } finally {
      setPrepping(false);
    }
  };

  const handleEnrich = async () => {
    setEnriching(true);
    setEnrichResult(null);
    try {
      const res = await contactsApi.enrich(id);
      const d = res.enrichedData ?? {};
      const platformsAdded = (res.platformsAdded ?? []).map((p: any) => ({ type: p.type, id: p.platformId }));
      const hasData = d.role || d.company || d.followers || d.linkedinSnippet || d.twitterSnippet || res.companyLinked || platformsAdded.length > 0;
      setEnrichResult({
        role: d.role, company: d.company, followers: d.followers,
        linkedinSnippet: d.linkedinSnippet, twitterSnippet: d.twitterSnippet,
        companyLinked: res.companyLinked?.name,
        platformsAdded,
        empty: !hasData,
      });
      await reload();
    } catch (e: any) {
      setEnrichResult({ platformsAdded: [], error: e?.message ?? "Try again." });
      await reload();
    } finally {
      setEnriching(false);
    }
  };

  const handleAddPlatform = () => {
    const handle = newPlatformId.trim();
    if (!handle) return;
    const optimisticPlatform = { id: `opt-${Date.now()}`, contactId: id, type: newPlatformType as any, platformId: handle, displayName: null, profileUrl: null, createdAt: new Date().toISOString() };
    setContact((prev) => prev ? { ...prev, platforms: [...(prev.platforms || []), optimisticPlatform] } : prev);
    setNewPlatformId("");
    setAddingPlatform(false);
    contactsApi.addPlatform(id, { type: newPlatformType, platformId: handle }).then(() => reload()).catch(() => {
      setContact((prev) => prev ? { ...prev, platforms: (prev.platforms || []).filter((p) => p.id !== optimisticPlatform.id) } : prev);
    });
  };

  const handleEditPlatform = (pid: string) => {
    const handle = editPlatformValue.trim();
    if (!handle) return;
    setContact((prev) => prev ? { ...prev, platforms: (prev.platforms || []).map((p) => p.id === pid ? { ...p, platformId: handle } : p) } : prev);
    setEditingPlatformId(null);
    setEditPlatformValue("");
    contactsApi.updatePlatform(id, pid, { platformId: handle }).catch(() => reload());
  };

  const handleDeletePlatform = (pid: string) => {
    setContact((prev) => prev ? { ...prev, platforms: (prev.platforms || []).filter((p) => p.id !== pid) } : prev);
    contactsApi.deletePlatform(id, pid).catch(() => reload());
  };

  const handleAddReminder = async () => {
    if (!reminderContent.trim() || !reminderDate) return;
    setAddingReminder(true);
    try {
      await remindersApi.create(id, { content: reminderContent.trim(), dueDate: reminderDate });
      setReminderContent("");
      setReminderDate("");
      loadReminders();
    } catch {}
    finally { setAddingReminder(false); }
  };

  const handleReminderAction = (reminderId: string, status: "done" | "dismissed") => {
    setReminders((prev) => prev.map((r) => r.id === reminderId ? { ...r, status } : r));
    remindersApi.update(reminderId, { status }).catch(() => loadReminders());
  };

  const handleDeleteReminder = (reminderId: string) => {
    setReminders((prev) => prev.filter((r) => r.id !== reminderId));
    remindersApi.delete(reminderId).catch(() => loadReminders());
  };

  const handleDelete = async () => {
    if (!confirm("Delete this contact?")) return;
    try { await contactsApi.delete(id); router.push("/dashboard/contacts"); }
    catch {}
  };

  const handleFieldChange = async (field: string, value: string) => {
    try { await contactsApi.update(id, { [field]: value } as Partial<Contact>); await reload(); }
    catch {}
  };

  const handleAddTag = () => {
    if (!selectedTag) return;
    const tag = allTags.find((t) => t.id === selectedTag);
    if (!tag) return;
    const optimisticCt = { id: `opt-ct-${Date.now()}`, contactId: id, tagId: tag.id, tag, createdAt: new Date().toISOString() };
    setContact((prev) => prev ? { ...prev, contactTags: [...(prev.contactTags || []), optimisticCt] } : prev);
    setSelectedTag("");
    contactsApi.addTag(id, tag.id).catch(() => reload());
  };

  const handleRemoveTag = (tagId: string) => {
    setContact((prev) => prev ? { ...prev, contactTags: (prev.contactTags || []).filter((ct) => ct.tagId !== tagId) } : prev);
    contactsApi.removeTag(id, tagId).catch(() => reload());
  };

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 80 }}>
        <span className="inline-block size-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" style={{ width: 20, height: 20, color: "var(--t3)" }} />
      </div>
    );
  }

  if (!contact) {
    return <div className="py-12 px-6 text-center text-muted-foreground text-sm">Contact not found</div>;
  }

  const existingTagIds = new Set(contact.contactTags?.map((ct) => ct.tagId) || []);
  const availableTags = allTags.filter((t) => !existingTagIds.has(t.id));

  return (
    <div className="flex flex-col gap-6 w-full">
      {/* Back link */}
      <Button size="sm" variant="outline" onClick={() => router.push("/dashboard/contacts")} className="self-start">
        ← Back to contacts
      </Button>

      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight">{contact.name}</h1>
          {(contact.company || contact.role) && (
            <div className="text-sm text-muted-foreground mt-1">
              {[contact.role, contact.company].filter(Boolean).join(" @ ")}
            </div>
          )}
          <div className="flex gap-1.5 mt-2 flex-wrap items-center">
            <InlineSelect value={contact.type} options={TYPES} colorMap={TYPE_COLORS} onChange={(v) => handleFieldChange("type", v)} />
            <InlineSelect value={contact.domain} options={DOMAINS} colorMap={DOMAIN_COLORS} onChange={(v) => handleFieldChange("domain", v)} />
            <InlineSelect value={contact.relationshipStrength} options={STRENGTHS} colorMap={STRENGTH_COLORS} onChange={(v) => handleFieldChange("relationshipStrength", v)} />
            {contact.contactFrequency != null && contact.contactFrequency > 0 && (
              <span className="text-xs text-muted-foreground ml-1">{contact.contactFrequency} interactions</span>
            )}
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button size="sm" variant="blue" onClick={handleClassify} disabled={classifying}>
            {classifying && <Spinner />}{classifying ? "Classifying…" : "Classify (AI)"}
          </Button>
          <Button size="sm" variant="purple" onClick={handleSummary} disabled={summarizing}>
            {summarizing && <Spinner />}{summarizing ? "Summarizing…" : "Summary (AI)"}
          </Button>
          <Button size="sm" variant="orange" onClick={handlePrep} disabled={prepping}>
            {prepping && <Spinner />}{prepping ? "Generating…" : "Prep (AI)"}
          </Button>
          <Button size="sm" variant="green" onClick={handleEnrich} disabled={enriching}>
            {enriching && <Spinner />}{enriching ? "Enriching…" : "Enrich"}
          </Button>
          <Button size="sm" variant="red" onClick={handleDelete}>Delete</Button>
        </div>
      </div>

      {/* Enrichment result */}
      {enrichResult && (
        <div className="rounded-xl border bg-card shadow-sm overflow-hidden" style={{ borderColor: enrichResult.error ? "var(--rc)" : "var(--gc)" }}>
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-2.5" style={{ background: enrichResult.error ? "var(--rb)" : "var(--gb)" }}>
            <span className="text-[11px] font-bold uppercase tracking-widest" style={{ color: enrichResult.error ? "var(--rc)" : "var(--gc)" }}>
              {enrichResult.error ? "Enrichment failed" : enrichResult.empty ? "No new data found" : "Enrichment result"}
            </span>
            <button onClick={() => setEnrichResult(null)} className="bg-transparent border-0 cursor-pointer p-0 opacity-60 hover:opacity-100 transition-opacity" style={{ color: enrichResult.error ? "var(--rc)" : "var(--gc)" }}>
              ✕
            </button>
          </div>
          {/* Body */}
          {enrichResult.error ? (
            <div className="px-4 py-3 text-[13px]" style={{ color: "var(--rc)" }}>{enrichResult.error}</div>
          ) : !enrichResult.empty ? (
            <div className="divide-y divide-border">
              {enrichResult.role && (
                <div className="px-4 py-2.5 flex gap-3">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground w-24 shrink-0 mt-0.5">Role</span>
                  <span className="text-[13px] text-foreground">{enrichResult.role}</span>
                </div>
              )}
              {enrichResult.company && (
                <div className="px-4 py-2.5 flex gap-3">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground w-24 shrink-0 mt-0.5">Company</span>
                  <span className="text-[13px] text-foreground">{enrichResult.company}</span>
                </div>
              )}
              {enrichResult.followers && (
                <div className="px-4 py-2.5 flex gap-3">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground w-24 shrink-0 mt-0.5">Followers</span>
                  <span className="text-[13px] text-foreground">{enrichResult.followers}</span>
                </div>
              )}
              {enrichResult.linkedinSnippet && (
                <div className="px-4 py-2.5 flex gap-3">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground w-24 shrink-0 mt-0.5">LinkedIn</span>
                  <span className="text-[13px] text-foreground leading-relaxed">{enrichResult.linkedinSnippet}</span>
                </div>
              )}
              {enrichResult.twitterSnippet && (
                <div className="px-4 py-2.5 flex gap-3">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground w-24 shrink-0 mt-0.5">X / Twitter</span>
                  <span className="text-[13px] text-foreground leading-relaxed">{enrichResult.twitterSnippet}</span>
                </div>
              )}
              {enrichResult.companyLinked && (
                <div className="px-4 py-2.5 flex gap-3">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground w-24 shrink-0 mt-0.5">Linked</span>
                  <span className="text-[13px]" style={{ color: "var(--gc)" }}>Company "{enrichResult.companyLinked}" linked ✓</span>
                </div>
              )}
              {enrichResult.platformsAdded.length > 0 && (
                <div className="px-4 py-2.5 flex gap-3">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground w-24 shrink-0 mt-0.5">Added</span>
                  <div className="flex flex-wrap gap-1.5">
                    {enrichResult.platformsAdded.map((p) => (
                      <span key={p.type + p.id} className="text-[12px] font-semibold px-2 py-0.5 rounded-full" style={{ background: "var(--gb)", color: "var(--gc)" }}>
                        {p.type === "x" ? `@${p.id}` : p.type === "linkedin" ? `linkedin/${p.id}` : p.id}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}

      {/* 2-column grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
        {/* Left column */}
        <div className="flex flex-col gap-4">
          {/* Platforms */}
          <div className="rounded-xl border border-border bg-card shadow-sm p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">Platforms</div>
              <button
                onClick={() => { setAddingPlatform((v) => !v); setNewPlatformId(""); }}
                className="text-xs font-medium text-status-blue hover:underline cursor-pointer border-0 bg-transparent p-0"
              >
                {addingPlatform ? "Cancel" : "+ Add"}
              </button>
            </div>

            {/* Add platform form */}
            {addingPlatform && (
              <div className="flex gap-2 mb-3 flex-wrap">
                <select
                  value={newPlatformType}
                  onChange={(e) => setNewPlatformType(e.target.value)}
                  className="h-8 text-[12px] px-2 rounded-lg border border-border bg-card text-foreground"
                  style={{ width: 110, flex: "none" }}
                >
                  {ALL_PLATFORM_TYPES.map((t) => (
                    <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                  ))}
                </select>
                <input
                  value={newPlatformId}
                  onChange={(e) => setNewPlatformId(e.target.value)}
                  placeholder={PLATFORM_LABELS[newPlatformType] ?? "handle"}
                  onKeyDown={(e) => e.key === "Enter" && handleAddPlatform()}
                  className="flex-1 h-8 text-[12px] px-2.5 rounded-lg border border-border bg-card text-foreground min-w-[120px]"
                  style={{ padding: "0 10px" }}
                  autoFocus
                />
                <Button size="sm" onClick={handleAddPlatform} disabled={!newPlatformId.trim()}>
                  Save
                </Button>
              </div>
            )}

            {contact.platforms && contact.platforms.length > 0 ? (
              <div className="flex flex-col gap-2">
                {contact.platforms.map((p) => {
                  const linkFn = PLATFORM_LINKS[p.type];
                  const link = p.profileUrl || (linkFn ? linkFn(p.platformId) : null);
                  const isEditing = editingPlatformId === p.id;
                  return (
                    <div key={p.id} className="flex items-center gap-2.5 p-2 px-3 bg-muted rounded-lg">
                      <PlatformIcon type={p.type} size={18} />
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-semibold capitalize text-foreground">{p.type}</div>
                        {isEditing ? (
                          <div className="flex gap-1.5 mt-1">
                            <input
                              value={editPlatformValue}
                              onChange={(e) => setEditPlatformValue(e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter") handleEditPlatform(p.id); if (e.key === "Escape") setEditingPlatformId(null); }}
                              className="h-6 text-[11px] px-2 rounded border border-border bg-card text-foreground flex-1"
                              style={{ padding: "0 8px", minWidth: 80 }}
                              autoFocus
                            />
                            <button onClick={() => handleEditPlatform(p.id)} className="text-[10px] font-semibold cursor-pointer border-0 bg-transparent p-0" style={{ color: "var(--gc)" }}>
                              Save
                            </button>
                            <button onClick={() => setEditingPlatformId(null)} className="text-[10px] cursor-pointer border-0 bg-transparent p-0" style={{ color: "var(--t3)" }}>
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <div className="text-xs text-muted-foreground overflow-hidden text-ellipsis whitespace-nowrap">
                            {p.displayName ? `${p.displayName} · ${p.platformId}` : p.platformId}
                          </div>
                        )}
                      </div>
                      {!isEditing && (
                        <div className="flex items-center gap-2 ml-auto shrink-0">
                          {link && (
                            <a href={link} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-xs hover:underline whitespace-nowrap" style={{ color: "#2563eb" }}>
                              Open →
                            </a>
                          )}
                          <button
                            onClick={() => { setEditingPlatformId(p.id); setEditPlatformValue(p.platformId); }}
                            className="text-[10px] cursor-pointer border-0 bg-transparent p-0 hover:opacity-80 transition-opacity"
                            style={{ color: "var(--t3)" }}
                            title="Edit"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleDeletePlatform(p.id)}
                            className="text-[10px] cursor-pointer border-0 bg-transparent p-0 hover:opacity-80 transition-opacity"
                            style={{ color: "var(--rc)" }}
                            title="Remove"
                          >
                            ×
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-muted-foreground text-[13px]">{addingPlatform ? "" : "No platforms linked"}</div>
            )}
          </div>

          {/* AI Summary */}
          <div className="rounded-xl border border-border bg-card shadow-sm p-5">
            <div className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground mb-3">AI Summary</div>
            {contact.aiSummary ? (
              <div className="text-[13px] text-muted-foreground leading-relaxed whitespace-pre-wrap">{contact.aiSummary}</div>
            ) : (
              <div className="text-muted-foreground text-[13px]">No AI summary yet. Click "Summary (AI)" to create one.</div>
            )}
          </div>

          {/* Prep Briefing */}
          {prepResult && (
            <div className="rounded-xl border border-border bg-card shadow-sm p-5 border-l-3" style={{ borderLeftColor: "var(--oc)" }}>
              <div className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground mb-3">Pre-call Briefing</div>
              <div className="text-[13px] text-foreground leading-relaxed whitespace-pre-wrap">{prepResult}</div>
            </div>
          )}

          {/* Tags */}
          <div className="rounded-xl border border-border bg-card shadow-sm p-5">
            <div className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground mb-3">Tags</div>
            <div className="flex gap-1.5 flex-wrap mb-3">
              {contact.contactTags && contact.contactTags.length > 0 ? contact.contactTags.map((ct) => (
                <Badge key={ct.id} variant="blue" className="cursor-pointer" onClick={() => handleRemoveTag(ct.tagId)}>
                  {ct.tag?.name || ct.tagId} ×
                </Badge>
              )) : (
                <span className="text-muted-foreground text-[13px]">No tags</span>
              )}
            </div>
            {availableTags.length > 0 && (
              <div className="flex gap-2">
                <select value={selectedTag} onChange={(e) => setSelectedTag(e.target.value)} className="flex-1 h-9 bg-card border border-border text-foreground text-[13px] rounded-lg px-2">
                  <option value="">Select a tag...</option>
                  {availableTags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <Button size="sm" variant="outline" onClick={handleAddTag}>Add</Button>
              </div>
            )}
          </div>
        </div>

        {/* Right column — Unified timeline */}
        <UnifiedTimeline
          contact={contact}
          reminders={reminders}
          noteText={noteText}
          setNoteText={setNoteText}
          addingNote={addingNote}
          onAddNote={handleAddNote}
          onDeleteNote={handleDeleteNote}
          reminderContent={reminderContent}
          setReminderContent={setReminderContent}
          reminderDate={reminderDate}
          setReminderDate={setReminderDate}
          addingReminder={addingReminder}
          onAddReminder={handleAddReminder}
          onReminderAction={handleReminderAction}
          onDeleteReminder={handleDeleteReminder}
        />
      </div>
    </div>
  );
}

export function UnifiedTimeline({
  contact, reminders,
  noteText, setNoteText, addingNote, onAddNote, onDeleteNote,
  reminderContent, setReminderContent, reminderDate, setReminderDate,
  addingReminder, onAddReminder, onReminderAction, onDeleteReminder,
}: {
  contact: Contact;
  reminders: Reminder[];
  noteText: string; setNoteText: (v: string) => void; addingNote: boolean;
  onAddNote: () => void; onDeleteNote: (id: string) => void;
  reminderContent: string; setReminderContent: (v: string) => void;
  reminderDate: string; setReminderDate: (v: string) => void;
  addingReminder: boolean; onAddReminder: () => void;
  onReminderAction: (id: string, status: "done" | "dismissed") => void;
  onDeleteReminder: (id: string) => void;
}) {
  const [tab, setTab] = useState<"add" | "note" | "reminder">("add");
  const items = buildTimeline(contact, reminders);

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
      {/* Composer */}
      <div className="p-4 border-b border-border bg-muted">
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as "add" | "note" | "reminder")}
          className={tab !== "add" ? "mb-2.5" : ""}
        >
          <TabsList>
            <TabsTrigger value="add">+ Add</TabsTrigger>
            <TabsTrigger value="note">Note</TabsTrigger>
            <TabsTrigger value="reminder">Reminder</TabsTrigger>
          </TabsList>
        </Tabs>
        {tab === "note" && (
          <div className="flex gap-2 mt-2.5">
            <textarea value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Add a note..." rows={2} className="flex-1 resize-y" />
            <Button size="sm" onClick={onAddNote} disabled={addingNote} className="self-end">
              {addingNote ? "Adding..." : "Add"}
            </Button>
          </div>
        )}
        {tab === "reminder" && (
          <div className="flex gap-2 flex-wrap mt-2.5">
            <input value={reminderContent} onChange={(e) => setReminderContent(e.target.value)} placeholder="Reminder content..." className="flex-[2] min-w-[140px]" />
            <input type="date" value={reminderDate} onChange={(e) => setReminderDate(e.target.value)} className="flex-1 min-w-[120px] h-9 rounded-lg border border-border bg-card text-foreground text-[13px] px-2.5" />
            <Button size="sm" onClick={onAddReminder} disabled={addingReminder}>
              {addingReminder ? "Adding..." : "Add"}
            </Button>
          </div>
        )}
      </div>

      {/* Timeline */}
      <div className="p-4">
        <div className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground mb-3">
          Timeline
          <span className="font-normal text-muted-foreground ml-2">({items.length})</span>
        </div>
        {items.length === 0 ? (
          <div className="py-12 px-6 text-center text-muted-foreground text-sm">No activity yet.</div>
        ) : (
          <div className="relative pl-6">
            {/* Vertical line */}
            <div className="absolute left-[11px] top-1 bottom-1 w-px bg-border" />
            <div className="flex flex-col gap-3.5">
              {items.map((it, idx) => (
                <TimelineRow
                  key={`${it.kind}-${idx}`}
                  item={it}
                  onDeleteNote={onDeleteNote}
                  onReminderAction={onReminderAction}
                  onDeleteReminder={onDeleteReminder}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TimelineRow({
  item, onDeleteNote, onReminderAction, onDeleteReminder,
}: {
  item: TimelineItem;
  onDeleteNote: (id: string) => void;
  onReminderAction: (id: string, status: "done" | "dismissed") => void;
  onDeleteReminder: (id: string) => void;
}) {
  if (item.kind === "interaction") {
    const i = item.data;
    return (
      <TimelineFrame
        dotColor={i.direction === "inbound" ? "var(--gc)" : "var(--bc)"}
        dotIcon={<PlatformIcon type={i.platform} size={11} />}
        date={item.date}
      >
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className="text-xs font-semibold capitalize text-foreground">{i.platform}</span>
          <span
            className="text-[9px] font-bold px-1.5 py-0.5 rounded"
            style={{
              background: i.direction === "inbound" ? "var(--gb)" : "var(--bb)",
              color: i.direction === "inbound" ? "var(--gc)" : "var(--bc)",
            }}
          >
            {i.direction === "inbound" ? "IN" : "OUT"}
          </span>
          {i.messageCount > 1 && (
            <span className="text-[10px] text-muted-foreground">· {i.messageCount} msgs</span>
          )}
        </div>
        {i.contentSnippet && (
          <div className="text-xs text-muted-foreground leading-relaxed">{i.contentSnippet}</div>
        )}
      </TimelineFrame>
    );
  }

  if (item.kind === "note") {
    const n = item.data;
    return (
      <TimelineFrame
        dotColor="var(--yc)"
        dotIcon={
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--yc)" }}>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
        }
        date={item.date}
        background="var(--yb)"
        borderColor="#f5e1a0"
      >
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] font-bold uppercase tracking-wider text-status-yellow" style={{ color: "var(--yc)" }}>
            Note
          </span>
          <button
            onClick={() => onDeleteNote(n.id)}
            className="bg-transparent border-0 text-muted-foreground cursor-pointer text-[10px] p-0 hover:text-foreground transition-colors"
          >
            Remove
          </button>
        </div>
        <div className="text-xs text-foreground leading-relaxed whitespace-pre-wrap">{renderWithHashtags(n.content)}</div>
      </TimelineFrame>
    );
  }

  if (item.kind === "reminder") {
    const r = item.data;
    const isFuture = new Date(r.dueDate).getTime() > Date.now();
    const isOverdue = r.status === "pending" && !isFuture;
    const isDone = r.status === "done";
    const dotColor = isDone ? "var(--gc)" : isOverdue ? "var(--rc)" : "var(--oc)";
    return (
      <TimelineFrame
        dotColor={dotColor}
        dotIcon={
          isDone ? (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={dotColor} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          )
        }
        date={r.dueDate}
        background={isOverdue ? "var(--rb)" : isDone ? "var(--sf2)" : "var(--ob)"}
        borderColor={isOverdue ? "var(--rc)" : isDone ? "var(--bd)" : "var(--oc)"}
      >
        <div className="flex items-center justify-between mb-1">
          <span
            className="text-[11px] font-bold uppercase tracking-wider"
            style={{ color: dotColor }}
          >
            {isDone ? "Done reminder" : isOverdue ? "Overdue reminder" : isFuture ? "Reminder" : "Reminder"}
          </span>
          {r.status === "pending" && (
            <div className="flex gap-2">
              <button onClick={() => onReminderAction(r.id, "done")} className="bg-transparent border-0 cursor-pointer text-[10px] p-0 hover:opacity-85 transition-opacity" style={{ fontWeight: 600, color: "var(--gc)" }}>
                Done
              </button>
              <button onClick={() => onReminderAction(r.id, "dismissed")} className="bg-transparent border-0 cursor-pointer text-[10px] p-0 hover:opacity-85 transition-opacity" style={{ color: "var(--t3)" }}>
                Dismiss
              </button>
              <button onClick={() => onDeleteReminder(r.id)} className="bg-transparent border-0 cursor-pointer text-[10px] p-0 hover:opacity-85 transition-opacity" style={{ color: "var(--rc)" }}>
                Delete
              </button>
            </div>
          )}
        </div>
        <div className={cn("text-xs text-foreground leading-normal", isDone && "line-through")}>
          {r.content}
        </div>
      </TimelineFrame>
    );
  }

  if (item.kind === "event") {
    const e = item.data;
    const start = new Date(e.start);
    const end = new Date(e.end);
    const time = `${start.getHours().toString().padStart(2, "0")}:${start.getMinutes().toString().padStart(2, "0")}–${end.getHours().toString().padStart(2, "0")}:${end.getMinutes().toString().padStart(2, "0")}`;
    return (
      <TimelineFrame
        dotColor="var(--pc)"
        dotIcon={
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--pc)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
        }
        date={item.date}
        background="var(--pb)"
        borderColor="var(--pc)"
      >
        <div className="text-[11px] font-bold uppercase tracking-wider text-status-purple mb-0.5" style={{ color: "var(--pc)" }}>
          Call · {e.channel.replace("_", " ")}
        </div>
        <div className="text-xs font-semibold text-foreground">{e.title}</div>
        <div className="font-mono text-[10px] text-muted-foreground mt-0.5 tabular-nums">{time}</div>
      </TimelineFrame>
    );
  }

  return null;
}

function TimelineFrame({
  dotColor, dotIcon, date, background, borderColor, children,
}: {
  dotColor: string;
  dotIcon: React.ReactNode;
  date: string;
  background?: string;
  borderColor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="relative">
      <div
        className="absolute -left-[19px] top-1.5 size-4.5 rounded-full bg-card border-2 flex items-center justify-center z-10"
        style={{ borderColor: dotColor }}
      >
        {dotIcon}
      </div>
      <div
        className="p-2 px-3 bg-muted border border-border rounded-lg"
        style={{ background, borderColor }}
      >
        {children}
        <div className="font-mono text-[10px] text-muted-foreground mt-1 tabular-nums">
          {relativeDate(date)}
        </div>
      </div>
    </div>
  );
}
