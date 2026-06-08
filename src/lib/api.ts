import type { Contact, ContactStats, Tag, ImportJob, Company, Reminder } from "./types";

const API_BASE = "";

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
    cache: "no-store",
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `API error ${res.status}`);
  }

  return res.json();
}

// ─── Contacts API ───────────────────────────────────────────
export const contactsApi = {
  getAll: (params?: { type?: string; domain?: string; search?: string; strength?: string; stale_days?: string; page?: string; limit?: string }) => {
    const qs = params ? "?" + new URLSearchParams(params as Record<string, string>).toString() : "";
    return apiFetch<{ data: Contact[]; total: number; page: number; limit: number }>(`/api/contacts${qs}`);
  },

  getById: (id: string) => apiFetch<Contact>(`/api/contacts/${id}`),

  getStats: () => apiFetch<ContactStats>("/api/contacts/stats"),

  create: (data: Partial<Contact>) =>
    apiFetch<Contact>("/api/contacts", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  update: (id: string, data: Partial<Contact>) =>
    apiFetch<Contact>(`/api/contacts/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    apiFetch<{ success: boolean }>(`/api/contacts/${id}`, { method: "DELETE" }),

  merge: (sourceId: string, targetId: string) =>
    apiFetch<Contact>("/api/contacts/merge", {
      method: "POST",
      body: JSON.stringify({ sourceId, targetId }),
    }),

  enrich: async (id: string) => {
    type EnrichResult = {
      contactId: string;
      enrichedData: Record<string, string>;
      companyLinked: { id: string; name: string } | null;
      platformsAdded: Array<{ type: string; platformId: string; profileUrl?: string }>;
    };
    const res = await apiFetch<{ status?: string; jobId?: string } & Partial<EnrichResult>>(
      `/api/contacts/${id}/enrich`, { method: "POST" }
    );
    if (res.status === "queued" && res.jobId) {
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        const poll = await apiFetch<{ state: string; returnValue?: EnrichResult }>(
          `/api/contacts/enrich-job/${res.jobId}`
        );
        if (poll.state === "completed") return poll.returnValue!;
        if (poll.state === "failed") throw new Error("Enrichment failed");
      }
      throw new Error("Enrichment timed out");
    }
    return res as EnrichResult;
  },

  addNote: (id: string, content: string) =>
    apiFetch<unknown>(`/api/contacts/${id}/notes`, {
      method: "POST",
      body: JSON.stringify({ content }),
    }),

  deleteNote: (id: string, noteId: string) =>
    apiFetch<{ success: boolean }>(`/api/contacts/${id}/notes/${noteId}`, { method: "DELETE" }),

  addTag: (id: string, tagId: string) =>
    apiFetch<unknown>(`/api/contacts/${id}/tags`, {
      method: "POST",
      body: JSON.stringify({ tagId }),
    }),

  removeTag: (id: string, tagId: string) =>
    apiFetch<{ success: boolean }>(`/api/contacts/${id}/tags/${tagId}`, { method: "DELETE" }),

  addPlatform: (id: string, data: { type: string; platformId: string; displayName?: string }) =>
    apiFetch<{ id: string; type: string; platformId: string; displayName?: string }>(`/api/contacts/${id}/platforms`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  updatePlatform: (id: string, pid: string, data: { platformId?: string; displayName?: string }) =>
    apiFetch<{ id: string; type: string; platformId: string; displayName?: string }>(`/api/contacts/${id}/platforms/${pid}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  deletePlatform: (id: string, pid: string) =>
    apiFetch<{ success: boolean }>(`/api/contacts/${id}/platforms/${pid}`, { method: "DELETE" }),

  bulkDelete: (ids: string[]) =>
    apiFetch<{ deleted: number }>("/api/contacts/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ ids }),
    }),

  bulkTag: (ids: string[], tagId: string) =>
    apiFetch<{ tagged: number }>("/api/contacts/bulk-tag", {
      method: "POST",
      body: JSON.stringify({ ids, tagId }),
    }),
};

// ─── Tags API ───────────────────────────────────────────────
export const tagsApi = {
  getAll: () => apiFetch<Tag[]>("/api/tags"),

  create: (name: string, color?: string) =>
    apiFetch<Tag>("/api/tags", {
      method: "POST",
      body: JSON.stringify({ name, color }),
    }),
};

// ─── Import API ─────────────────────────────────────────────
export const importApi = {
  getJobs: () => apiFetch<ImportJob[]>("/api/imports"),

  runBeeper: () =>
    apiFetch<{ status: string; jobId?: string }>("/api/imports/beeper", { method: "POST" }),

  runTelegram: () =>
    apiFetch<{ status: string; jobId: string }>("/api/imports/telegram", { method: "POST" }),

  runDiscord: () =>
    apiFetch<{ status: string; jobId: string }>("/api/imports/discord", { method: "POST" }),

  runSlack: () =>
    apiFetch<{ status: string; jobId: string }>("/api/imports/slack", { method: "POST" }),

  runWhatsApp: () =>
    apiFetch<{ status: string; jobId: string }>("/api/imports/whatsapp", { method: "POST" }),

  runCsv: (csv: string) =>
    apiFetch<{ status: string; jobId: string }>("/api/imports/csv", {
      method: "POST",
      body: JSON.stringify({ csv }),
    }),
};

// ─── Companies API ─────────────────────────────────────────
export const companiesApi = {
  getAll: () => apiFetch<Company[]>("/api/companies"),

  getById: (id: string) => apiFetch<Company>(`/api/companies/${id}`),

  create: (data: Partial<Company>) =>
    apiFetch<Company>("/api/companies", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  update: (id: string, data: Partial<Company>) =>
    apiFetch<Company>(`/api/companies/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  assignContacts: (id: string, contactIds: string[]) =>
    apiFetch<Company>(`/api/companies/${id}/assign`, {
      method: "POST",
      body: JSON.stringify({ contactIds }),
    }),
};

// ─── Reminders API ─────────────────────────────────────────
export const remindersApi = {
  getAll: () => apiFetch<Reminder[]>("/api/reminders"),

  getDue: () => apiFetch<Reminder[]>("/api/reminders/due"),

  create: (contactId: string, data: { content: string; dueDate: string }) =>
    apiFetch<Reminder>(`/api/contacts/${contactId}/reminders`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  update: (id: string, data: Partial<Reminder>) =>
    apiFetch<Reminder>(`/api/reminders/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    apiFetch<{ success: boolean }>(`/api/reminders/${id}`, { method: "DELETE" }),
};

// ─── AI API ─────────────────────────────────────────────────
async function pollJob<T>(queue: string, jobId: string, timeoutMs = 30000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 800));
    const status = await apiFetch<{ state: string; returnValue?: T }>(`/api/ai/job/${queue}/${jobId}`);
    if (status.state === "completed") return status.returnValue as T;
    if (status.state === "failed") throw new Error("AI job failed");
  }
  throw new Error("AI job timed out");
}

