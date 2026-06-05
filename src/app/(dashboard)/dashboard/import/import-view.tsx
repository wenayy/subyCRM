"use client";

import { useState, useEffect } from "react";
import { importApi, aiApi } from "@/lib/api";
import { MOCK_IMPORT_JOBS } from "@/lib/mock-contacts";
import type { ImportJob } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";

function relativeDate(dateStr: string | null): string {
  if (!dateStr) return "--";
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

const STATUS_BADGE: Record<string, "green" | "red" | "blue" | "yellow"> = {
  completed: "green", failed: "red", running: "blue", pending: "yellow",
};

const SOURCES = [
  {
    key: "beeper",
    name: "Beeper / Matrix",
    description: "Import DM contacts from Beeper — pulls WhatsApp, Telegram, Twitter/X and LinkedIn contacts from all your connected bridges.",
    icon: "M",
    color: "var(--pc)",
    bg: "var(--pb)",
    status: "ready",
  },
  {
    key: "telegram",
    name: "Telegram (MTProto)",
    description: "Import all people from your Telegram dialogs via direct API. Requires Telegram personal to be connected in Settings.",
    icon: "T",
    color: "#229ED9",
    bg: "#229ED915",
    status: "ready",
  },
  {
    key: "whatsapp",
    name: "WhatsApp",
    description: "WhatsApp contacts are imported automatically via Beeper above. Direct WhatsApp import is coming soon.",
    icon: "W",
    color: "#25D366",
    bg: "#25D36615",
    status: "ready",
  },
  {
    key: "discord",
    name: "Discord",
    description: "Import DM contacts and server members from Discord using a bot token.",
    icon: "D",
    color: "#5865F2",
    bg: "#5865F215",
    status: "ready",
  },
  {
    key: "slack",
    name: "Slack",
    description: "Import workspace members and DM contacts from Slack using an OAuth token.",
    icon: "S",
    color: "#E01E5A",
    bg: "#E01E5A15",
    status: "coming_soon",
  },
];

const SAMPLE_CSV = `name,email,phone,company,role,linkedin,twitter,notes,tags
Jane Smith,jane@acme.com,+1234567890,Acme Corp,CEO,https://linkedin.com/in/janesmith,janesmith,Met at TechConf 2024,investor;founder
John Doe,john@startup.io,,Startup IO,CTO,,,Follow up about partnership,`;

function downloadSampleCsv() {
  const blob = new Blob([SAMPLE_CSV], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "suby-contacts-template.csv";
  a.click();
  URL.revokeObjectURL(url);
}

export function ImportView() {
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [importing, setImporting] = useState<string | null>(null);
  const [classifying, setClassifying] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);
  const [csvDragging, setCsvDragging] = useState(false);

  const loadJobs = () => {
    importApi.getJobs()
      .then((j) => setJobs(j?.length ? j : MOCK_IMPORT_JOBS))
      .catch(() => setJobs(MOCK_IMPORT_JOBS));
  };

  useEffect(() => { loadJobs(); }, []);

  const pollJob = (jobId: string, sourceKey: string) => {
    const poll = setInterval(() => {
      importApi.getJobs().then((j) => {
        setJobs(j);
        const current = j.find((x) => x.id === jobId);
        if (current && (current.status === "completed" || current.status === "failed")) {
          clearInterval(poll);
          setImporting(null);
          if (current.status === "completed") {
            setMessage({ text: `${sourceKey} import done: ${current.imported ?? 0} imported, ${current.deduplicated ?? 0} deduped, ${current.errors ?? 0} skipped`, type: "success" });
          } else {
            setMessage({ text: `${sourceKey} import failed. Check server logs.`, type: "error" });
          }
        }
      }).catch(() => { /* ignore poll errors */ });
    }, 2000);
    // Safety timeout: 30 minutes — long enough for any realistic import
    setTimeout(() => { clearInterval(poll); setImporting(null); }, 30 * 60 * 1000);
  };

  const handleBeeperImport = async () => {
    setImporting("beeper");
    setMessage(null);
    try {
      const res = await importApi.runBeeper();
      setMessage({ text: `Beeper import started`, type: "success" });
      if (res.jobId) pollJob(res.jobId, "Beeper");
    } catch {
      setMessage({ text: "Failed to start import. Is the backend running?", type: "error" });
      setImporting(null);
    }
  };

  const handleTelegramImport = async () => {
    setImporting("telegram");
    setMessage(null);
    try {
      const res = await importApi.runTelegram();
      setMessage({ text: "Telegram import started — scanning your dialogs…", type: "success" });
      pollJob(res.jobId, "Telegram");
    } catch (e: any) {
      setMessage({ text: e?.message ?? "Failed to start Telegram import.", type: "error" });
      setImporting(null);
    }
  };

  const handleDiscordImport = async () => {
    setImporting("discord");
    setMessage(null);
    try {
      const res = await importApi.runDiscord();
      setMessage({ text: "Discord import started — scanning servers and members…", type: "success" });
      pollJob(res.jobId, "Discord");
    } catch (e: any) {
      setMessage({ text: e?.message ?? "Failed to start Discord import.", type: "error" });
      setImporting(null);
    }
  };

  const handleWhatsAppImport = async () => {
    setImporting("whatsapp");
    setMessage(null);
    try {
      const res = await importApi.runWhatsApp();
      setMessage({ text: "WhatsApp import started — scanning contacts…", type: "success" });
      pollJob(res.jobId, "WhatsApp");
    } catch (e: any) {
      setMessage({ text: e?.message ?? "Failed to start WhatsApp import.", type: "error" });
      setImporting(null);
    }
  };

  const handleCsvFile = async (file: File) => {
    if (!file.name.endsWith(".csv") && file.type !== "text/csv") {
      setMessage({ text: "Please upload a .csv file", type: "error" });
      return;
    }
    const text = await file.text();
    setImporting("csv");
    setMessage(null);
    try {
      const res = await importApi.runCsv(text);
      setMessage({ text: "CSV import started…", type: "success" });
      pollJob(res.jobId, "csv");
    } catch (e: any) {
      setMessage({ text: e?.message ?? "CSV import failed.", type: "error" });
      setImporting(null);
    }
  };

  const handleClassifyAll = async () => {
    setClassifying(true);
    setMessage(null);
    try {
      const res = await aiApi.classifyBatch();
      setMessage({ text: `Queued ${res.queued} contacts for AI classification`, type: "success" });
    } catch {
      setMessage({ text: "Classification failed.", type: "error" });
    } finally {
      setClassifying(false);
    }
  };

  const lastCompleted = jobs.find((j) => j.status === "completed");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 className="text-xl font-bold tracking-tight">Import</h1>
          <p style={{ color: "var(--t2)", fontSize: 13, marginTop: 4 }}>Import contacts from your messaging platforms</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Button size="sm" variant="purple" onClick={handleClassifyAll} disabled={classifying}>
            {classifying && <Spinner />}{classifying ? "Classifying…" : "Classify All (AI)"}
          </Button>
        </div>
      </div>

      {message && (
        <div style={{
          padding: "10px 14px", borderRadius: "var(--r)", fontSize: 13, fontWeight: 500,
          background: message.type === "success" ? "var(--gb)" : "var(--rb)",
          color: message.type === "success" ? "var(--gc)" : "var(--rc)",
        }}>
          {message.text}
        </div>
      )}

      {/* Last import stats */}
      {lastCompleted && (
        <div className="rounded-xl border border-border bg-card shadow-sm" style={{ padding: 16 }}>
          <div className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground" style={{ marginBottom: 10 }}>Last Import Summary</div>
          <div className="grid grid-cols-4 gap-3" style={{ gap: 12 }}>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: "var(--t1)" }}>{lastCompleted.totalFound ?? 0}</div>
              <div style={{ fontSize: 11, color: "var(--t3)" }}>Found</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: "var(--gc)" }}>{lastCompleted.imported ?? 0}</div>
              <div style={{ fontSize: 11, color: "var(--t3)" }}>Imported</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: "var(--oc)" }}>{lastCompleted.deduplicated ?? 0}</div>
              <div style={{ fontSize: 11, color: "var(--t3)" }}>Deduplicated</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: lastCompleted.errors ? "var(--rc)" : "var(--t1)" }}>{lastCompleted.errors ?? 0}</div>
              <div style={{ fontSize: 11, color: "var(--t3)" }}>Errors</div>
            </div>
          </div>
        </div>
      )}

      {/* Source cards */}
      <div className="grid grid-cols-3 gap-3" style={{ gap: 16 }}>
        {SOURCES.map((s) => (
          <div key={s.key} className="rounded-xl border border-border bg-card shadow-sm" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{
                width: 36, height: 36, borderRadius: 8, background: s.bg, color: s.color,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontWeight: 700, fontSize: 16,
              }}>
                {s.icon}
              </div>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{s.name}</div>
              </div>
            </div>
            <div style={{ fontSize: 13, color: "var(--t2)", lineHeight: 1.5 }}>{s.description}</div>
            <div style={{ marginTop: "auto" }}>
              {s.status === "ready" ? (
                <Button
                  size="sm"
                  onClick={
                    s.key === "telegram"
                      ? handleTelegramImport
                      : s.key === "discord"
                      ? handleDiscordImport
                      : s.key === "whatsapp"
                      ? handleWhatsAppImport
                      : handleBeeperImport
                  }
                  disabled={importing !== null}
                  style={{ width: "100%" }}
                >
                  {importing === s.key && <Spinner />}{importing === s.key ? "Importing…" : `Import from ${s.name}`}
                </Button>
              ) : (
                <Badge variant="yellow">Coming soon</Badge>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* CSV Upload */}
      <div className="rounded-xl border border-border bg-card shadow-sm" style={{ padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">Import from CSV</div>
          <button
            onClick={downloadSampleCsv}
            style={{
              fontSize: 12, color: "var(--pc)", background: "none", border: "none",
              cursor: "pointer", padding: "2px 0", fontWeight: 500, textDecoration: "underline",
            }}
          >
            Download template
          </button>
        </div>
        <label
          htmlFor="csv-upload"
          onDragOver={(e) => { e.preventDefault(); setCsvDragging(true); }}
          onDragLeave={() => setCsvDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setCsvDragging(false);
            const file = e.dataTransfer.files[0];
            if (file) handleCsvFile(file);
          }}
          style={{
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            gap: 8, padding: "32px 20px", borderRadius: "var(--r)",
            border: `2px dashed ${csvDragging ? "var(--pc)" : "var(--border)"}`,
            background: csvDragging ? "var(--pb)" : "transparent",
            cursor: importing === "csv" ? "not-allowed" : "pointer",
            transition: "border-color 0.15s, background 0.15s",
          }}
        >
          <div style={{ fontSize: 28 }}>📂</div>
          <div style={{ fontSize: 14, fontWeight: 500, color: "var(--t1)" }}>
            {importing === "csv" ? "Uploading…" : "Drop a CSV file here or click to browse"}
          </div>
          <div style={{ fontSize: 12, color: "var(--t3)" }}>
            Supports: name, email, phone, company, role, linkedin, twitter, notes, tags
          </div>
          {importing === "csv" && <Spinner />}
          <input
            id="csv-upload"
            type="file"
            accept=".csv,text/csv"
            style={{ display: "none" }}
            disabled={importing !== null}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleCsvFile(file);
              e.target.value = "";
            }}
          />
        </label>
      </div>

      {/* Recent import jobs */}
      {jobs.length > 0 && (
        <div className="rounded-xl border border-border bg-card shadow-sm" style={{ padding: 20 }}>
          <div className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground" style={{ marginBottom: 12 }}>Import History</div>
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Status</th>
                <th>Found</th>
                <th>Imported</th>
                <th>Dedup</th>
                <th>Errors</th>
                <th className="max-md:hidden">Date</th>
              </tr>
            </thead>
            <tbody>
              {jobs
                .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                .map((j) => (
                <tr key={j.id}>
                  <td style={{ fontWeight: 500, textTransform: "capitalize" }}>{j.source.replace("_", " ")}</td>
                  <td>
                    <Badge variant={STATUS_BADGE[j.status] || "yellow"}>
                      {j.status}
                    </Badge>
                  </td>
                  <td className="font-mono text-xs tabular-nums">{j.totalFound ?? "--"}</td>
                  <td className="font-mono text-xs tabular-nums">{j.imported ?? "--"}</td>
                  <td className="font-mono text-xs tabular-nums">{j.deduplicated ?? "--"}</td>
                  <td className="font-mono text-xs tabular-nums" style={{ color: j.errors ? "var(--rc)" : undefined }}>
                    {j.errors ?? "--"}
                    {j.errors && (j.errorLog as any)?.errors?.[0] && (
                      <div style={{ fontSize: 10, color: "var(--rc)", marginTop: 2, maxWidth: 200, whiteSpace: "normal" }}>
                        {(j.errorLog as any).errors[0]}
                      </div>
                    )}
                  </td>
                  <td className="max-md:hidden font-mono text-xs tabular-nums" style={{ fontSize: 12, color: "var(--t3)" }}>{relativeDate(j.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
