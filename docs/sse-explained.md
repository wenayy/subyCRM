# Server-Sent Events (SSE) — Complete Guide

## What problem does SSE solve?

Normal HTTP works like this: the **browser asks, the server answers, connection closes**. That's called request-response. It works great for loading a page or submitting a form.

But what if the server needs to tell the browser something **without the browser asking first**? For example:
- A new WhatsApp message just arrived
- Someone's delivery tick changed from ✓ to ✓✓
- A teammate is typing

You have three options:

| Approach | How it works | Problem |
|---|---|---|
| **Polling** | Browser asks "anything new?" every 2 seconds | Wasteful — 99% of requests get "nothing new" |
| **WebSockets** | Persistent two-way pipe | Complex to set up, overkill if server only needs to push |
| **SSE** | Server holds the connection open and pushes whenever it wants | Simple, one-way (server → browser), built into browsers natively |

SSE is the right choice when **only the server needs to push** and the browser doesn't need to send data back on that same channel.

---

## How SSE works technically

### Step 1 — Browser opens a connection and keeps it open

```
Browser → Server:  GET /api/inbox/stream  (normal HTTP request)
Server  → Browser: 200 OK
                   Content-Type: text/event-stream   ← magic header
                   Connection: keep-alive

                   data: connected                   ← first event
                                                     ← connection stays open forever
```

The browser sends a normal GET request. The server responds with `Content-Type: text/event-stream` and then **never closes the connection**. The browser sits and waits, reading bytes as they arrive.

### Step 2 — Server pushes events whenever something happens

The format of each event is very simple — plain text:

```
event: new_message
data: {"platform":"whatsapp","contactId":"abc123","fromMe":false}

```

Two newlines (`\n\n`) mark the end of one event. The browser's built-in `EventSource` API fires a JavaScript event each time one arrives.

### Step 3 — Browser listens and reacts

```javascript
const source = new EventSource('/api/inbox/stream');

source.addEventListener('new_message', (e) => {
  const data = JSON.parse(e.data);
  // update the UI
});
```

---

## Key terms

### `Content-Type: text/event-stream`
The HTTP header that tells the browser "this is an SSE connection, don't close it, keep reading bytes forever."

### `EventSource`
The browser's built-in JavaScript class for consuming SSE. It automatically:
- Reconnects if the connection drops
- Parses the event format
- Fires event listeners

### Event
One unit of data pushed from server to browser. Has two parts:
- `event:` — the name (like `new_message`, `typing`, `status_update`)
- `data:` — the payload, usually a JSON string

### `flushHeaders()`
In Express (Node.js), HTTP responses are buffered — the server collects bytes and sends them in batches for efficiency. For SSE this would break everything because events need to arrive **immediately**. `flushHeaders()` sends the HTTP headers right away and disables buffering, so each `res.write()` goes to the browser instantly.

### `X-Accel-Buffering: no`
Nginx (a common reverse proxy in front of Node servers) also buffers responses by default. This header tells Nginx to stop buffering and let bytes through immediately. Without it, SSE events get stuck in Nginx's buffer and arrive in batches instead of in real time.

### Client registry
The server needs to remember every open SSE connection so it can push to all of them. In this codebase that's the `clients` Map in `sse.service.ts` — it maps a user ID string to their open Express response object.

### Broadcast
Sending an event to **all** currently connected SSE clients at once. Used for events that every logged-in user should see.

---

## How this codebase implements SSE

### The SSE service — `src/server/services/sse.service.ts`

This is the core of the system. Three things live here:

**1. The client registry**
```typescript
const clients = new Map<string, Response>();
```
A Map from `userId` (or session ID) → the Express `res` object for their open SSE connection. Every browser tab that has the inbox open has one entry here.

**2. `registerSSEClient(id, res)`**
Called when a browser first connects to the SSE stream endpoint. It:
- Sets the three required headers (`text/event-stream`, `no-cache`, `keep-alive`)
- Sets `X-Accel-Buffering: no` so Nginx doesn't buffer
- Calls `res.flushHeaders()` to open the pipe immediately
- Writes a first `data: connected` event so the browser knows it's live
- Stores `res` in the `clients` Map

**3. `broadcastInboxEvent(event, data)`**
```typescript
export function broadcastInboxEvent(event: SSEEvent, data: object = {}) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [id, res] of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(id);  // client disconnected — clean up
    }
  }
}
```
Loops over every connected client and writes the event string to their open HTTP response. If `res.write()` throws (browser closed the tab), the client is removed from the Map.

**4. The SSEEvent type**
```typescript
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
```
A TypeScript union type listing every event name the server can send. This prevents typos — if you try to broadcast an event not in this list, TypeScript refuses to compile.

---

### The SSE route — where the browser connects

