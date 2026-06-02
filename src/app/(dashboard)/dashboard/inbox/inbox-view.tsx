"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { inboxApi, meApi, type InboxConversationApi, type InboxMessageApi } from "@/lib/api";
import { PlatformIcon } from "@/components/platform-icon";
import { Star } from "lucide-react";
import type { PlatformType } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { getCached, setCached } from "@/lib/page-cache";

// Sent messages only in local state (not persisted)
interface SentMessage { id: string; body: string; sentAt: string; fromMe: true; status?: "sending" | "sent" | "failed" }

type Filter = "all" | "unread" | "needs_reply" | "starred";

function fmtAgo(iso: string): string {
  const m = (Date.now() - new Date(iso).getTime()) / 60000;
  if (m < 1) return "now";
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h`;
  if (m < 60 * 24 * 7) return `${Math.round(m / 60 / 24)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function initials(name: string | null): string {
  if (!name) return "?";
  return name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || "").join("");
}

function renderMessageBody(text: string, onImageClick?: (url: string) => void) {
  if (!text) return "";
  const regex = /(!\[[^\]]*\]\([^)]+\)|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s]+)/g;
  const parts = text.split(regex);
  return parts.map((part, i) => {
    if (part.startsWith("![")) {
      const match = part.match(/!\[([^\]]*)\]\(([^)]+)\)/);
      if (match) {
        const [, alt, url] = match;
        const isVideo = /\.(mp4|mov|avi|mkv|3gp|webm)(\?|$)/i.test(url);
        if (isVideo) {
          return (
            <video
              key={i}
              src={url}
              controls
              style={{ maxWidth: "100%", maxHeight: 220, borderRadius: 8, marginTop: 6, display: "block" }}
            />
          );
        }
        return (
          <img
            key={i}
            src={url}
            alt={alt || "Image"}
            onClick={() => onImageClick?.(url)}
            style={{ maxWidth: "100%", maxHeight: 220, borderRadius: 8, marginTop: 6, display: "block", objectFit: "contain",
              cursor: onImageClick ? "zoom-in" : undefined }}
          />
        );
      }
    } else if (part.startsWith("[")) {
      const match = part.match(/\[([^\]]+)\]\(([^)]+)\)/);
      if (match) {
        const [, label, url] = match;
        return (
          <a
            key={i}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#3b82f6", textDecoration: "underline", wordBreak: "break-all" }}
          >
            {label}
          </a>
        );
      }
    } else if (part.startsWith("http://") || part.startsWith("https://")) {
      return (
        <a
          key={i}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "#3b82f6", textDecoration: "underline", wordBreak: "break-all" }}
        >
          {part}
        </a>
      );
    }
    return <span key={i} style={{ whiteSpace: "pre-wrap" }}>{part}</span>;
  });
}

