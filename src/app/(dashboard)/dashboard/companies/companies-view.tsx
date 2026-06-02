"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { companiesApi } from "@/lib/api";
import { MOCK_COMPANIES } from "@/lib/mock-companies";
import type { Company, Contact } from "@/lib/types";
import { buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const CATEGORIES = ["all", "payment", "crypto", "vc", "partner"] as const;
type CategoryFilter = (typeof CATEGORIES)[number];

const CATEGORY_LABELS: Record<CategoryFilter, string> = {
  all: "All",
  payment: "Payment",
  crypto: "Crypto",
  vc: "VC",
  partner: "Partner",
};

const TYPE_COLORS: Record<string, "green" | "yellow" | "blue" | "red" | "purple" | "orange"> = {
  vc: "purple", lead: "blue", partner: "green", friend: "yellow", prospect: "orange",
  team: "blue", advisor: "purple", media: "orange", other: "blue",
};

function favicon(domain: string | null): string | null {
  if (!domain) return null;
  const clean = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return `https://www.google.com/s2/favicons?sz=64&domain=${clean}`;
}

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || "").join("");
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

export function CompaniesView() {
  const router = useRouter();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedFull, setSelectedFull] = useState<Company | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");

  useEffect(() => {
    companiesApi.getAll()
      .then((data) => setCompanies(data?.length ? data : MOCK_COMPANIES))
      .catch(() => setCompanies(MOCK_COMPANIES))
      .finally(() => setLoading(false));
  }, []);

  // Fetch full company (with contacts) whenever selection changes
  useEffect(() => {
    if (!selectedId) { setSelectedFull(null); return; }
    setDetailLoading(true);
    companiesApi.getById(selectedId)
      .then(setSelectedFull)
      .catch(() => {
        const mock = MOCK_COMPANIES.find((m) => m.id === selectedId);
        setSelectedFull(mock ?? null);
      })
      .finally(() => setDetailLoading(false));
  }, [selectedId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return companies.filter((c) => {
      if (categoryFilter !== "all" && c.sector !== categoryFilter) return false;
      if (!q) return true;
      const haystack = [
        c.name, c.sector, c.size, c.funding,
        c.description, c.website, c.linkedin, c.domain,
      ].filter(Boolean).join(" ").toLowerCase();
      return q.split(/\s+/).every((token) => haystack.includes(token));
    });
  }, [companies, query, categoryFilter]);

  useEffect(() => {
    if (!selectedId && filtered.length > 0) setSelectedId(filtered[0].id);
    if (selectedId && !filtered.find((c) => c.id === selectedId) && filtered.length > 0) {
      setSelectedId(filtered[0].id);
    }
  }, [filtered, selectedId]);

  const selected = companies.find((c) => c.id === selectedId) || null; // list-level object (no contacts)

  if (loading) {
    return (
      <div className="flex items-center justify-center p-20">
        <span className="inline-block size-5 border-2 border-current border-t-transparent rounded-full animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 h-[calc(100vh-100px)] w-full">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Companies</h1>
          <p className="text-muted-foreground text-[13px] mt-1">
            {filtered.length} of {companies.length} compan{companies.length === 1 ? "y" : "ies"}
          </p>
        </div>
      </div>

      <div className="grid gap-4 flex-1 min-h-0 [grid-template-columns:320px_1fr] max-[900px]:[grid-template-columns:1fr]">
        {/* Left pane: list */}
        <div className="rounded-xl border border-border bg-card shadow-sm flex flex-col overflow-hidden p-0">
          <div className="p-3 border-b border-border flex flex-col gap-2.5">
            <input
              placeholder="Search name, sector, funding..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="overflow-x-auto [scrollbar-width:none] -mx-px">
              <div className="flex gap-0.5 bg-muted rounded-lg p-1 w-max min-w-[calc(100%+2px)]">
                {CATEGORIES.map((s) => {
                  const count = s === "all"
                    ? companies.length
                    : companies.filter((c) => c.sector === s).length;
                  const isActive = s === categoryFilter;
                  return (
                    <button
                      key={s}
                      onClick={() => setCategoryFilter(s)}
                      className={cn(
                        "flex-1 min-w-max border-0 rounded-md p-1 px-2.5 text-xs inline-flex items-center gap-1 transition-all cursor-pointer",
                        isActive
                          ? "bg-card font-semibold text-foreground shadow-sm"
                          : "bg-transparent font-normal text-muted-foreground"
                      )}
                    >
                      {CATEGORY_LABELS[s]}
                      <span className="text-[10px] opacity-60 tabular-nums">{count}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="overflow-y-auto flex-1">
            {filtered.length === 0 ? (
              <div className="py-8 px-4 text-center text-muted-foreground text-sm">No companies match.</div>
            ) : (
              filtered.map((c) => {
                const isActive = c.id === selectedId;
                const icon = favicon(c.domain || c.website);
                return (
                  <button
                    key={c.id}
                    onClick={() => setSelectedId(c.id)}
                    className={cn(
                      "w-full flex items-center gap-2.5 p-2.5 px-3.5 border-0 border-b border-border cursor-pointer text-left transition-colors hover:bg-secondary",
                      isActive ? "bg-accent border-l-2 border-primary" : "bg-transparent border-l-2 border-transparent"
                    )}
                  >
                    <div className="size-7 rounded bg-muted border border-border flex items-center justify-center overflow-hidden shrink-0">
                      {icon ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={icon} alt="" width={20} height={20} className="rounded" />
                      ) : (
                        <span className="text-xs font-semibold text-muted-foreground">{initials(c.name)}</span>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium text-foreground truncate">
                        {c.name}
                      </div>
                      <div className="text-xs text-muted-foreground truncate mt-0.5">
                        {[c.sector, c.size].filter(Boolean).join(" · ") || "·"}
                      </div>
                    </div>
                    <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                      {c.contactCount ?? 0}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Right pane: detail */}
        <div className="rounded-xl border border-border bg-card shadow-sm overflow-y-auto px-7 py-6">
          {detailLoading ? (
            <div className="flex items-center justify-center py-20">
              <span className="inline-block size-5 rounded-full border-2 border-current border-t-transparent animate-spin text-muted-foreground" />
            </div>
          ) : selectedFull ? (
            <CompanyDetailPanel company={selectedFull} onOpenContact={(id) => router.push(`/dashboard/contacts/${id}`)} />
          ) : selected ? (
            <CompanyDetailPanel company={selected} onOpenContact={(id) => router.push(`/dashboard/contacts/${id}`)} />
          ) : (
            <div className="py-12 px-6 text-center text-muted-foreground text-sm">Select a company on the left.</div>
          )}
        </div>
      </div>

    </div>
  );
}

function CompanyDetailPanel({ company, onOpenContact }: { company: Company; onOpenContact: (id: string) => void }) {
  const icon = favicon(company.domain || company.website);
  const contacts = company.contacts || [];

  return (
    <div className="flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-center gap-3.5">
        <div className="size-14 rounded-xl bg-muted border border-border flex items-center justify-center overflow-hidden shrink-0">
          {icon ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={icon} alt="" width={36} height={36} className="rounded-md" />
          ) : (
            <span className="text-lg font-bold text-muted-foreground">{initials(company.name)}</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-bold tracking-tight text-foreground">
            {company.name}
          </h2>
          <div className="flex gap-1.5 mt-1.5 flex-wrap">
            {company.sector && <Badge variant="purple">{company.sector}</Badge>}
            {company.size && <Badge variant="green">{company.size}</Badge>}
            {company.funding && <Badge variant="orange">{company.funding}</Badge>}
          </div>
        </div>
      </div>

      {company.description && (
        <p className="text-sm text-muted-foreground leading-relaxed">{company.description}</p>
      )}

      {/* Links */}
      {(company.website || company.linkedin) && (
        <div className="flex gap-2.5 flex-wrap">
          {company.website && (
            <a
              href={company.website.startsWith("http") ? company.website : `https://${company.website}`}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ size: "sm", variant: "outline" })}
            >
              Website ↗
            </a>
          )}
          {company.linkedin && (
            <a
              href={company.linkedin.startsWith("http") ? company.linkedin : `https://${company.linkedin}`}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ size: "sm", variant: "outline" })}
            >
              LinkedIn ↗
            </a>
          )}
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2.5">
        <div className="rounded-xl border border-border bg-card shadow-sm p-4">
          <div className="text-xs font-medium text-muted-foreground mb-1">Contacts</div>
          <div className="text-[22px] font-bold tabular-nums tracking-tight">{contacts.length || (company.contactCount ?? 0)}</div>
        </div>
        <div className="rounded-xl border border-border bg-card shadow-sm p-4">
          <div className="text-xs font-medium text-muted-foreground mb-1">Hot</div>
          <div className="text-[22px] font-bold tabular-nums tracking-tight">{contacts.filter((c) => c.relationshipStrength === "hot").length}</div>
        </div>
        <div className="rounded-xl border border-border bg-card shadow-sm p-4">
          <div className="text-xs font-medium text-muted-foreground mb-1">Warm</div>
          <div className="text-[22px] font-bold tabular-nums tracking-tight">{contacts.filter((c) => c.relationshipStrength === "warm").length}</div>
        </div>
      </div>

      {/* Contacts */}
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground mb-2.5">
          Contacts ({contacts.length})
        </div>
        {contacts.length === 0 ? (
          <div className="py-6 px-4 text-center text-muted-foreground text-[13px]">No contacts linked yet.</div>
        ) : (
          <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
            {contacts.map((c: Contact, idx) => (
              <button
                key={c.id}
                onClick={() => onOpenContact(c.id)}
                className={cn(
                  "w-full flex items-center gap-3 p-3 px-4 border-0 bg-transparent cursor-pointer text-left transition-colors hover:bg-muted",
                  idx < contacts.length - 1 && "border-b border-border"
                )}
              >
                <div className="size-8 rounded-full bg-muted text-muted-foreground flex items-center justify-center text-xs font-semibold shrink-0">
                  {initials(c.name)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium text-foreground">{c.name}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{c.role || "·"}</div>
                </div>
                <Badge variant={TYPE_COLORS[c.type] || "blue"}>{c.type}</Badge>
                <span className="font-mono text-[11px] text-muted-foreground text-right min-w-[64px] tabular-nums">
                  {relativeDate(c.lastContactDate)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
