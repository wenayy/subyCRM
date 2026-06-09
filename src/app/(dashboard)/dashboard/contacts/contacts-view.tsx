"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { contactsApi, aiApi, tagsApi } from "@/lib/api";
import type { Contact, ContactType, ContactDomain, Tag } from "@/lib/types";
import { getCached, setCached } from "@/lib/page-cache";
import { PlatformIcon } from "@/components/platform-icon";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";


const TABS: { label: string; value: string }[] = [
  { label: "All", value: "" },
  { label: "VC", value: "vc" },
  { label: "Lead", value: "lead" },
  { label: "Partner", value: "partner" },
  { label: "Friend", value: "friend" },
  { label: "Prospect", value: "prospect" },
  { label: "Team", value: "team" },
  { label: "Advisor", value: "advisor" },
  { label: "Media", value: "media" },
  { label: "Other", value: "other" },
];

const DOMAINS: { label: string; value: string }[] = [
  { label: "All domains", value: "" },
  { label: "Payment", value: "payment" },
  { label: "Blockchain", value: "blockchain" },
  { label: "SaaS", value: "saas" },
  { label: "E-commerce", value: "ecommerce" },
  { label: "AI", value: "ai" },
  { label: "Marketing", value: "marketing" },
  { label: "Legal", value: "legal" },
  { label: "Finance", value: "finance" },
  { label: "Other", value: "other" },
];

const TYPE_COLORS: Record<string, "green" | "yellow" | "blue" | "red" | "purple" | "orange"> = {
  vc: "purple", lead: "blue", partner: "green", friend: "yellow", prospect: "orange",
  team: "blue", advisor: "purple", media: "orange", other: "blue",
};

const DOMAIN_COLORS: Record<string, "green" | "yellow" | "blue" | "red" | "purple" | "orange"> = {
  payment: "green", blockchain: "purple", saas: "blue", ecommerce: "orange",
  ai: "purple", marketing: "yellow", legal: "red", finance: "green", other: "blue",
};