export function InboxView() {
  const router = useRouter();
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastScrolledKeyRef = useRef<string | null>(null);
  const threadLoadingRef = useRef(false);

  const cached = getCached<InboxConversationApi[]>("inbox:conversations");
  const [conversations, setConversations] = useState<InboxConversationApi[]>(cached ?? []);
  const [thread, setThread] = useState<InboxMessageApi[]>([]);
  const [sentMessages, setSentMessages] = useState<Record<string, SentMessage[]>>({});
  const [selected, setSelected] = useState<InboxConversationApi | null>(null);
  const [loading, setLoading] = useState(!cached);
  const [threadLoading, setThreadLoading] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [reply, setReply] = useState("");
  const [sendError, setSendError] = useState("");
  const [me, setMe] = useState<{ name: string | null; email: string | null }>({ name: null, email: null });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [hoveredMsgId, setHoveredMsgId] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<InboxMessageApi | null>(null);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selected) return;

    setUploading(true);
    setSendError("");
    const reader = new FileReader();

    reader.onload = async (event) => {
      const fileData = event.target?.result as string;
      if (!fileData) {
        setSendError("Failed to read file");
        setUploading(false);
        return;
      }

      try {
        const res = await inboxApi.upload(file.name, fileData);
        const isImage = file.type.startsWith("image/");
        const markdownTag = isImage
          ? `![${file.name}](${res.url})`
          : `[${file.name}](${res.url})`;
        
        setReply((prev) => (prev ? `${prev} ${markdownTag}` : markdownTag));
      } catch (err: any) {
        setSendError(err.message || "Failed to upload attachment");
      } finally {
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    };

    reader.onerror = () => {
      setSendError("Failed to read file");
      setUploading(false);
    };

    reader.readAsDataURL(file);
  };

  useEffect(() => {
    meApi.get().then((u) => setMe(u)).catch(() => {});
  }, []);

  const [sessionExpired, setSessionExpired] = useState(false);

  // Stable ref so SSE handler can access latest selected without re-subscribing
  const selectedRef = useRef<InboxConversationApi | null>(null);
  selectedRef.current = selected;

  const fetchConvsRef = useRef<(() => Promise<unknown>) | null>(null);

  useEffect(() => {
    const cached = getCached<InboxConversationApi[]>("inbox:conversations");

    const fetchConvs = async () => {
      try {
        const convs = await inboxApi.getConversations();
        setCached("inbox:conversations", convs);
        setConversations(convs);
        return convs;
      } catch (err: any) {
        const msg = err?.message ?? "";
        if (msg.includes("session") || msg.includes("Unauthorized") || msg.includes("401")) {
          setSessionExpired(true);
        }
        return undefined;
      } finally {
        setLoading(false);
      }
    };
    fetchConvsRef.current = fetchConvs;

    fetchConvs().then((convs) => {
      if (convs && !cached && convs.length > 0) {
        selectConversation(convs[0]);
      }
    });

    // SSE for real-time push — conversations + active thread refresh on new messages
    const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4002";
    const es = new EventSource(`${API_BASE}/api/inbox/events`, { withCredentials: true });

    es.addEventListener("new_message", () => {
      fetchConvsRef.current?.();
      if (selectedRef.current) {
        inboxApi.getThread(selectedRef.current.contactId, selectedRef.current.platform)
          .then(setThread)
          .catch(() => {});
      }
    });

    es.addEventListener("message_deleted", () => {
      fetchConvsRef.current?.();
      if (selectedRef.current) {
        inboxApi.getThread(selectedRef.current.contactId, selectedRef.current.platform)
          .then(setThread)
          .catch(() => {});
      }
    });

    es.addEventListener("conversations_changed", () => {
      fetchConvsRef.current?.();
    });

    es.addEventListener("send_failed", (e) => {
      try {
        const data = JSON.parse((e as any).data || "{}");
        if (selectedRef.current?.contactId === data.contactId) {
          setSendError("Message failed to deliver — please try again");
        }
      } catch {}
    });

    es.onerror = () => {
      // SSE disconnected — fall back to polling every 10s until it reconnects
    };

    // Fallback polling every 10s (SSE already handles real-time; this is just a safety net)
    const iv = setInterval(fetchConvs, 10_000);

    return () => {
      es.close();
      clearInterval(iv);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    if (!selected) return;

    const isNewConversation = lastScrolledKeyRef.current !== selected.key;
    const loading = threadLoadingRef.current;

    if (isNewConversation || loading) {
      bottomRef.current?.scrollIntoView({ behavior: "auto" });
      if (!loading) {
        lastScrolledKeyRef.current = selected.key;
      }
    } else {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [thread.length, thread[thread.length - 1]?.id, selected]);

  // Keep thread fresh when switching conversations (SSE handles live updates above)
  useEffect(() => {
    if (!selected) return;
    const iv = setInterval(() => {
      inboxApi.getThread(selected.contactId, selected.platform)
        .then(setThread)
        .catch(() => {});
    }, 10_000);
    return () => clearInterval(iv);
  }, [selected]);

  // Clean up optimistic messages when they are fetched from backend and appear in the thread
  useEffect(() => {
    if (!selected) return;
    const local = sentMessages[selected.key];
    if (!local || local.length === 0) return;

    const filtered = local.filter((m) => 
      !thread.some((dbMsg) => dbMsg.fromMe && dbMsg.body === m.body)
    );

    if (filtered.length !== local.length) {
      setSentMessages((prev) => ({
        ...prev,
        [selected.key]: filtered,
      }));
    }
  }, [thread, selected, sentMessages]);

  const selectConversation = (conv: InboxConversationApi) => {
    setSelected(conv);
    setReply("");
    setSendError("");
    setReplyingTo(null);
    
    // Clear & pre-populate thread with the latest message instantly
    setThread([conv.latestMessage]);
    threadLoadingRef.current = true;
    setThreadLoading(true);

    inboxApi.getThread(conv.contactId, conv.platform)
      .then((res) => {
        if (selectedRef.current?.key === conv.key) {
          setThread(res);
        }
      })
      .catch(() => {
        if (selectedRef.current?.key === conv.key) {
          setThread([conv.latestMessage]);
        }
      })
      .finally(() => {
        if (selectedRef.current?.key === conv.key) {
          threadLoadingRef.current = false;
          setThreadLoading(false);
        }
      });

    // Mark all messages in this conversation as read
    inboxApi.markConversationRead(conv.contactId, conv.platform).catch(() => {});
    setConversations((prev) => prev.map((c) =>
      c.key === conv.key ? { ...c, unreadCount: 0, latestMessage: { ...c.latestMessage, read: true } } : c
    ));
  };

  const filtered = conversations.filter((c) => {
    if (filter === "unread") return c.unreadCount > 0;
    if (filter === "needs_reply") return c.needsReply;
    if (filter === "starred") return c.starred;
    return true;
  });

  const totalUnread = conversations.reduce((s, c) => s + c.unreadCount, 0);
  const totalNeedsReply = conversations.filter((c) => c.needsReply).length;
  const totalStarred = conversations.filter((c) => c.starred).length;

  const handleSend = async () => {
    if (!reply.trim() || !selected) return;

    const lastMsg = thread[thread.length - 1] ?? selected.latestMessage;
    const body = reply.trim();
    const tempId = `sent-${Date.now()}`;
    const replyToId = replyingTo?.id;

    // Optimistic UI update — show message instantly
    const outgoing: SentMessage = {
      id: tempId,
      body,
      sentAt: new Date().toISOString(),
      fromMe: true,
      status: "sending"
    };
    setSentMessages((prev) => ({ ...prev, [selected.key]: [...(prev[selected.key] ?? []), outgoing] }));
    setReply("");
    setReplyingTo(null);
    setSendError("");

    try {
      await inboxApi.reply(lastMsg.id, body, replyToId);
      setSentMessages((prev) => {
        const list = prev[selected.key] ?? [];
        return {
          ...prev,
          [selected.key]: list.map((m) => m.id === tempId ? { ...m, status: "sent" } : m),
        };
      });
      setConversations((prev) => prev.map((c) => c.key === selected.key ? { ...c, needsReply: false } : c));
    } catch (e: unknown) {
      setSentMessages((prev) => {
        const list = prev[selected.key] ?? [];
        return {
          ...prev,
          [selected.key]: list.map((m) => m.id === tempId ? { ...m, status: "failed" } : m),
        };
      });
      setSendError(e instanceof Error ? e.message : "Failed to send");
    }
  };

  const handleDeleteMsg = async (msgId: string) => {
    await inboxApi.delete(msgId).catch(() => {});
    setThread((prev) => prev.filter((m) => m.id !== msgId));
    setSentMessages((prev) => {
      if (!selected) return prev;
      return { ...prev, [selected.key]: (prev[selected.key] ?? []).filter((m) => m.id !== msgId) };
    });
  };

  const PLATFORM_LABEL: Record<string, string> = {
    telegram: "Telegram", email: "Email", x: "X", linkedin: "LinkedIn",
    discord: "Discord", slack: "Slack", whatsapp: "WhatsApp",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, height: "calc(100vh - 80px)" }}>
      {/* Lightbox */}
      {lightboxUrl && (
        <div onClick={() => setLightboxUrl(null)}
          style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.88)",
            display: "flex", alignItems: "center", justifyContent: "center", cursor: "zoom-out" }}>
          <img src={lightboxUrl} alt="Full size"
            style={{ maxWidth: "92vw", maxHeight: "92vh", borderRadius: 10, objectFit: "contain", boxShadow: "0 8px 40px rgba(0,0,0,0.5)" }} />
          <button onClick={() => setLightboxUrl(null)}
            style={{ position: "absolute", top: 16, right: 16, background: "rgba(255,255,255,0.15)",
              border: "none", color: "#fff", fontSize: 20, width: 36, height: 36, borderRadius: "50%",
              cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
        </div>
      )}
      {/* Session expired banner */}
      {sessionExpired && (
        <div style={{ padding: "12px 16px", background: "var(--rb)", border: "1px solid var(--rc)", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <span style={{ fontSize: 13, color: "var(--rc)", fontWeight: 500 }}>
            Your session has expired. Please log out and log back in.
          </span>
          <button
            onClick={() => { window.location.href = "/api/auth/sign-out"; }}
            style={{ padding: "5px 14px", background: "var(--rc)", color: "#fff", border: "none", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer" }}
          >
            Log out
          </button>
        </div>
      )}
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 className="text-xl font-bold tracking-tight">Inbox</h1>
          <p style={{ color: "var(--t2)", fontSize: 13, marginTop: 4 }}>
            {loading ? "Loading…" : `${totalUnread} unread · ${totalNeedsReply} need reply`}
          </p>
        </div>
        <div style={{ display: "flex", gap: 4, background: "var(--muted)", borderRadius: 8, padding: 3 }}>
          {(["all", "unread", "needs_reply", "starred"] as Filter[]).map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              style={{ padding: "5px 12px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 12, whiteSpace: "nowrap",
                background: filter === f ? "var(--card)" : "transparent",
                boxShadow: filter === f ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
                color: filter === f ? "var(--t1)" : "var(--t3)",
                fontWeight: filter === f ? 600 : 400 }}>
              {f === "all" ? `All ${conversations.length}` : f === "unread" ? `Unread ${totalUnread}` : f === "needs_reply" ? `Needs reply ${totalNeedsReply}` : `Starred ${totalStarred}`}
            </button>
          ))}
        </div>
      </div>

      {/* Two-panel layout */}
      <div className="grid flex-1 min-h-0 gap-3 [grid-template-columns:300px_1fr]">

        {/* Left: Conversation list */}
        <div className="rounded-xl border border-border bg-card shadow-sm flex flex-col overflow-y-auto">
          {loading && conversations.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", fontSize: 13, color: "var(--t3)" }}>Loading…</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", fontSize: 13, color: "var(--t3)" }}>
              {conversations.length === 0
                ? "No messages yet. Connect integrations in Settings."
                : "Nothing here."}
            </div>
          ) : (
            filtered.map((conv) => {
              const isActive = selected?.key === conv.key;
              const name = conv.contactName ?? conv.latestMessage.externalId;
              return (
                <button key={conv.key} onClick={() => selectConversation(conv)}
                  style={{
                    width: "100%", display: "flex", alignItems: "flex-start", gap: 10,
                    padding: "12px 14px", background: isActive ? "var(--al)" : "transparent",
                    border: "none", borderBottom: "1px solid var(--bd)", cursor: "pointer",
                    textAlign: "left",
                    borderLeft: isActive ? "3px solid var(--ac)" : conv.unreadCount > 0 ? "3px solid #2563eb" : "3px solid transparent",
                  }}>

                  {/* Avatar */}
                  <div style={{
                    width: 36, height: 36, borderRadius: "50%", flexShrink: 0, marginTop: 1,
                    background: isActive ? "var(--ac)" : "var(--muted)",
                    color: isActive ? "#fff" : "var(--t2)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 12, fontWeight: 700,
                  }}>
                    {initials(name)}
                  </div>

                  {/* Content */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {/* Row 1: platform icon + name + star + time */}
                    <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 2 }}>
                      <PlatformIcon type={conv.platform as PlatformType} size={13} />
                      <span style={{
                        fontSize: 13, fontWeight: conv.unreadCount > 0 ? 700 : 600,
                        color: "var(--t1)", overflow: "hidden", textOverflow: "ellipsis",
                        whiteSpace: "nowrap", flex: 1,
                      }}>
                        {name}
                      </span>
                      <span style={{ fontSize: 10, color: "var(--t3)", flexShrink: 0, marginLeft: 2 }}>
                        {fmtAgo(conv.latestMessage.receivedAt)}
                      </span>
                    </div>
                    {/* Row 2: preview */}
                    <div style={{
                      fontSize: 12, color: conv.unreadCount > 0 ? "var(--t2)" : "var(--t3)",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      fontWeight: conv.unreadCount > 0 ? 500 : 400, marginBottom: 5,
                    }}>
                      {conv.latestMessage.preview ?? conv.latestMessage.body ?? ""}
                    </div>
                    {/* Row 3: badges */}
                    {(conv.needsReply || conv.unreadCount > 0) && (
                      <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                        {conv.needsReply && (
                          <span style={{
                            fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
                            background: "var(--ob)", color: "var(--oc)", letterSpacing: "0.04em",
                          }}>NEEDS REPLY</span>
                        )}
                        {conv.unreadCount > 0 && (
                          <span style={{
                            fontSize: 10, fontWeight: 700, padding: "1px 7px", borderRadius: 10,
                            background: "#2563eb", color: "#fff",
                          }}>
                            {conv.unreadCount}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </button>
              );
            }))}
        </div>

        {/* Right: Thread view */}
        <div className="rounded-xl border border-border bg-card shadow-sm flex flex-col overflow-hidden">
          {!selected ? (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 13, color: "var(--t3)" }}>
              {conversations.length === 0
                ? <span style={{ textAlign: "center" }}>No messages yet.<br /><br />Connect integrations in <strong>Settings</strong>.</span>
                : "Select a conversation"}
            </div>
          ) : (
            <>
              {/* Thread header */}
              <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--bd)",
                display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                <div style={{ width: 36, height: 36, borderRadius: "50%", background: "var(--al)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 13, fontWeight: 700, color: "var(--t1)", flexShrink: 0 }}>
                  {initials(selected.contactName)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "var(--t1)" }}>
                    {selected.contactName ?? selected.latestMessage.externalId}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--t3)", display: "flex", alignItems: "center", gap: 4 }}>
                    <PlatformIcon type={selected.platform as PlatformType} size={10} />
                    {PLATFORM_LABEL[selected.platform] ?? selected.platform}
                    {selected.messageCount > 1 && ` · ${selected.messageCount} messages`}
                    {threadLoading && (
                      <span 
                        className="inline-block rounded-full border border-current border-t-transparent animate-spin ml-1.5" 
                        style={{ width: 10, height: 10, borderWidth: "1.5px", color: "var(--t3)" }} 
                      />
                    )}
                  </div>
                </div>
                <div role="button" tabIndex={0}
                  onClick={async () => {
                    const next = !selected.starred;
                    await inboxApi.update(selected.latestMessage.id, { starred: next });
                    setConversations((prev) => prev.map((c) =>
                      c.key === selected.key
                        ? { ...c, starred: next, latestMessage: { ...c.latestMessage, starred: next } }
                        : c
                    ));
                    setSelected((s) => s ? { ...s, starred: next, latestMessage: { ...s.latestMessage, starred: next } } : s);
                  }}
                  style={{ cursor: "pointer", color: selected.starred ? "#f59e0b" : "var(--t3)",
                    display: "flex", alignItems: "center", padding: 4, borderRadius: 6,
                    background: "transparent", border: "none" }}>
                  <Star size={18} fill={selected.starred ? "#f59e0b" : "none"} />
                </div>
                {selected.contactId && (
                  <Button size="sm" variant="outline"
                    onClick={() => router.push(`/dashboard/contacts/${selected.contactId}`)}>
                    Open contact
                  </Button>
                )}
              </div>

              {/* Messages thread */}
              <div style={{ flex: 1, overflowY: "auto", padding: "16px", display: "flex",
                flexDirection: "column", gap: 12 }}>
                {(() => {
                  // Merge DB thread + locally sent, sort by time
                  const contactInitials = initials(selected.contactName);
                  const myInitials = initials(me.name ?? me.email ?? "Me");
                  type AnyMsg = InboxMessageApi | SentMessage;
                  const all: AnyMsg[] = [
                    ...thread,
                    ...(sentMessages[selected.key] ?? []),
                  ].sort((a, b) => {
                    const ta = "sentAt" in a ? a.sentAt : a.receivedAt;
                    const tb = "sentAt" in b ? b.sentAt : b.receivedAt;
                    return +new Date(ta) - +new Date(tb);
                  });

                  return all.map((msg) => {
                    const isMe = msg.fromMe;
                    const text = "body" in msg ? (msg.body ?? (msg as any).preview ?? "") : (msg as SentMessage).body;
                    const time = "sentAt" in msg ? msg.sentAt : (msg as InboxMessageApi).receivedAt;
                    const isHovered = hoveredMsgId === msg.id;
                    const canDelete = "receivedAt" in msg; // only DB messages, not local sent

                    const status = "status" in msg ? (msg as SentMessage).status : "sent";
                    const isSending = status === "sending";
                    const isFailed = status === "failed";

                    return (
                      <div key={msg.id}
                        onMouseEnter={() => setHoveredMsgId(msg.id)}
                        onMouseLeave={() => setHoveredMsgId(null)}
                        style={{ display: "flex", alignItems: "flex-end", gap: 6,
                          flexDirection: isMe ? "row-reverse" : "row" }}>
                        {/* Avatar */}
                        <div style={{ width: 30, height: 30, borderRadius: "50%", flexShrink: 0,
                          background: isMe ? "#2563eb" : "var(--al)",
                          color: "#fff",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          fontSize: 11, fontWeight: 700 }}>
                          {isMe ? myInitials : contactInitials}
                        </div>
                        {/* Bubble */}
                        <div style={{ display: "flex", flexDirection: "column",
                          alignItems: isMe ? "flex-end" : "flex-start", maxWidth: "70%" }}>
                          <div style={{
                            background: isMe ? "#2563eb" : "var(--al)",
                            color: isMe ? "#fff" : "var(--t1)",
                            borderRadius: isMe ? "12px 4px 12px 12px" : "4px 12px 12px 12px",
                            padding: "8px 12px", fontSize: 13, lineHeight: 1.5, wordBreak: "break-word",
                            opacity: isSending ? 0.7 : 1,
                          }}>
                            {renderMessageBody(text, setLightboxUrl)}
                          </div>
                          <div style={{ fontSize: 10, color: "var(--t3)", marginTop: 3,
                            display: "flex", gap: 5, alignItems: "center" }}>
                            {fmtAgo(time)}
                            {isMe && (
                              <span style={{ fontSize: 11, display: "inline-flex", alignItems: "center" }}>
                                {isSending ? (
                                  <span className="inline-block rounded-full border border-current border-t-transparent animate-spin"
                                    style={{ width: 10, height: 10, opacity: 0.6 }} />
                                ) : isFailed ? (
                                  <span style={{ color: "var(--rc)", fontWeight: "bold" }} title="Delivery failed">⚠️</span>
                                ) : (
                                  <span style={{ color: "#2563eb", opacity: 0.8 }} title="Sent">✓</span>
                                )}
                              </span>
                            )}
                          </div>
                        </div>
                        {/* Action buttons on hover — flex siblings right next to the bubble */}
                        {isHovered && canDelete && (
                          <div style={{ flexShrink: 0, alignSelf: "center", display: "flex", flexDirection: isMe ? "row-reverse" : "row", gap: 2 }}>
                            {/* Reply button */}
                            <button
                              onClick={() => setReplyingTo(msg as InboxMessageApi)}
                              title="Reply to this message"
                              style={{ background: "transparent", color: "var(--t3)",
                                border: "none", borderRadius: 4, width: 24, height: 24,
                                fontSize: 13, cursor: "pointer", display: "flex",
                                alignItems: "center", justifyContent: "center" }}
                              onMouseEnter={(e) => (e.currentTarget.style.color = "#2563eb")}
                              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--t3)")}>
                              ↩
                            </button>
                            {/* Delete button */}
                            <button
                              onClick={() => handleDeleteMsg(msg.id)}
                              title="Delete message"
                              style={{ background: "transparent", color: "var(--t3)",
                                border: "none", borderRadius: 4, width: 24, height: 24,
                                fontSize: 15, cursor: "pointer", display: "flex",
                                alignItems: "center", justifyContent: "center" }}
                              onMouseEnter={(e) => (e.currentTarget.style.color = "#ef4444")}
                              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--t3)")}>
                              ×
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  });
                })()}
                <div ref={bottomRef} />
              </div>

              {/* Reply box */}
              <div style={{ padding: "10px 14px", borderTop: "1px solid var(--bd)",
                background: "var(--sf2)", flexShrink: 0 }}>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,video/*,application/pdf,.zip,.txt,.doc,.docx"
                  style={{ display: "none" }}
                  onChange={handleFileUpload}
                />
                {/* Reply-to quote preview */}
                {replyingTo && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6,
                    padding: "6px 10px", borderRadius: 8, background: "var(--al)",
                    borderLeft: "3px solid #2563eb" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: "#2563eb", marginBottom: 2 }}>
                        {replyingTo.fromMe ? (me.name ?? "You") : (replyingTo.contactName ?? "Contact")}
                      </div>
                      <div style={{ fontSize: 12, color: "var(--t2)", overflow: "hidden",
                        textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {replyingTo.body ?? replyingTo.preview ?? ""}
                      </div>
                    </div>
                    <button onClick={() => setReplyingTo(null)}
                      style={{ background: "none", border: "none", cursor: "pointer",
                        color: "var(--t3)", fontSize: 18, lineHeight: 1, flexShrink: 0 }}>×</button>
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                  {/* Paperclip button */}
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    title="Attach file"
                    style={{ flexShrink: 0, height: 36, width: 36, borderRadius: 8, border: "1px solid var(--bd)",
                      background: "var(--card)", cursor: uploading ? "not-allowed" : "pointer",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      color: "var(--t3)", opacity: uploading ? 0.5 : 1 }}>
                    {uploading ? (
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
                    ) : (
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                    )}
                  </button>
                  <textarea value={reply} onChange={(e) => setReply(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSend(); }}
                    placeholder={`Message ${selected.contactName ?? ""}… (⌘↵ to send)`}
                    rows={2} style={{ flex: 1, resize: "none", fontSize: 13, padding: "8px 10px",
                      borderRadius: 10, border: "1px solid var(--bd)", background: "var(--card)",
                      color: "var(--t1)", outline: "none", lineHeight: 1.4 }} />
                  <Button size="sm" onClick={handleSend} disabled={!reply.trim()}
                    style={{ flexShrink: 0, height: 36 }}>
                    Send
                  </Button>
                </div>
                {sendError && (
                  <p style={{ fontSize: 11, color: "var(--rc)", marginTop: 4 }}>{sendError}</p>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