export const aiApi = {
  classify: async (id: string) => {
    const res = await apiFetch<{ jobId?: string; status?: string; type?: string; domain?: string; strength?: string }>(
      `/api/ai/classify/${id}`, { method: "POST" }
    );
    if (res.status === "queued" && res.jobId) await pollJob("ai-classify", res.jobId);
    return res;
  },

  summary: async (id: string, refresh = false) => {
    const qs = refresh ? "?refresh=true" : "";
    const res = await apiFetch<{ jobId?: string; status?: string; summary?: string }>(
      `/api/ai/summary/${id}${qs}`, { method: "POST" }
    );
    if (res.status === "queued" && res.jobId) {
      const result = await pollJob<{ summary: string }>("ai-summary", res.jobId);
      return result;
    }
    return res as { summary: string };
  },

  prep: async (id: string, refresh = false) => {
    const qs = refresh ? "?refresh=true" : "";
    const res = await apiFetch<{ jobId?: string; status?: string; briefing?: string }>(
      `/api/ai/prep/${id}${qs}`, { method: "POST" }
    );
    if (res.status === "queued" && res.jobId) {
      const raw = await pollJob<any>("ai-prep", res.jobId);
      // Worker returns the raw generatePrep object: { summary, talkingPoints[], recentActivity, suggestedActions[] }
      // Format it into a readable string for the frontend
      const lines: string[] = [];
      if (raw?.summary) lines.push(raw.summary);
      if (raw?.recentActivity) lines.push(`\nRecent activity: ${raw.recentActivity}`);
      if (raw?.talkingPoints?.length) lines.push(`\nTalking points:\n${(raw.talkingPoints as string[]).map((p) => `• ${p}`).join("\n")}`);
      if (raw?.suggestedActions?.length) lines.push(`\nSuggested actions:\n${(raw.suggestedActions as string[]).map((a) => `• ${a}`).join("\n")}`);
      return { briefing: lines.join("\n") || "No briefing generated." };
    }
    return res as { briefing: string };
  },

  classifyBatch: () =>
    apiFetch<{ queued: number }>("/api/ai/classify-batch", { method: "POST" }),

  alerts: () =>
    apiFetch<AlertApi[]>("/api/ai/alerts"),
};

