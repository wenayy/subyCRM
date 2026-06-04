"use client";

import { useState, useMemo, useEffect } from "react";
import { useRouter } from "next/navigation";
import { type Sequence, type SequenceStep, type StepStatus } from "@/lib/mock-sequences";
import { sequenceApi } from "@/lib/api";
import { PlatformIcon } from "@/components/platform-icon";
import type { PlatformType } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const STATUS_META: Record<StepStatus, { label: string; color: string; bg: string }> = {
  sent:      { label: "Sent",      color: "var(--gc)", bg: "var(--gb)" },
  scheduled: { label: "Scheduled", color: "var(--bc)", bg: "var(--bb)" },
  waiting:   { label: "Waiting",   color: "var(--t2)", bg: "var(--al)" },
  skipped:   { label: "Skipped",   color: "var(--t3)", bg: "var(--al)" },
};

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || "").join("");
}

function fmtWhen(iso: string): string {
  const days = Math.round((new Date(iso).getTime() - Date.now()) / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days < 0) return `${-days}d ago`;
  return `in ${days}d`;
}

export function SequencesView() {
  const router = useRouter();
  const [seqs, setSeqs] = useState<Sequence[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    sequenceApi.list()
      .then((data) => {
        setSeqs(data as Sequence[]);
        if (data.length > 0) setExpanded(data[0].id);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const counts = useMemo(() => ({
    active: seqs.filter((s) => !s.paused).length,
    paused: seqs.filter((s) => s.paused).length,
    pending: seqs.flatMap((s) => s.steps).filter((st) => st.status === "scheduled" || st.status === "waiting").length,
    sent: seqs.flatMap((s) => s.steps).filter((st) => st.status === "sent").length,
  }), [seqs]);

  const togglePause = (id: string) => {
    const seq = seqs.find((s) => s.id === id);
    if (!seq) return;
    const newPaused = !seq.paused;
    setSeqs((prev) => prev.map((s) => (s.id === id ? { ...s, paused: newPaused } : s)));
    sequenceApi.update(id, { paused: newPaused }).catch(() => {
      setSeqs((prev) => prev.map((s) => (s.id === id ? { ...s, paused: seq.paused } : s)));
    });
  };

  const removeSeq = (id: string) => {
    setSeqs((prev) => prev.filter((s) => s.id !== id));
    sequenceApi.remove(id).catch(console.error);
  };

  const addSeq = async (data: { contactName: string; company: string; goal: string; channel: string }) => {
    const now = new Date();
    const seq = await sequenceApi.create({
      contactName: data.contactName,
      company: data.company || undefined,
      goal: data.goal,
      steps: [
        { channel: data.channel, delayDays: 0, scheduledFor: now.toISOString(), draft: "", rationale: "" },
        { channel: "email", delayDays: 5, scheduledFor: new Date(now.getTime() + 5 * 86400000).toISOString(), draft: "", rationale: "" },
        { channel: "email", delayDays: 7, scheduledFor: new Date(now.getTime() + 12 * 86400000).toISOString(), draft: "", rationale: "" },
      ],
    });
    setSeqs((prev) => [seq as Sequence, ...prev]);
    setExpanded(seq.id);
    setShowForm(false);
  };

  if (loading) {
    return <div style={{ color: "var(--t3)", fontSize: 13, padding: 32 }}>Loading sequences…</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 980 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h1 className="text-xl font-bold tracking-tight">Follow-up sequences</h1>
            <Badge variant="purple" className="text-[10px]">AI</Badge>
          </div>
          <p style={{ color: "var(--t2)", fontSize: 13, marginTop: 4 }}>
            {counts.active} active · {counts.pending} steps pending · {counts.sent} sent · drafts only, no auto-send.
          </p>
        </div>
        <Button size="sm" onClick={() => setShowForm(true)}>+ New sequence</Button>
      </div>

      <div className="rounded-xl border border-border bg-card shadow-sm" style={{ padding: 12, background: "var(--yb)", border: "1px solid #f5e1a0", color: "var(--yc)", fontSize: 12 }}>
        ⚠ No auto-send. AI prepares messages and schedules follow-ups. You copy/send by hand.
      </div>

      {showForm && (
        <NewSequenceForm onSubmit={addSeq} onCancel={() => setShowForm(false)} />
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {seqs.length === 0 && (
          <div style={{ fontSize: 13, color: "var(--t3)", textAlign: "center", padding: 32 }}>
            No sequences yet. Click "+ New sequence" to create one.
          </div>
        )}
        {seqs.map((s) => (
          <SequenceCard
            key={s.id}
            sequence={s}
            expanded={expanded === s.id}
            onToggle={() => setExpanded(expanded === s.id ? null : s.id)}
            onPause={() => togglePause(s.id)}
            onDelete={() => removeSeq(s.id)}
            onOpenContact={() => s.contactId && router.push(`/dashboard/contacts/${s.contactId}`)}
          />
        ))}
      </div>
    </div>
  );
}

function NewSequenceForm({ onSubmit, onCancel }: {
  onSubmit: (data: { contactName: string; company: string; goal: string; channel: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [contactName, setContactName] = useState("");
  const [company, setCompany] = useState("");
  const [goal, setGoal] = useState("");
  const [channel, setChannel] = useState("email");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!contactName.trim() || !goal.trim()) return;
    setSaving(true);
    try { await onSubmit({ contactName: contactName.trim(), company: company.trim(), goal: goal.trim(), channel }); }
    finally { setSaving(false); }
  };

  const inputCls = "w-full px-2.5 py-1.5 text-sm rounded-lg border border-border bg-muted/50 text-foreground focus:outline-none focus:ring-1 focus:ring-primary";

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm p-4" style={{ maxWidth: 520 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: "var(--t1)" }}>New sequence</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <input className={inputCls} placeholder="Contact name *" value={contactName} onChange={(e) => setContactName(e.target.value)} />
        <input className={inputCls} placeholder="Company (optional)" value={company} onChange={(e) => setCompany(e.target.value)} />
        <input className={inputCls} placeholder="Goal *  e.g. Re-open conversation after 60d silence" value={goal} onChange={(e) => setGoal(e.target.value)} />
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "var(--t2)", whiteSpace: "nowrap" }}>First touch via</span>
          <select className={inputCls} value={channel} onChange={(e) => setChannel(e.target.value)} style={{ flex: 1 }}>
            <option value="email">Email</option>
            <option value="linkedin">LinkedIn</option>
            <option value="telegram">Telegram</option>
            <option value="x">X (Twitter)</option>
            <option value="whatsapp">WhatsApp</option>
          </select>
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
          <Button size="sm" variant="outline" onClick={onCancel}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={saving || !contactName.trim() || !goal.trim()}>
            {saving ? "Creating…" : "Create"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SequenceCard({
  sequence, expanded, onToggle, onPause, onDelete, onOpenContact,
}: {
  sequence: Sequence;
  expanded: boolean;
  onToggle: () => void;
  onPause: () => void;
  onDelete: () => void;
  onOpenContact: () => void;
}) {
  const sentCount = sequence.steps.filter((st) => st.status === "sent").length;
  const nextStep = sequence.steps.find((st) => st.status === "scheduled" || st.status === "waiting");

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm" style={{ overflow: "hidden", opacity: sequence.paused ? 0.7 : 1 }}>
      <button
        onClick={onToggle}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", background: "transparent", border: "none", cursor: "pointer", textAlign: "left" }}
      >
        <div style={{ width: 36, height: 36, borderRadius: "50%", background: "var(--al)", color: "var(--t2)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
          {initials(sequence.contactName)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: "var(--t1)" }}>{sequence.contactName}</span>
            {sequence.company && <span style={{ fontSize: 12, color: "var(--t3)" }}>· {sequence.company}</span>}
            {sequence.paused && (
              <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 4, background: "var(--al)", color: "var(--t3)" }}>PAUSED</span>
            )}
          </div>
          <div style={{ fontSize: 12, color: "var(--t2)", marginTop: 2 }}>{sequence.goal}</div>
          <div style={{ fontSize: 11, color: "var(--t3)", marginTop: 2 }}>
            {sentCount}/{sequence.steps.length} steps sent
            {nextStep && (
              <> · next on <span className="font-mono text-xs tabular-nums">{nextStep.channel}</span> {fmtWhen(nextStep.scheduledFor)}</>
            )}
          </div>
        </div>

        <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
          {sequence.steps.map((st) => {
            const meta = STATUS_META[st.status];
            return (
              <span
                key={st.id}
                title={`Step ${st.index} · ${meta.label}`}
                style={{ width: 9, height: 9, borderRadius: "50%", background: meta.color, opacity: st.status === "sent" ? 1 : st.status === "skipped" ? 0.3 : 0.5, border: st.status === "waiting" || st.status === "scheduled" ? `1.5px dashed ${meta.color}` : "none" }}
              />
            );
          })}
        </div>

        <span style={{ fontSize: 11, color: "var(--t3)" }}>{expanded ? "▾" : "▸"}</span>
      </button>

      {expanded && (
        <div style={{ padding: "0 16px 16px 16px" }}>
          <div style={{ position: "relative", paddingLeft: 22, marginTop: 4 }}>
            <div style={{ position: "absolute", left: 10, top: 8, bottom: 8, width: 1, background: "var(--bd)" }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {sequence.steps.map((st) => <StepRow key={st.id} step={st} />)}
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center" }}>
            <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); onPause(); }}>
              {sequence.paused ? "Resume" : "Pause"}
            </Button>
            {sequence.contactId && (
              <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); onOpenContact(); }}>
                Open contact ↗
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); onDelete(); }} style={{ color: "var(--rc)" }}>
              Delete
            </Button>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: "var(--t3)" }}>Drafts only — copy and send manually.</span>
          </div>
        </div>
      )}
    </div>
  );
}

