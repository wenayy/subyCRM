"use client";

import { useState, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import { companiesApi } from "@/lib/api";
import { MOCK_COMPANIES } from "@/lib/mock-companies";
import type { Company, Contact } from "@/lib/types";
import { PlatformIcon } from "@/components/platform-icon";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const TYPE_COLORS: Record<string, "green" | "yellow" | "blue" | "red" | "purple" | "orange"> = {
  vc: "purple", lead: "blue", partner: "green", friend: "yellow", prospect: "orange",
  team: "blue", advisor: "purple", media: "orange", other: "blue",
};

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

export function CompanyDetailView({ paramsPromise }: { paramsPromise: Promise<{ id: string }> }) {
  const { id } = use(paramsPromise);
  const router = useRouter();
  const [company, setCompany] = useState<Company | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    name: "", sector: "", size: "", funding: "", website: "", linkedin: "", description: "",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const applyCompany = (c: Company) => {
      setCompany(c);
      setForm({
        name: c.name || "",
        sector: c.sector || "",
        size: c.size || "",
        funding: c.funding || "",
        website: c.website || "",
        linkedin: c.linkedin || "",
        description: c.description || "",
      });
    };

    companiesApi.getById(id)
      .then(applyCompany)
      .catch(() => {
        // Fall back to mock only if API fails (e.g. offline dev)
        const mock = MOCK_COMPANIES.find((m) => m.id === id);
        if (mock) applyCompany(mock);
      })
      .finally(() => setLoading(false));
  }, [id]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const updated = await companiesApi.update(id, {
        name: form.name || undefined,
        sector: form.sector || null,
        size: form.size || null,
        funding: form.funding || null,
        website: form.website || null,
        linkedin: form.linkedin || null,
        description: form.description || null,
      });
      setCompany((prev) => prev ? { ...prev, ...updated } : updated);
      setEditing(false);
    } catch {}
    finally { setSaving(false); }
  };

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 80 }}>
        <span className="inline-block size-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" style={{ width: 20, height: 20, color: "var(--t3)" }} />
      </div>
    );
  }

  if (!company) {
    return <div className="py-12 px-6 text-center text-muted-foreground text-sm">Company not found</div>;
  }

  const contacts = company.contacts || [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <Button size="sm" variant="outline" onClick={() => router.push("/dashboard/companies")} style={{ alignSelf: "flex-start" }}>
        ← Back to companies
      </Button>

      {/* Header */}
      <div className="rounded-xl border border-border bg-card shadow-sm" style={{ padding: 24 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            {editing ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Company name" style={{ fontSize: 18, fontWeight: 700 }} />
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <input value={form.sector} onChange={(e) => setForm({ ...form, sector: e.target.value })} placeholder="Sector" style={{ flex: 1, minWidth: 120 }} />
                  <select
                    value={form.size}
                    onChange={(e) => setForm({ ...form, size: e.target.value })}
                    style={{ flex: 1, minWidth: 120, height: 36, borderRadius: "var(--r)", border: "1px solid var(--bd)", background: "var(--sf)", color: "var(--t1)", fontSize: 13, padding: "0 10px" }}
                  >
                    <option value="">Size...</option>
                    <option value="startup">Startup</option>
                    <option value="scaleup">Scaleup</option>
                    <option value="enterprise">Enterprise</option>
                  </select>
                  <input value={form.funding} onChange={(e) => setForm({ ...form, funding: e.target.value })} placeholder="Funding (e.g. seed, series-a)" style={{ flex: 1, minWidth: 120 }} />
                </div>
                <input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} placeholder="Website URL" />
                <input value={form.linkedin} onChange={(e) => setForm({ ...form, linkedin: e.target.value })} placeholder="LinkedIn URL" />
                <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Description" rows={3} style={{ resize: "vertical" }} />
                <div style={{ display: "flex", gap: 8 }}>
                  <Button size="sm" variant="purple" onClick={handleSave} disabled={saving}>
                    {saving ? "Saving..." : "Save"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
                </div>
              </div>
            ) : (
              <>
                <h1 className="text-xl font-bold tracking-tight">{company.name}</h1>
                <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                  {company.sector && <Badge variant="purple">{company.sector}</Badge>}
                  {company.size && <Badge variant="green">{company.size}</Badge>}
                  {company.funding && <Badge variant="orange">{company.funding}</Badge>}
                </div>
                {company.description && (
                  <p style={{ fontSize: 13, color: "var(--t2)", marginTop: 10, lineHeight: 1.6 }}>{company.description}</p>
                )}
                <div style={{ display: "flex", gap: 12, marginTop: 10, flexWrap: "wrap" }}>
                  {company.website && (
                    <a href={company.website.startsWith("http") ? company.website : `https://${company.website}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: "var(--bc)", textDecoration: "none" }}>
                      Website →
                    </a>
                  )}
                  {company.linkedin && (
                    <a href={company.linkedin.startsWith("http") ? company.linkedin : `https://${company.linkedin}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: "var(--bc)", textDecoration: "none" }}>
                      LinkedIn →
                    </a>
                  )}
                </div>
              </>
            )}
          </div>
          {!editing && (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Edit</Button>
          )}
        </div>
      </div>

      {/* Contacts table */}
      <div className="rounded-xl border border-border bg-card shadow-sm" style={{ padding: 20 }}>
        <div className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground" style={{ marginBottom: 12 }}>
          Contacts ({contacts.length})
        </div>
        {contacts.length > 0 ? (
          <div style={{ overflow: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="max-md:hidden">Platforms</th>
                  <th>Type</th>
                  <th className="max-md:hidden">Role</th>
                  <th className="max-md:hidden">Last contact</th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((c: Contact) => (
                  <tr key={c.id} style={{ cursor: "pointer" }} onClick={() => router.push(`/dashboard/contacts/${c.id}`)}>
                    <td>
                      <div style={{ fontWeight: 500 }}>{c.name}</div>
                    </td>
                    <td className="max-md:hidden">
                      <div style={{ display: "flex", gap: 4 }}>
                        {c.platforms?.map((p) => (
                          <span key={p.id} title={p.type} style={{
                            display: "inline-flex", alignItems: "center", justifyContent: "center",
                            width: 26, height: 26, borderRadius: 6, background: "var(--al)", border: "1px solid var(--bd)",
                          }}>
                            <PlatformIcon type={p.type} size={14} />
                          </span>
                        ))}
                        {(!c.platforms || c.platforms.length === 0) && <span style={{ color: "var(--t3)", fontSize: 12 }}>--</span>}
                      </div>
                    </td>
                    <td><Badge variant={TYPE_COLORS[c.type] || "blue"}>{c.type}</Badge></td>
                    <td className="max-md:hidden">
                      <span style={{ fontSize: 13, color: "var(--t2)" }}>{c.role || "--"}</span>
                    </td>
                    <td className="max-md:hidden">
                      <span className="font-mono text-xs tabular-nums" style={{ color: "var(--t2)", fontSize: 12 }}>{relativeDate(c.lastContactDate)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="py-12 px-6 text-center text-muted-foreground text-sm">No contacts linked to this company yet.</div>
        )}
      </div>
    </div>
  );
}