// ─── Calendar API ───────────────────────────────────────────
export const calendarApi = {
  status: () =>
    apiFetch<{ connected: boolean; lastSync: string | null }>("/api/calendar/status"),

  connectUrl: () =>
    apiFetch<{ url: string }>("/api/calendar/connect-url"),

  sync: () =>
    apiFetch<{ synced: number }>("/api/calendar/sync", { method: "POST" }),

  disconnect: () =>
    apiFetch<{ ok: boolean }>("/api/calendar/disconnect", { method: "DELETE" }),

  getEvents: (start?: string, end?: string) => {
    const qs = new URLSearchParams();
    if (start) qs.set("start", start);
    if (end) qs.set("end", end);
    const query = qs.toString() ? `?${qs.toString()}` : "";
    return apiFetch<CalendarEventApi[]>(`/api/calendar/events${query}`);
  },
};

export interface AlertApi {
  type: string;
  contactId: string;
  contactName: string;
  reason: string;
  urgency: "high" | "medium" | "low";
  draftMessage: string;
  channel: string | null;
  channelHandle: string | null;
}

export const meApi = {
  get: () => apiFetch<{ id: string | null; name: string | null; email: string | null }>("/api/me"),
};

// ─── Inbox API ──────────────────────────────────────────────
export interface InboxMessageApi {
  id: string;
  platform: string;
  externalId: string;
  contactId: string | null;
  contactName: string | null;
  preview: string | null;
  body: string | null;
  read: boolean;
  starred: boolean;
  needsReply: boolean;
  fromMe: boolean;
  receivedAt: string;
  senderId: string | null;
  waStatus?: string | null;
  quotedId?: string | null;
  quotedBody?: string | null;
  quotedFromMe?: boolean | null;
}

export interface InboxConversationApi {
  key: string;
  contactId: string | null;
  contactName: string | null;
  platform: string;
  senderId: string | null;
  latestMessage: InboxMessageApi;
  unreadCount: number;
  needsReply: boolean;
  messageCount: number;
  starred: boolean;
}

export const inboxApi = {
  getAll: () => apiFetch<InboxMessageApi[]>("/api/inbox"),
  getConversations: () => apiFetch<InboxConversationApi[]>("/api/inbox/conversations"),
  getThread: (contactId: string, platform: string) =>
    apiFetch<InboxMessageApi[]>(`/api/inbox/thread?contactId=${encodeURIComponent(contactId)}&platform=${encodeURIComponent(platform)}`),
  getContactMessages: (contactId: string) =>
    apiFetch<InboxMessageApi[]>(`/api/inbox/contact/${encodeURIComponent(contactId)}`),
  getStats: () => apiFetch<{ total: number; unread: number; needsReply: number; starred: number }>("/api/inbox/stats"),
  update: (id: string, data: { read?: boolean; starred?: boolean; needsReply?: boolean }) =>
    apiFetch<InboxMessageApi>(`/api/inbox/${id}`, { method: "PATCH", body: JSON.stringify(data) }),

  markConversationRead: (contactId: string, platform: string) =>
    apiFetch<{ success: boolean }>("/api/inbox/mark-read", { method: "POST", body: JSON.stringify({ contactId, platform }) }),
  getUnknownThread: (senderId: string, platform: string) =>
    apiFetch<InboxMessageApi[]>(`/api/inbox/unknown-thread?senderId=${encodeURIComponent(senderId)}&platform=${encodeURIComponent(platform)}`),
  markUnknownConversationRead: (senderId: string, platform: string) =>
    apiFetch<{ success: boolean }>("/api/inbox/mark-unknown-read", { method: "POST", body: JSON.stringify({ senderId, platform }) }),

  delete: (id: string) =>
    apiFetch<{ success: boolean }>(`/api/inbox/${id}`, { method: "DELETE" }),
  reply: (id: string, body: string, replyToId?: string) =>
    apiFetch<{ ok: boolean }>(`/api/inbox/${id}/reply`, { method: "POST", body: JSON.stringify({ body, replyToId }) }),
  react: (id: string, emoji: string) =>
    apiFetch<{ ok: boolean }>(`/api/inbox/${id}/react`, { method: "POST", body: JSON.stringify({ emoji }) }),
  upload: (filename: string, fileData: string) =>
    apiFetch<{ url: string }>("/api/inbox/upload", {
      method: "POST",
      body: JSON.stringify({ filename, fileData }),
    }),
  getThreadMore: (contactId: string, platform: string, before: string, limit = 50) =>
    apiFetch<InboxMessageApi[]>(`/api/inbox/thread-more?contactId=${encodeURIComponent(contactId)}&platform=${encodeURIComponent(platform)}&before=${encodeURIComponent(before)}&limit=${limit}`),
  subscribePresence: (jid: string) =>
    apiFetch<{ ok: boolean }>("/api/inbox/subscribe-presence", { method: "POST", body: JSON.stringify({ jid }) }),
};

