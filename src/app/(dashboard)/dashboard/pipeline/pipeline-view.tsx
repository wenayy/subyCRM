"use client";

import { useState, useMemo, useEffect } from "react";
import { PipelineSkeleton } from "@/components/ui/skeleton";
import { useRouter } from "next/navigation";
import { STAGE_META, STAGES_ORDERED, type Deal, type DealStage } from "@/lib/mock-pipeline";
import { pipelineApi } from "@/lib/api";
import { Button } from "@/components/ui/button";

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || "").join("");
}

function fmtVolume(v: number): string {
  if (v >= 1_000_000) return `€${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `€${Math.round(v / 1_000)}k`;
  return `€${v}`;
}

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

const DEFAULT_PROB: Record<DealStage, number> = {
  intro: 20, first_call: 35, tech_review: 55, term_sheet: 70, live: 100, lost: 0,
};

export function PipelineView() {
  const router = useRouter();
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<DealStage | null>(null);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    pipelineApi.list()
      .then((data) => setDeals(data as Deal[]))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const byStage = useMemo(() => {
    const map: Record<DealStage, Deal[]> = {
      intro: [], first_call: [], tech_review: [], term_sheet: [], live: [], lost: [],
    };
    for (const d of deals) map[d.stage]?.push(d);
    return map;
  }, [deals]);

  const activeDeals = deals.filter((d) => d.stage !== "lost" && d.stage !== "live");
  const totalActive = activeDeals.length;
  const weightedPipeline = activeDeals.reduce((s, d) => s + (d.value * d.probability) / 100, 0);
  const liveVolume = deals.filter((d) => d.stage === "live").reduce((s, d) => s + d.value, 0);

  const moveDeal = (id: string, target: DealStage) => {
    setDeals((prev) =>
      prev.map((d) =>
        d.id === id
          ? { ...d, stage: target, enteredStageAt: new Date().toISOString(), probability: DEFAULT_PROB[target] ?? d.probability }
          : d,
      ),
    );
    pipelineApi.update(id, { stage: target, probability: DEFAULT_PROB[target] }).catch(() => {
      // rollback on error
      pipelineApi.list().then((data) => setDeals(data as Deal[])).catch(console.error);
    });
  };

  const addDeal = async (data: { contactName: string; companyName: string; value: number; source: string; nextStep: string }) => {
    const deal = await pipelineApi.create({ ...data, stage: "intro" });
    setDeals((prev) => [...prev, deal as Deal]);
    setShowForm(false);
  };

  const removeDeal = (id: string) => {
    setDeals((prev) => prev.filter((d) => d.id !== id));
    pipelineApi.remove(id).catch(console.error);
  };

  if (loading) return <PipelineSkeleton />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 className="text-xl font-bold tracking-tight">Pipeline</h1>
          <p style={{ color: "var(--t2)", fontSize: 13, marginTop: 4 }}>
            {totalActive} active deal{totalActive !== 1 ? "s" : ""} · weighted {fmtVolume(weightedPipeline)} · live {fmtVolume(liveVolume)}/mo
          </p>
        </div>
        <Button size="sm" onClick={() => setShowForm(true)}>+ New deal</Button>
      </div>

      {showForm && (
        <NewDealForm onSubmit={addDeal} onCancel={() => setShowForm(false)} />
      )}

      <div
        className="grid gap-2.5 items-start"
        style={{ gridTemplateColumns: `repeat(${STAGES_ORDERED.length}, minmax(0, 1fr))` }}
      >
        {STAGES_ORDERED.map((stage) => {
          const meta = STAGE_META[stage];
          const items = byStage[stage];
          const totalValue = items.reduce((s, d) => s + d.value, 0);
          const isTarget = dragOver === stage;

          return (
            <div
              key={stage}
              className="rounded-xl p-2.5 flex flex-col gap-2.5 min-h-[280px] transition-[background,outline-color]"
              onDragOver={(e) => { e.preventDefault(); setDragOver(stage); }}
              onDragLeave={() => setDragOver((d) => (d === stage ? null : d))}
              onDrop={(e) => {
                e.preventDefault();
                if (draggedId) moveDeal(draggedId, stage);
                setDraggedId(null);
                setDragOver(null);
              }}
              style={{
                background: isTarget ? meta.bg : "var(--sf2)",
                outline: isTarget ? `2px dashed ${meta.color}` : "1px solid var(--bd)",
                outlineOffset: isTarget ? -2 : 0,
              }}
            >
              <div className="flex items-center justify-between py-0.5 px-1">
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: meta.color }} />
                  <span style={{ fontSize: 11, fontWeight: 600, color: "var(--t1)", textTransform: "uppercase", letterSpacing: 0.04 }}>
                    {meta.label}
                  </span>
                </div>
                <span style={{ fontSize: 10, fontWeight: 600, color: "var(--t2)" }}>
                  {items.length} · {fmtVolume(totalValue)}
                </span>
              </div>

              <div className="flex flex-col gap-2">
                {items.length === 0 ? (
                  <div style={{ fontSize: 11, color: "var(--t3)", textAlign: "center", padding: "12px 6px" }}>Empty.</div>
                ) : (
                  items.map((d) => (
                    <DealCard
                      key={d.id}
                      deal={d}
                      tone={meta.color}
                      onDragStart={() => setDraggedId(d.id)}
                      onDragEnd={() => { setDraggedId(null); setDragOver(null); }}
                      onOpen={() => router.push(`/dashboard/contacts/${d.contactId}`)}
                      onDelete={() => removeDeal(d.id)}
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function NewDealForm({ onSubmit, onCancel }: {
  onSubmit: (data: { contactName: string; companyName: string; value: number; source: string; nextStep: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [contactName, setContactName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [value, setValue] = useState("");
  const [source, setSource] = useState("outbound");
  const [nextStep, setNextStep] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!contactName.trim()) return;
    setSaving(true);
    try {
      await onSubmit({ contactName: contactName.trim(), companyName: companyName.trim(), value: parseFloat(value) || 0, source, nextStep: nextStep.trim() });
    } finally { setSaving(false); }
  };

  const inputCls = "w-full px-2.5 py-1.5 text-sm rounded-lg border border-border bg-muted/50 text-foreground focus:outline-none focus:ring-1 focus:ring-primary";

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm p-4" style={{ maxWidth: 480 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: "var(--t1)" }}>New deal</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <input className={inputCls} placeholder="Contact name *" value={contactName} onChange={(e) => setContactName(e.target.value)} />
        <input className={inputCls} placeholder="Company name" value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
        <div style={{ display: "flex", gap: 8 }}>
          <input className={inputCls} placeholder="Value (€/mo)" type="number" value={value} onChange={(e) => setValue(e.target.value)} style={{ flex: 1 }} />
          <select className={inputCls} value={source} onChange={(e) => setSource(e.target.value)} style={{ flex: 1 }}>
            <option value="outbound">Outbound</option>
            <option value="inbound">Inbound</option>
            <option value="referral">Referral</option>
            <option value="event">Event</option>
          </select>
        </div>
        <input className={inputCls} placeholder="Next step (optional)" value={nextStep} onChange={(e) => setNextStep(e.target.value)} />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
          <Button size="sm" variant="outline" onClick={onCancel}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={saving || !contactName.trim()}>
            {saving ? "Adding…" : "Add to intro"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function DealCard({
  deal, tone, onDragStart, onDragEnd, onOpen, onDelete,
}: {
  deal: Deal;
  tone: string;
  onDragStart: () => void;
  onDragEnd: () => void;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const [hover, setHover] = useState(false);
  const ageDays = daysSince(deal.enteredStageAt);
  const stale = ageDays > 14 && deal.stage !== "live" && deal.stage !== "lost";

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: "var(--sf)",
        border: "1px solid var(--bd)",
        borderLeft: `3px solid ${tone}`,
        borderRadius: 8,
        padding: "10px 12px",
        cursor: "grab",
        boxShadow: hover ? "var(--shadow)" : "var(--shadow-sm)",
        transition: "box-shadow 0.12s, transform 0.12s",
        transform: hover ? "translateY(-1px)" : "none",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        position: "relative",
      }}
    >
      {hover && (
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          style={{
            position: "absolute", top: 6, right: 6,
            background: "none", border: "none", cursor: "pointer",
            fontSize: 12, color: "var(--t3)", lineHeight: 1, padding: 2,
          }}
          title="Remove deal"
        >✕</button>
      )}

      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
        <div onClick={onOpen} style={{ flex: 1, minWidth: 0, cursor: deal.contactId ? "pointer" : "default" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--t1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {deal.companyName || deal.contactName}
          </div>
          <div style={{ fontSize: 11, color: "var(--t3)", marginTop: 1 }}>
            {deal.companyName ? deal.contactName : ""}
          </div>
        </div>
        <span
          className="font-mono text-xs tabular-nums"
          style={{ fontSize: 11, fontWeight: 700, color: "var(--t1)", background: "var(--al)", padding: "1px 6px", borderRadius: 4, whiteSpace: "nowrap" }}
        >
          {fmtVolume(deal.value)}
        </span>
      </div>

      {deal.nextStep && (
        <div style={{ fontSize: 11, color: "var(--t2)", lineHeight: 1.4, fontStyle: "italic" }}>
          → {deal.nextStep}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 2 }}>
        <span style={{ fontSize: 10, color: stale ? "var(--rc)" : "var(--t3)", fontWeight: stale ? 600 : 400 }}>
          {ageDays === 0 ? "today" : `${ageDays}d in stage`}{stale ? " ⚠" : ""}
        </span>
        {deal.probability > 0 && deal.probability < 100 && (
          <span style={{ fontSize: 10, color: "var(--t2)" }}>{deal.probability}%</span>
        )}
      </div>

      {deal.stage !== "lost" && deal.stage !== "live" && (
        <div style={{ height: 3, background: "var(--al)", borderRadius: 2, overflow: "hidden" }}>
          <div style={{ width: `${deal.probability}%`, height: "100%", background: tone, borderRadius: 2, transition: "width 0.2s" }} />
        </div>
      )}
    </div>
  );
}
