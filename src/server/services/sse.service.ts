import type { Response } from "express";

// Registry of active SSE clients
const clients = new Map<string, Response>();

export function registerSSEClient(id: string, res: Response) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
  res.flushHeaders();
  res.write("data: connected\n\n");
  clients.set(id, res);
}

export function removeSSEClient(id: string) {
  clients.delete(id);
}

export type SSEEvent =
  | "new_message"
  | "message_deleted"
  | "conversations_changed"
  | "send_failed"
  | "reminder_created"
  | "reminder_updated"
  | "reminder_deleted"
  | "status_update"
  | "typing";

export function broadcastInboxEvent(event: SSEEvent, data: object = {}) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [id, res] of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(id);
    }
  }
}