// ─── Discord API ────────────────────────────────────────────
export const discordApi = {
  status: () => apiFetch<{ connected: boolean; lastSync: string | null; username?: string }>("/api/discord/status"),
  connectUrl: () => apiFetch<{ url: string }>("/api/discord/connect-url"),
  connect: (botToken: string) => apiFetch<{ connected: boolean; username?: string }>("/api/discord/connect", { method: "POST", body: JSON.stringify({ botToken }) }),
  sync: () => apiFetch<{ synced: number }>("/api/discord/sync", { method: "POST" }),
  disconnect: () => apiFetch<{ ok: boolean }>("/api/discord/disconnect", { method: "DELETE" }),
};

// ─── Slack API ──────────────────────────────────────────────
export const slackApi = {
  status: () => apiFetch<{ connected: boolean; lastSync: string | null; teamName?: string }>("/api/slack/status"),
  connectUrl: () => apiFetch<{ url: string }>("/api/slack/connect-url"),
  sync: () => apiFetch<{ synced: number }>("/api/slack/sync", { method: "POST" }),
  disconnect: () => apiFetch<{ ok: boolean }>("/api/slack/disconnect", { method: "DELETE" }),
};

// ─── X/Twitter API ─────────────────────────────────────────
export const xApi = {
  status: () => apiFetch<{ connected: boolean; lastSync: string | null; screenName?: string; hasEnvCreds?: boolean; hasCookie?: boolean }>("/api/x/status"),
  connectUrl: () => apiFetch<{ url: string }>("/api/x/connect-url"),
  connect: (data: { accessToken: string; accessTokenSecret: string; apiKey?: string; apiSecret?: string }) =>
    apiFetch<{ connected: boolean; screenName?: string }>("/api/x/connect", { method: "POST", body: JSON.stringify(data) }),
  saveCookie: (data: { authToken: string; ct0: string }) =>
    apiFetch<{ connected: boolean; screenName: string }>("/api/x/cookie", { method: "POST", body: JSON.stringify(data) }),
  sync: () => apiFetch<{ synced: number }>("/api/x/sync", { method: "POST" }),
  disconnect: () => apiFetch<{ ok: boolean }>("/api/x/disconnect", { method: "DELETE" }),
};

// ─── WhatsApp API ───────────────────────────────────────────
export const whatsappApi = {
  status: () => apiFetch<{ connected: boolean; qrAvailable: boolean; phoneNumber: string | null }>("/api/whatsapp/status"),
  init: () => apiFetch<{ qr?: string; connected: boolean }>("/api/whatsapp/init", { method: "POST" }),
  getQR: () => apiFetch<{ qr: string | null }>("/api/whatsapp/qr"),
  disconnect: () => apiFetch<{ ok: boolean }>("/api/whatsapp/disconnect", { method: "DELETE" }),
};

// ─── Telegram Personal API ─────────────────────────────────
export const telegramBotApi = {
  status: () => apiFetch<{ linked: boolean; chatId: string | null; linkedAt: string | null }>("/api/telegram-bot/status"),
  username: () => apiFetch<{ username: string }>("/api/telegram-bot/username"),
  generateToken: () => apiFetch<{ token: string }>("/api/telegram-bot/generate-token", { method: "POST" }),
  unlink: () => apiFetch<{ ok: boolean }>("/api/telegram-bot/unlink", { method: "POST" }),
};

export const telegramPersonalApi = {
  status: () => apiFetch<{ connected: boolean; lastSync: string | null; phone?: string; hasEnvCreds?: boolean }>("/api/telegram-personal/status"),
  sendCode: (data: { phoneNumber: string; apiId?: number; apiHash?: string }) =>
    apiFetch<{ sent: boolean }>("/api/telegram-personal/send-code", { method: "POST", body: JSON.stringify(data) }),
  verify: (data: { code: string; password?: string }) =>
    apiFetch<{ connected: boolean }>("/api/telegram-personal/verify", { method: "POST", body: JSON.stringify(data) }),
  sync: () => apiFetch<{ synced: number }>("/api/telegram-personal/sync", { method: "POST" }),
  syncHistory: () => apiFetch<{ synced: number }>("/api/telegram-personal/sync-history", { method: "POST" }),
  disconnect: () => apiFetch<{ ok: boolean }>("/api/telegram-personal/disconnect", { method: "DELETE" }),
  startQr: (data?: { apiId?: number; apiHash?: string }) =>
    apiFetch<{ active: boolean }>("/api/telegram-personal/start-qr", { method: "POST", body: JSON.stringify(data ?? {}) }),
  getQrStatus: () =>
    apiFetch<{ active: boolean; connected: boolean; qr: string | null; passwordRequired: boolean; phone?: string; error: string | null }>("/api/telegram-personal/qr-status"),
  submitPassword: (password: string) =>
    apiFetch<{ success: boolean }>("/api/telegram-personal/submit-password", { method: "POST", body: JSON.stringify({ password }) }),
};