Somewhere in the Express routes there is an endpoint (like `GET /api/inbox/stream`) that:
1. Calls `registerSSEClient(userId, res)`
2. Sets up a cleanup handler for when the browser disconnects:
```typescript
req.on("close", () => removeSSEClient(userId));
```

When the browser closes the tab or refreshes, Node fires the `close` event on the request, and the client is removed from the Map.

---

### Where events are fired — throughout the backend

`broadcastInboxEvent` is called in many places. Here's each one and why:

| Event | Where it fires | What triggers it |
|---|---|---|
| `new_message` | `inbox.service.ts` → `upsert()` | Any new message saved to DB (WhatsApp, Telegram, Gmail, etc.) |
| `message_deleted` | `inbox.service.ts` → `deleteMessage()` | A message is deleted (delete for everyone, or manual) |
| `conversations_changed` | Various | When conversation list needs a refresh |
| `send_failed` | `inbox.service.ts` → `reply()` background catch | When a WhatsApp/Telegram send fails after the HTTP response was already returned |
| `status_update` | `whatsapp.service.ts` → `messages.update` handler | When Baileys fires a delivery status change (sent → delivered → read) |
| `typing` | `whatsapp.service.ts` → `presence.update` handler | When a WhatsApp contact starts or stops typing |
| `reminder_*` | Reminder routes | When reminders are created, updated, or deleted |

---

### How the frontend listens — `inbox-view.tsx`

The inbox page creates an `EventSource` connection when it mounts:

```typescript
const source = new EventSource('/api/inbox/stream');
```

Then it attaches listeners for each event type:

```typescript
source.addEventListener('new_message', (e) => {
  const data = JSON.parse(e.data);
  // Re-fetch conversations and thread to show the new message
  loadConversations();
  if (data.contactId === selected?.contactId) loadThread();
});

source.addEventListener('status_update', (e) => {
  const { externalId, waStatus } = JSON.parse(e.data);
  // Update the tick on the matching message bubble without re-fetching
  setThread(prev => prev.map(m =>
    m.externalId === externalId ? { ...m, waStatus } : m
  ));
});

source.addEventListener('typing', (e) => {
  const { senderId, typing } = JSON.parse(e.data);
  setTypingContactIds(prev => {
    const next = new Set(prev);
    typing ? next.add(senderId) : next.delete(senderId);
    return next;
  });
});
```

When the `EventSource` connection drops (server restart, network blip), the browser automatically tries to reconnect every few seconds — this is built into the `EventSource` spec.

---

## The full flow for a new WhatsApp message

Here is what happens end-to-end when your contact sends you a WhatsApp message, in exact order:

```
1. Contact sends message from their phone
         ↓
2. WhatsApp routes it to Baileys (running on Railway)
         ↓
3. Baileys fires: sock.ev.on("messages.upsert", ...)
         ↓
4. whatsapp.service.ts → processMessage()
         ↓
5. resolveContact() → finds which CRM contact this JID belongs to
         ↓
6. inboxService.upsert() → saves message to PostgreSQL (Supabase)
         ↓
7. broadcastInboxEvent("new_message", { ... })  ← SSE fires HERE
         ↓
8. sse.service.ts loops over clients Map, writes event to all open connections
         ↓
9. Browser's EventSource receives the event (typically < 200ms after step 6)
         ↓
10. inbox-view.tsx listener fires → calls loadConversations() + loadThread()
         ↓
11. UI updates — message appears in the thread
```

Steps 1-11 happen in under a second in normal conditions. The SSE part (steps 7-9) adds essentially zero latency — it's just writing bytes to an already-open TCP connection.

---

## Why SSE instead of polling for this app

If SSE didn't exist and the inbox polled every 3 seconds:
- With 10 team members using the inbox → 10 requests every 3 seconds = 200 requests/minute just to check for new messages
- Each request hits the database
- 99% of those requests find nothing new
- Wastes database connections, CPU, and Railway compute credits

With SSE:
- 10 open connections sitting idle (negligible cost)
- Database is only hit when an actual message arrives
- Messages appear instantly instead of up to 3 seconds late

---

## Common SSE gotchas

**Why does the inbox go blank when the server restarts?**
The server restart closes all SSE connections. The browser's `EventSource` tries to reconnect but gets errors while the server is coming back up. Once the server is ready, it reconnects automatically and the inbox loads fresh data.

**Why must `res.write()` not throw?**
In Node.js, writing to a closed socket throws synchronously. That's why `broadcastInboxEvent` wraps `res.write()` in a try/catch and removes the client if it throws — otherwise one closed tab would crash the broadcast loop and nobody would get events.

**Why two newlines at the end of each event?**
The SSE spec requires `\n\n` to signal the end of an event. A single `\n` just continues the current event's data field. Without the double newline, the browser never fires the event listener.