function StepRow({ step }: { step: SequenceStep }) {
  const meta = STATUS_META[step.status] ?? STATUS_META.waiting;
  const isFuture = step.status === "scheduled" || step.status === "waiting";
  return (
    <div style={{ position: "relative" }}>
      <div style={{ position: "absolute", left: -17, top: 4, width: 14, height: 14, borderRadius: "50%", background: "var(--sf)", border: `2px solid ${meta.color}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, fontWeight: 700, color: meta.color }}>
        {step.index}
      </div>
      <div style={{ padding: "10px 12px", background: isFuture ? "var(--sf2)" : "var(--sf)", border: "1px solid var(--bd)", borderRadius: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "2px 7px", borderRadius: 999, background: meta.bg, color: meta.color, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.04 }}>
            <PlatformIcon type={step.channel as PlatformType} size={10} />
            {step.channel}
          </span>
          <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: meta.bg, color: meta.color }}>
            {meta.label}
          </span>
          <span className="font-mono text-xs tabular-nums" style={{ fontSize: 10, color: "var(--t3)" }}>
            {fmtWhen(step.scheduledFor)}
          </span>
          {step.delayDays > 0 && (
            <span style={{ fontSize: 10, color: "var(--t3)" }}>· +{step.delayDays}d after previous</span>
          )}
        </div>
        {step.draft ? (
          <div style={{ fontSize: 12, color: "var(--t1)", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{step.draft}</div>
        ) : (
          <div style={{ fontSize: 12, color: "var(--t3)", fontStyle: "italic" }}>No draft yet</div>
        )}
        {step.rationale && (
          <div style={{ fontSize: 10, color: "var(--t3)", marginTop: 6, fontStyle: "italic" }}>💡 {step.rationale}</div>
        )}
      </div>
    </div>
  );
}