// ─── LinkedIn API ───────────────────────────────────────────
export const linkedinApi = {
  status: () => apiFetch<{ connected: boolean; profileName: string | null; hasCookie?: boolean; lastSync?: string | null }>("/api/linkedin/status"),
  connectUrl: () => apiFetch<{ url: string }>("/api/linkedin/connect-url"),
  saveCookie: (data: { liAt: string; jsessionId?: string }) =>
    apiFetch<{ ok: boolean }>("/api/linkedin/cookie", { method: "POST", body: JSON.stringify(data) }),
  sync: () => apiFetch<{ synced: number }>("/api/linkedin/sync", { method: "POST" }),
  disconnect: () => apiFetch<{ ok: boolean }>("/api/linkedin/disconnect", { method: "DELETE" }),
};

// ─── Pipeline API ────────────────────────────────────────────
export const pipelineApi = {
  list: () => apiFetch<any[]>("/api/pipeline"),
  create: (data: Record<string, any>) => apiFetch<any>("/api/pipeline", { method: "POST", body: JSON.stringify(data) }),
  update: (id: string, data: Record<string, any>) => apiFetch<any>(`/api/pipeline/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  remove: (id: string) => apiFetch<void>(`/api/pipeline/${id}`, { method: "DELETE" }),
};

// ─── Sequences API ───────────────────────────────────────────
export const sequenceApi = {
  list: () => apiFetch<any[]>("/api/sequences"),
  create: (data: Record<string, any>) => apiFetch<any>("/api/sequences", { method: "POST", body: JSON.stringify(data) }),
  update: (id: string, data: Record<string, any>) => apiFetch<any>(`/api/sequences/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  updateStep: (seqId: string, stepId: string, data: Record<string, any>) => apiFetch<any>(`/api/sequences/${seqId}/steps/${stepId}`, { method: "PATCH", body: JSON.stringify(data) }),
  remove: (id: string) => apiFetch<void>(`/api/sequences/${id}`, { method: "DELETE" }),
};

// ─── Voice API ──────────────────────────────────────────────
export const voiceApi = {
  captures: () => apiFetch<VoiceCaptureApi[]>("/api/voice/captures"),
  stats: () => apiFetch<{ total: number; processed: number; failed: number; actions: number }>("/api/voice/stats"),
  simulate: (transcript: string) =>
    apiFetch<VoiceCaptureApi>("/api/voice/simulate", {
      method: "POST",
      body: JSON.stringify({ transcript }),
    }),
};

export interface VoiceCaptureApi {
  id: string;
  transcript: string;
  contactId: string | null;
  contactName: string | null;
  action: string;
  content: string | null;
  dueDate: string | null;
  strength: string | null;
  status: string;
  processingMs: number | null;
  createdAt: string;
}

// ─── Gmail API ──────────────────────────────────────────────
export const gmailApi = {
  status: () =>
    apiFetch<{ connected: boolean; lastSync: string | null }>("/api/gmail/status"),

  connectUrl: () =>
    apiFetch<{ url: string }>("/api/gmail/connect-url"),

  sync: () =>
    apiFetch<{ synced: number }>("/api/gmail/sync", { method: "POST" }),

  disconnect: () =>
    apiFetch<{ ok: boolean }>("/api/gmail/disconnect", { method: "DELETE" }),

  getThreads: (contactId?: string) => {
    const qs = contactId ? `?contactId=${contactId}` : "";
    return apiFetch<GmailThreadApi[]>(`/api/gmail/threads${qs}`);
  },
};

export interface GmailThreadApi {
  id: string;
  threadId: string;
  subject: string | null;
  snippet: string | null;
  contactId: string | null;
  contactEmail: string | null;
  fromEmail: string | null;
  lastDate: string;
  messageCount: number;
}

export interface CalendarEventApi {
  id: string;
  googleId: string;
  title: string;
  start: string;
  end: string;
  contactId: string;
  contactName: string;
  channel: string;
  location?: string;
  description?: string;
  htmlLink?: string;
}
