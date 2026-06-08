"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { voiceApi, telegramBotApi, type VoiceCaptureApi } from "@/lib/api";
import { Button } from "@/components/ui/button";

const SIMULATE_PROMPTS = [
  "Had a great call with Patrick, he's super engaged and wants to move forward.",
  "Remind me to follow up with Sarah in 3 days about the contract.",
  "Just met Thomas from Sequoia, he's a partner focused on B2B SaaS.",
];
const SIMULATE_LABELS = ["Quick note", "Reminder in 3d", "New contact"];

const ACTION_META: Record<string, { label: string; color: string; bg: string; icon: string }> = {
  note:        { label: "Note",        color: "var(--bc)", bg: "var(--bb)", icon: "M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" },
  reminder:    { label: "Reminder",    color: "var(--oc)", bg: "var(--ob)", icon: "M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" },
  strength:    { label: "Strength",    color: "#E44D26",   bg: "#E44D2615", icon: "M13 10V3L4 14h7v7l9-11h-7z" },
  new_contact: { label: "New contact", color: "var(--gc)", bg: "var(--gb)", icon: "M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" },
  unknown:     { label: "No action",   color: "var(--t3)", bg: "var(--al)", icon: "M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" },
};

function fmtAgo(iso: string): string {
  const diffMin = (Date.now() - new Date(iso).getTime()) / 60000;
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${Math.round(diffMin)}m ago`;
  const h = diffMin / 60;
  if (h < 24) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function fmtDue(iso?: string | null): string {
  if (!iso) return "";
  const days = Math.round((new Date(iso).getTime() - Date.now()) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days < 0) return `${-days}d ago`;
  return `In ${days}d`;
}

function initials(name: string | null): string {
  if (!name) return "?";
  return name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || "").join("");
}

function fakeWave(seed: number, bars = 18): number[] {
  const out: number[] = [];
  let s = seed;
  for (let i = 0; i < bars; i++) {
    s = (s * 9301 + 49297) % 233280;
    out.push(0.3 + (s / 233280) * 0.7);
  }
  return out;
}

export function VoiceView() {
  const router = useRouter();
  const [captures, setCaptures] = useState<VoiceCaptureApi[]>([]);
  const [stats, setStats] = useState({ total: 0, processed: 0, failed: 0, actions: 0 });
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [simText, setSimText] = useState("");
  const [simulating, setSimulating] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);
  const [botUsername, setBotUsername] = useState("subyassistant_bot");

  useEffect(() => {
    telegramBotApi.username().then((v) => setBotUsername(v.username)).catch(() => {});
  }, []);

  useEffect(() => {
    Promise.all([voiceApi.captures(), voiceApi.stats()])
      .then(([caps, st]) => {
        setCaptures(caps);
        setStats(st);
        if (caps.length > 0) setExpanded(caps[0].id);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const runSimulation = async (text?: string) => {
    const transcript = (text ?? simText).trim();
    if (!transcript) return;
    setSimulating(true);
    setSimError(null);
    try {
      const result = await voiceApi.simulate(transcript);
      setCaptures((prev) => [result, ...prev]);
      setStats((s) => ({
        total: s.total + 1,
        processed: result.status === "processed" ? s.processed + 1 : s.processed,
        failed: result.status === "failed" ? s.failed + 1 : s.failed,
        actions: result.action !== "unknown" && result.status === "processed" ? s.actions + 1 : s.actions,
      }));
      setExpanded(result.id);
      setSimText("");
    } catch (err) {
      setSimError((err as Error).message || "Simulation failed");
    } finally {
      setSimulating(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22, maxWidth: 980 }}>
      <div>
        <h1 className="text-xl font-bold tracking-tight">Voice capture</h1>
        <p style={{ color: "var(--t2)", fontSize: 13, marginTop: 4 }}>
          Send voice notes to{" "}
          <a
            href={`https://t.me/${botUsername}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--bc)", textDecoration: "none", fontWeight: 500 }}
          >
            @{botUsername}
          </a>
          . Whisper transcribes, GPT extracts notes / reminders / new contacts.
        </p>
      </div>

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
        {[
          { label: "Captures",       value: stats.total,     color: undefined },
          { label: "Auto-processed", value: stats.processed, color: "var(--gc)" },
          { label: "Failed",         value: stats.failed,    color: stats.failed > 0 ? "var(--rc)" : undefined },
          { label: "Actions created",value: stats.actions,   color: undefined },
        ].map((s) => (
          <div key={s.label} className="rounded-xl border border-border bg-card shadow-sm p-4">
            <div className="text-xs font-medium text-muted-foreground mb-1">{s.label}</div>
            <div className="text-[22px] font-bold tabular-nums tracking-tight" style={{ color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Simulator */}
      <section className="rounded-xl border border-border bg-card shadow-sm" style={{ padding: 16 }}>
        <div className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground" style={{ marginBottom: 8 }}>
          Try a capture
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <input
            value={simText}
            onChange={(e) => setSimText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); runSimulation(); } }}
            placeholder='Type anything, e.g. "Met Sarah from a16z, she wants to invest"'
            disabled={simulating}
            style={{ flex: 1 }}
          />
          <Button
            size="sm"
            onClick={() => runSimulation()}
            disabled={simulating || !simText.trim()}
          >
            {simulating ? (
              <span className="inline-block rounded-full border-2 border-current border-t-transparent animate-spin" style={{ width: 12, height: 12 }} />
            ) : "Run"}
          </Button>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, color: "var(--t3)", alignSelf: "center" }}>Quick fill:</span>
          {SIMULATE_PROMPTS.map((prompt, idx) => (
            <button
              key={idx}
              onClick={() => setSimText(prompt)}
              disabled={simulating}
              style={{ fontSize: 11, padding: "2px 8px", borderRadius: 6, border: "1px solid var(--bd)", background: "var(--sf)", color: "var(--t2)", cursor: "pointer" }}
            >
              {SIMULATE_LABELS[idx]}
            </button>
          ))}
        </div>
        {simError && (
          <div style={{ marginTop: 10, fontSize: 12, color: "var(--rc)" }}>❌ {simError}</div>
        )}
      </section>

      {/* Captures list */}
      <section>
        <div className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground" style={{ marginBottom: 10 }}>
          Recent captures
        </div>
        {loading ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--t3)", fontSize: 13 }}>Loading…</div>
        ) : captures.length === 0 ? (
          <div className="rounded-xl border border-border bg-card shadow-sm" style={{ padding: 40, textAlign: "center", color: "var(--t3)", fontSize: 13 }}>
            No captures yet — send a voice note to @{botUsername} or try the simulator above.
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-card shadow-sm" style={{ overflow: "hidden" }}>
            {captures.map((c, idx) => (
              <CaptureRow
                key={c.id}
                capture={c}
                isLast={idx === captures.length - 1}
                expanded={expanded === c.id}
                onToggle={() => setExpanded(expanded === c.id ? null : c.id)}
                onOpenContact={(id) => router.push(`/dashboard/contacts/${id}`)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function CaptureRow({
  capture, isLast, expanded, onToggle, onOpenContact,
}: {
  capture: VoiceCaptureApi;
  isLast: boolean;
  expanded: boolean;
  onToggle: () => void;
  onOpenContact: (id: string) => void;
}) {
  const wave = useMemo(() => fakeWave(capture.id.length * 7 + capture.transcript.length), [capture.id, capture.transcript.length]);
  const meta = ACTION_META[capture.action] ?? ACTION_META.unknown;
  const failed = capture.status === "failed";

  return (
    <div style={{ borderBottom: isLast ? "none" : "1px solid var(--bd)" }}>
      <button
        onClick={onToggle}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", background: "transparent", border: "none", cursor: "pointer", textAlign: "left" }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--sf2)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        {/* Waveform */}
        <div style={{ display: "flex", alignItems: "center", gap: 2, width: 60, height: 28, flexShrink: 0 }}>
          {wave.map((h, i) => (
            <div key={i} style={{ width: 2, height: `${h * 100}%`, background: failed ? "var(--rc)" : "var(--bc)", opacity: 0.55, borderRadius: 1 }} />
          ))}
        </div>

        {/* Avatar */}
        <div style={{ width: 32, height: 32, borderRadius: "50%", background: "var(--al)", color: "var(--t2)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
          {initials(capture.contactName)}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: capture.contactName ? "var(--t1)" : "var(--t3)" }}>
              {capture.contactName ?? "No contact"}
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 999, background: meta.bg, color: meta.color, fontSize: 10, fontWeight: 600 }}>
              {meta.label}
            </span>
            <span style={{ fontSize: 11, color: "var(--t3)" }}>· {fmtAgo(capture.createdAt)}</span>
          </div>
          <div style={{ fontSize: 12, color: "var(--t2)", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            "{capture.transcript}"
          </div>
        </div>

        <span style={{ fontSize: 11, color: "var(--t3)" }}>{expanded ? "▾" : "▸"}</span>
      </button>

      {expanded && (
        <div style={{ padding: "0 16px 16px 106px" }}>
          {/* Full transcript */}
          <div style={{ padding: "10px 12px", background: "var(--sf2)", border: "1px solid var(--bd)", borderRadius: 8, fontSize: 13, color: "var(--t1)", lineHeight: 1.5, marginBottom: 10 }}>
            {capture.transcript}
            {capture.processingMs != null && (
              <div className="font-mono text-xs tabular-nums" style={{ fontSize: 10, color: "var(--t3)", marginTop: 6 }}>
                Processed in {capture.processingMs}ms · Whisper + GPT-4o-mini
              </div>
            )}
          </div>

          {/* Action detail */}
          {capture.action !== "unknown" && capture.status === "processed" && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "var(--sf)", border: "1px solid var(--bd)", borderLeft: `3px solid ${meta.color}`, borderRadius: 8 }}>
              <div style={{ width: 22, height: 22, borderRadius: 6, background: meta.bg, color: meta.color, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d={meta.icon} />
                </svg>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: meta.color, textTransform: "uppercase", letterSpacing: 0.04 }}>
                  {meta.label}
                  {capture.dueDate && <span style={{ fontWeight: 400, color: "var(--t3)", marginLeft: 6 }}>· {fmtDue(capture.dueDate)}</span>}
                  {capture.strength && <span style={{ marginLeft: 6 }}>→ {capture.strength}</span>}
                </div>
                <div style={{ fontSize: 12, color: "var(--t1)", marginTop: 1 }}>{capture.content}</div>
              </div>
              {capture.contactId && (
                <button
                  onClick={() => onOpenContact(capture.contactId!)}
                  style={{ background: "none", border: "none", color: "var(--bc)", fontSize: 11, cursor: "pointer", padding: "4px 8px", whiteSpace: "nowrap" }}
                >
                  Open contact →
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