const STRENGTH_STYLES: Record<string, { cls: "green" | "yellow" | "blue" | "red" | "purple" | "orange" }> = {
  cold: { cls: "blue" },
  warm: { cls: "orange" },
  hot: { cls: "red" },
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

export function ContactsView() {
  const router = useRouter();
  const contactsCache = getCached<{ data: Contact[]; total: number }>("contacts:list");
  const [contacts, setContacts] = useState<Contact[]>(contactsCache?.data ?? []);
  const [total, setTotal] = useState(contactsCache?.total ?? 0);
  const [loading, setLoading] = useState(!contactsCache);
  const [tab, setTab] = useState("");
  const [tagFilter, setTagFilter] = useState<{ id: string; name: string } | null>(null);
  const [domain, setDomain] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [classifying, setClassifying] = useState(false);
  const [classifyResult, setClassifyResult] = useState<string | null>(null);
  const limit = 25;

  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // Bulk selection
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [bulkTagId, setBulkTagId] = useState("");
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const [bulkWorking, setBulkWorking] = useState(false);


  // Filter contacts client-side instantly for 0ms UX latency as the user types
  const displayContacts = useMemo(() => {
    let list = contacts;
    if (search.trim()) {
      const terms = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
      list = list.filter((c) =>
        terms.every((term) => {
          const matchesBase = [c.name, c.company, c.role].some((val) => val && val.toLowerCase().includes(term));
          const matchesPlatform = c.platforms?.some((p) =>
            [p.platformId, p.displayName].some((field) => field && field.toLowerCase().includes(term))
          );
          return matchesBase || matchesPlatform;
        })
      );
    }
    return list;
  }, [contacts, search]);

  // Debounce search input to prevent network spam and race conditions
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 200); // 200ms debounce for extremely fast matchup without lag

    return () => {
      clearTimeout(handler);
    };
  }, [search]);

  // Add Contact Form State
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCompany, setNewCompany] = useState("");
  const [newRole, setNewRole] = useState("");
  const [newType, setNewType] = useState<ContactType>("other");
  const [newDomain, setNewDomain] = useState<ContactDomain>("other");
  const [newStrength, setNewStrength] = useState<"cold" | "warm" | "hot">("cold");

  // Platform Handles State
  const [waPhone, setWaPhone] = useState("");
  const [tgUsername, setTgUsername] = useState("");
  const [xHandle, setXHandle] = useState("");
  const [liHandle, setLiHandle] = useState("");
  const [emailAddr, setEmailAddr] = useState("");

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) {
      setSaveError("Name is required");
      return;
    }
    setSaving(true);
    setSaveError("");
    try {
      const platforms = [];
      if (waPhone.trim()) {
        platforms.push({ type: "whatsapp", platformId: waPhone.trim() });
      }
      if (tgUsername.trim()) {
        const handle = tgUsername.trim().startsWith("@") ? tgUsername.trim().slice(1) : tgUsername.trim();
        platforms.push({ type: "telegram", platformId: handle });
      }
      if (xHandle.trim()) {
        const handle = xHandle.trim().startsWith("@") ? xHandle.trim().slice(1) : xHandle.trim();
        platforms.push({ type: "x", platformId: handle });
      }
      if (liHandle.trim()) {
        const handle = liHandle.trim().startsWith("@") ? liHandle.trim().slice(1) : liHandle.trim();
        platforms.push({ type: "linkedin", platformId: handle });
      }
      if (emailAddr.trim()) {
        platforms.push({ type: "email", platformId: emailAddr.trim().toLowerCase() });
      }

      await contactsApi.create({
        name: newName.trim(),
        company: newCompany.trim() || undefined,
        role: newRole.trim() || undefined,
        type: newType,
        domain: newDomain,
        relationshipStrength: newStrength,
        platforms: platforms as any,
      });

      // Reset Form
      setNewName("");
      setNewCompany("");
      setNewRole("");
      setNewType("other");
      setNewDomain("other");
      setNewStrength("cold");
      setWaPhone("");
      setTgUsername("");
      setXHandle("");
      setLiHandle("");
      setEmailAddr("");

      setIsAddOpen(false);
      fetchContacts();

      // Refresh Stats
      contactsApi.getStats()
        .then((s) => setCounts({ "": s.total, ...s.byType }))
        .catch(() => {});
    } catch (err: any) {
      setSaveError(err.message || "Failed to create contact");
    } finally {
      setSaving(false);
    }
  };

  const fetchContacts = useCallback(() => {
    const isDefaultView = !tab && !tagFilter && !domain && !debouncedSearch && page === 1;
    // Only show loading spinner if we have no data to display yet
    if (!getCached("contacts:list") || !isDefaultView) setLoading(true);
    const params: Record<string, string> = { page: String(page), limit: String(limit) };
    if (tab) params.type = tab;
    if (tagFilter) params.tag = tagFilter.name;
    if (domain) params.domain = domain;
    if (debouncedSearch) params.search = debouncedSearch;

    let active = true;

    contactsApi.getAll(params)
      .then((res) => {
        if (!active) return;
        setContacts(res.data || []);
        setTotal(res.total || 0);
        if (isDefaultView) setCached("contacts:list", { data: res.data || [], total: res.total || 0 });
      })
      .catch(() => {
        if (!active) return;
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [tab, tagFilter?.name, domain, debouncedSearch, page]);

  useEffect(() => {
    contactsApi.getStats()
      .then((s) => {
        setCounts({ "": s.total, ...s.byType });
      })
      .catch(() => {});
    tagsApi.getAll()
      .then((t) => setAllTags(t))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const cleanup = fetchContacts();
    return () => {
      if (typeof cleanup === "function") cleanup();
    };
  }, [fetchContacts]);

  const toggleSelect = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === displayContacts.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(displayContacts.map((c) => c.id)));
    }
  };

  const clearSelection = () => setSelected(new Set());

  // Escape key clears selection
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") clearSelection(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const handleBulkDelete = async () => {
    if (!confirm(`Delete ${selected.size} contact${selected.size > 1 ? "s" : ""}? This cannot be undone.`)) return;
    setBulkWorking(true);
    try {
      await contactsApi.bulkDelete(Array.from(selected));
      setContacts((prev) => prev.filter((c) => !selected.has(c.id)));
      setTotal((prev) => prev - selected.size);
      clearSelection();
    } catch {}
    finally { setBulkWorking(false); }
  };

  const handleBulkTag = async () => {
    if (!bulkTagId) return;
    setBulkWorking(true);
    try {
      await contactsApi.bulkTag(Array.from(selected), bulkTagId);
      setBulkTagOpen(false);
      setBulkTagId("");
      clearSelection();
      fetchContacts();
    } catch {}
    finally { setBulkWorking(false); }
  };

  const handleClassifyAll = async () => {
    setClassifying(true);
    setClassifyResult(null);
    try {
      const res = await aiApi.classifyBatch();
      setClassifyResult(`Queued ${res.queued} contacts for classification`);
      setTimeout(() => { fetchContacts(); setClassifyResult(null); }, 4000);
    } catch {
      setClassifyResult("Classification failed. Try again.");
    } finally {
      setClassifying(false);
    }
  };

  const totalPages = Math.ceil(total / limit);

  return (
    <>
      <div className="flex flex-col gap-5 w-full">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-xl font-bold tracking-tight">Contacts</h1>
        <div className="flex gap-2 items-center flex-wrap sm:flex-nowrap w-full sm:w-auto">
          <Input
            placeholder="Search contacts..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full sm:w-[220px] h-9 bg-card text-foreground"
          />
          <select
            value={domain}
            onChange={(e) => { setDomain(e.target.value); setPage(1); }}
            className="h-9 rounded-lg border border-border bg-card text-foreground text-[13px] px-2.5 w-full sm:w-auto"
          >
            {DOMAINS.map((d) => (
              <option key={d.value} value={d.value}>{d.label}</option>
            ))}
          </select>
          <Button size="sm" variant="purple"
            onClick={handleClassifyAll}
            disabled={classifying}
            className="w-full sm:w-auto whitespace-nowrap"
          >
            {classifying && <Spinner />}{classifying ? "Classifying…" : "Classify All (AI)"}
          </Button>
          <Button size="sm" onClick={() => setIsAddOpen(true)} className="w-full sm:w-auto whitespace-nowrap">
            + Add Contact
          </Button>
        </div>
      </div>

      {classifyResult && (
        <div className="p-2.5 px-3.5 bg-status-green-bg text-status-green rounded-lg text-[13px] font-semibold">
          {classifyResult}
        </div>
      )}

      {!loading && contacts.length === 0 && !tab && !domain && !debouncedSearch && (
        <div className="p-4 px-5 rounded-xl border border-yellow-300 bg-yellow-50 text-yellow-900 text-[13px] flex items-start gap-3">
          <span className="text-lg leading-none mt-0.5">★</span>
          <div>
            <p className="font-semibold mb-1">Your contacts list is empty.</p>
            <p className="text-yellow-800">Import contacts or add them manually to get started.</p>
            <div className="flex gap-2 mt-2">
              <Button size="sm" onClick={() => setIsAddOpen(true)}>+ Add Contact</Button>
              <Button size="sm" variant="outline" onClick={() => router.push("/dashboard/settings")}>Import from Platform</Button>
            </div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <Tabs value={tab} onValueChange={(v) => { setTab(v); setPage(1); }}>
        <TabsList>
          {TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}{counts[t.value] !== undefined ? ` (${counts[t.value]})` : ""}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* Tag filter chips */}
      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 items-center">
          <span className="text-[11px] font-medium text-muted-foreground">Tags:</span>
          {allTags.map((tag) => {
            const active = tagFilter?.id === tag.id;
            return (
              <button
                key={tag.id}
                onClick={() => { setTagFilter(active ? null : tag); setPage(1); }}
                className={cn(
                  "px-2.5 py-0.5 rounded-full text-[11px] font-semibold border transition-colors",
                  active
                    ? "bg-foreground text-background border-foreground"
                    : "bg-transparent text-muted-foreground border-border hover:border-foreground hover:text-foreground"
                )}
              >
                {tag.name}
              </button>
            );
          })}
        </div>
      )}

      {/* Table */}
      <div className="rounded-xl border border-border bg-card shadow-sm overflow-auto w-full relative">
        {loading && (
          <div className="absolute top-0 left-0 right-0 h-[2px] bg-purple-500 overflow-hidden z-10">
            <div className="h-full bg-purple-300 animate-pulse w-full" />
          </div>
        )}
        <table>
          <thead>
            <tr>
              <th style={{ width: 40, paddingLeft: 14, paddingRight: 6 }}>
                <input
                  type="checkbox"
                  checked={displayContacts.length > 0 && selected.size === displayContacts.length}
                  ref={(el) => { if (el) el.indeterminate = selected.size > 0 && selected.size < displayContacts.length; }}
                  onChange={toggleSelectAll}
                  style={{ width: 14, height: 14, accentColor: "var(--ac)", cursor: "pointer" }}
                  title="Select all"
                />
              </th>
              <th>Name</th>
              <th className="max-md:hidden">Platforms</th>
              <th>Type</th>
              <th className="max-md:hidden">Domain</th>
              <th className="max-md:hidden">Last contact</th>
              <th className="max-md:hidden">Freq</th>
              <th>Strength</th>
            </tr>
          </thead>
          <tbody className={cn("transition-opacity duration-200", loading && "opacity-60")}>
            {displayContacts.length === 0 && loading ? (
              <tr>
                <td colSpan={8} className="p-6">
                  <div className="flex flex-col gap-2">
                    {Array.from({ length: 6 }).map((_, i) => (
                      <div key={i} className="flex items-center gap-3 px-2">
                        <div className="size-8 rounded-full bg-muted/60 animate-pulse shrink-0" />
                        <div className="flex-1 space-y-1.5">
                          <div className="h-3 bg-muted/60 animate-pulse rounded w-36" />
                          <div className="h-2.5 bg-muted/60 animate-pulse rounded w-52" />
                        </div>
                        <div className="h-5 w-14 bg-muted/60 animate-pulse rounded-full" />
                      </div>
                    ))}
                  </div>
                </td>
              </tr>
            ) : displayContacts.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-12 px-6 text-center text-muted-foreground text-sm">
                  No contacts found
                </td>
              </tr>
            ) : (
              displayContacts.map((c) => {
                const isSelected = selected.has(c.id);
                return (
                  <tr
                    key={c.id}
                    className="cursor-pointer"
                    style={isSelected ? { background: "var(--bb)" } : undefined}
                    onClick={() => router.push(`/dashboard/contacts/${c.id}`)}
                  >
                    <td style={{ width: 40, paddingLeft: 14, paddingRight: 6 }} onClick={(e) => toggleSelect(c.id, e)}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => {}}
                        style={{ width: 14, height: 14, accentColor: "var(--ac)", cursor: "pointer", pointerEvents: "none" }}
                      />
                    </td>
                    <td>
                      <div className="font-medium text-foreground">{c.name}</div>
                      {(c.company || c.role) && (
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {[c.role, c.company].filter(Boolean).join(" @ ")}
                        </div>
                      )}
                    </td>
                    <td className="max-md:hidden">
                      <div className="flex gap-1">
                        {c.platforms?.map((p, i) => (
                          <span key={p.id ?? `${p.type}-${i}`} title={`${p.type}${p.displayName ? `: ${p.displayName}` : ""}`} className="inline-flex items-center justify-center size-6.5 rounded bg-muted border border-border">
                            <PlatformIcon type={p.type} size={14} />
                          </span>
                        ))}
                        {(!c.platforms || c.platforms.length === 0) && <span className="text-muted-foreground text-xs">--</span>}
                      </div>
                    </td>
                    <td><Badge variant={TYPE_COLORS[c.type] || "blue"}>{c.type}</Badge></td>
                    <td className="max-md:hidden"><Badge variant={DOMAIN_COLORS[c.domain] || "blue"}>{c.domain}</Badge></td>
                    <td className="max-md:hidden">
                      <span className="font-mono text-xs text-muted-foreground tabular-nums">{relativeDate(c.lastContactDate)}</span>
                    </td>
                    <td className="max-md:hidden">
                      {c.contactFrequency != null && c.contactFrequency > 0 ? (
                        <span className="font-mono text-xs text-muted-foreground tabular-nums">{c.contactFrequency}</span>
                      ) : (
                        <span className="text-muted-foreground text-xs">--</span>
                      )}
                    </td>
                    <td><Badge variant={STRENGTH_STYLES[c.relationshipStrength]?.cls || "blue"}>{c.relationshipStrength}</Badge></td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Bulk action bar — rendered via portal to escape any CSS transform containing block */}
      {mounted && createPortal(<div
        style={{
          position: "fixed",
          bottom: selected.size > 0 ? 28 : -80,
          left: "50%",
          transform: "translateX(-50%)",
          transition: "bottom 0.22s cubic-bezier(0.34,1.56,0.64,1), opacity 0.15s ease",
          opacity: selected.size > 0 ? 1 : 0,
          pointerEvents: selected.size > 0 ? "auto" : "none",
          zIndex: 50,
          display: "flex",
          alignItems: "center",
          gap: 10,
          background: "var(--t1)",
          color: "var(--ac-fg)",
          borderRadius: 14,
          padding: "10px 16px",
          boxShadow: "0 8px 32px rgba(0,0,0,0.22), 0 2px 8px rgba(0,0,0,0.12)",
          whiteSpace: "nowrap",
          minWidth: 320,
        }}
      >
        {/* Count badge */}
        <div style={{ display: "flex", alignItems: "center", gap: 7, flex: 1 }}>
          <span style={{
            background: "var(--ac-fg)", color: "var(--t1)",
            borderRadius: 20, padding: "1px 9px", fontSize: 12, fontWeight: 700,
          }}>
            {selected.size}
          </span>
          <span style={{ fontSize: 13, fontWeight: 500, opacity: 0.85 }}>
            contact{selected.size !== 1 ? "s" : ""} selected
          </span>
        </div>

        {/* Tag button */}
        <button
          onClick={() => setBulkTagOpen(true)}
          disabled={bulkWorking}
          style={{
            display: "flex", alignItems: "center", gap: 5,
            background: "rgba(255,255,255,0.13)", border: "1px solid rgba(255,255,255,0.18)",
            borderRadius: 8, padding: "5px 13px", fontSize: 12, fontWeight: 600,
            color: "inherit", cursor: "pointer", transition: "background 0.15s",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.22)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.13)")}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
          Add tag
        </button>

        {/* Delete button */}
        <button
          onClick={handleBulkDelete}
          disabled={bulkWorking}
          style={{
            display: "flex", alignItems: "center", gap: 5,
            background: "rgba(220,38,38,0.22)", border: "1px solid rgba(220,38,38,0.35)",
            borderRadius: 8, padding: "5px 13px", fontSize: 12, fontWeight: 600,
            color: "#fca5a5", cursor: "pointer", transition: "background 0.15s",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(220,38,38,0.35)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(220,38,38,0.22)")}
        >
          {bulkWorking ? <Spinner /> : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
          )}
          Delete
        </button>

        {/* Divider + clear */}
        <div style={{ width: 1, height: 20, background: "rgba(255,255,255,0.15)" }} />
        <button
          onClick={clearSelection}
          style={{
            background: "transparent", border: "none", color: "rgba(255,255,255,0.6)",
            cursor: "pointer", padding: "4px 6px", borderRadius: 6, fontSize: 16, lineHeight: 1,
            transition: "color 0.15s",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "rgba(255,255,255,1)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "rgba(255,255,255,0.6)")}
          title="Clear selection"
        >
          ✕
        </button>
      </div>, document.body)}

      {/* Bulk tag dialog */}
      <Dialog open={bulkTagOpen} onOpenChange={setBulkTagOpen}>
        <DialogContent className="sm:max-w-[360px]">
          <DialogHeader>
            <DialogTitle>Add tag to {selected.size} contact{selected.size !== 1 ? "s" : ""}</DialogTitle>
            <DialogDescription>The tag will be added to all selected contacts. Contacts that already have this tag will be skipped.</DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Label htmlFor="bulk-tag-select" className="mb-1.5 block">Choose a tag</Label>
            <select
              id="bulk-tag-select"
              value={bulkTagId}
              onChange={(e) => setBulkTagId(e.target.value)}
              className="w-full h-9 rounded-lg border border-border bg-card text-foreground text-[13px] px-2.5"
            >
              <option value="">Select a tag...</option>
              {allTags.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkTagOpen(false)} disabled={bulkWorking}>Cancel</Button>
            <Button onClick={handleBulkTag} disabled={!bulkTagId || bulkWorking}>
              {bulkWorking ? <><Spinner /> Tagging…</> : `Add tag`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
          <span className="text-[13px] text-muted-foreground">Page {page} of {totalPages} ({total} contacts)</span>
          <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Next</Button>
        </div>
      )}
    </div>

    {/* Add Contact Dialog */}
    <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
      <DialogContent className="sm:max-w-[550px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add New Contact</DialogTitle>
          <DialogDescription>
            Create a new contact and link their messaging handles so their messages are recognized.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleAddSubmit} className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <Label htmlFor="name">Full Name *</Label>
              <Input
                id="name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Patrick Collison"
                required
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="company">Company</Label>
              <Input
                id="company"
                value={newCompany}
                onChange={(e) => setNewCompany(e.target.value)}
                placeholder="e.g. Stripe"
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="role">Role</Label>
              <Input
                id="role"
                value={newRole}
                onChange={(e) => setNewRole(e.target.value)}
                placeholder="e.g. CEO"
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="type">Relationship Type</Label>
              <select
                id="type"
                value={newType}
                onChange={(e) => setNewType(e.target.value as ContactType)}
                className="mt-1 flex h-10 w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-950 outline-none"
              >
                <option value="vc">VC</option>
                <option value="lead">Lead</option>
                <option value="partner">Partner</option>
                <option value="friend">Friend</option>
                <option value="prospect">Prospect</option>
                <option value="advisor">Advisor</option>
                <option value="team">Team</option>
                <option value="media">Media</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <Label htmlFor="domain">Domain Focus</Label>
              <select
                id="domain"
                value={newDomain}
                onChange={(e) => setNewDomain(e.target.value as ContactDomain)}
                className="mt-1 flex h-10 w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-950 outline-none"
              >
                <option value="payment">Payment</option>
                <option value="blockchain">Blockchain</option>
                <option value="saas">SaaS</option>
                <option value="ecommerce">E-commerce</option>
                <option value="ai">AI</option>
                <option value="marketing">Marketing</option>
                <option value="legal">Legal</option>
                <option value="finance">Finance</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div className="col-span-2">
              <Label htmlFor="strength">Relationship Strength</Label>
              <select
                id="strength"
                value={newStrength}
                onChange={(e) => setNewStrength(e.target.value as any)}
                className="mt-1 flex h-10 w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-950 outline-none"
              >
                <option value="cold">🧊 Cold (Needs re-engagement)</option>
                <option value="warm">☀️ Warm (Active exchange)</option>
                <option value="hot">🔥 Hot (High priority / Close partner)</option>
              </select>
            </div>
          </div>

          <div className="border-t border-border pt-4">
            <h3 className="text-sm font-semibold text-foreground mb-3">Messaging Handles (Privacy Filter Mapping)</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="whatsapp">WhatsApp (Phone number)</Label>
                <Input
                  id="whatsapp"
                  value={waPhone}
                  onChange={(e) => setWaPhone(e.target.value)}
                  placeholder="e.g. 19898818412759"
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="telegram">Telegram (Username)</Label>
                <Input
                  id="telegram"
                  value={tgUsername}
                  onChange={(e) => setTgUsername(e.target.value)}
                  placeholder="e.g. karrisaarinen"
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="x-handle">X / Twitter Handle</Label>
                <Input
                  id="x-handle"
                  value={xHandle}
                  onChange={(e) => setXHandle(e.target.value)}
                  placeholder="e.g. patrickc"
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="linkedin">LinkedIn Username</Label>
                <Input
                  id="linkedin"
                  value={liHandle}
                  onChange={(e) => setLiHandle(e.target.value)}
                  placeholder="e.g. patrickcollison"
                  className="mt-1"
                />
              </div>
              <div className="col-span-2">
                <Label htmlFor="email">Email Address</Label>
                <Input
                  id="email"
                  type="email"
                  value={emailAddr}
                  onChange={(e) => setEmailAddr(e.target.value)}
                  placeholder="e.g. patrick@stripe.com"
                  className="mt-1"
                />
              </div>
            </div>
          </div>

          {saveError && (
            <p className="text-xs text-red-500 font-medium mt-2">{saveError}</p>
          )}

          <DialogFooter className="pt-4 gap-2">
            <Button type="button" variant="outline" onClick={() => setIsAddOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving..." : "Add Contact"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    </>
  );
}
