# WhatsApp 440 Disconnect Loop — Root Cause & Fix

---

## What Code 440 Actually Means

WhatsApp's multi-device protocol assigns numeric codes to WebSocket close events. Code `440` is `DisconnectReason.connectionReplaced` in Baileys. WhatsApp's server sends this when it believes **a new connection for the same linked device already exists** — in other words, "you've been replaced, close yourself."

This is a legitimate signal in normal usage: if you open WhatsApp Web in two browser tabs at once, the first tab gets a 440 when the second one connects. Each linked device is only allowed one active WebSocket at a time.

---

## Why It Was Broken: The 0 ms Reconnect Race

The root cause was in `scheduleReconnect` at `src/server/services/whatsapp.service.ts`:

```typescript
function scheduleReconnect(gen: number): void {
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  const delay = state.reconnectDelay;  // ← was 0 on first call
  state.reconnectDelay = delay === 0 ? 2_000 : Math.min(delay * 2, 30_000);
  if (delay > 0) console.log(`[whatsapp] Reconnecting in ${delay / 1000}s…`);
  state.reconnectTimer = setTimeout(() => {
    if (state.generation === gen && state.userId && !state.connected) {
      connectSocket(state.userId).catch(console.error);
    }
  }, delay);  // ← setTimeout(..., 0) = fires on next event loop tick
}
```

`state.reconnectDelay` is initialised to `0`. On the **first disconnect**, `delay = 0`, so `setTimeout(fn, 0)` fires on the very next event loop tick — effectively immediately.

Here is the exact sequence that played out on every server restart:

```
t=0ms    Server starts → autoReconnect() → connectSocket() → Socket A opens
t=~500ms Socket A establishes WebSocket with WhatsApp ✓
         Log: "[whatsapp] Connected as 918194047426"

t=~520ms WhatsApp server still has a stale TCP entry from the PREVIOUS
         server process (process died, OS closed the TCP socket, but
         WhatsApp's server-side state machine hasn't timed it out yet)
         → WhatsApp sends close frame: code 440 to Socket A

t=~520ms connection.update fires: connection="close", code=440
         state.connected = false
         scheduleReconnect(gen=1) called
         delay = state.reconnectDelay = 0
         setTimeout(connectSocket, 0)   ← fires IMMEDIATELY next tick

t=~521ms connectSocket() runs:
           dropSocket() → state.generation = 2, sock.end() on Socket A
           Socket B begins WS handshake with WhatsApp

t=~600ms Socket B establishes WebSocket with WhatsApp ✓
         Log: "[whatsapp] Connected as 918194047426"

t=~620ms WhatsApp server sees Socket A (from t=0ms) + Socket B as TWO
         simultaneous connections for the same linked device.
         The server-side cleanup of Socket A hasn't completed yet.
         → Sends code 440 to Socket B

         Repeat forever.
```

The key insight: when a Node.js process **dies**, the OS closes all its TCP connections, but **WhatsApp's server doesn't process that TCP FIN immediately**. It typically takes 2–8 seconds for WhatsApp's server-side session state to be fully released. By reconnecting at 0 ms, the new socket arrived while the old one's ghost was still alive on WhatsApp's side, guaranteeing another 440.

This created a perfect infinite loop:

```
Connect → 440 → reconnect at 0ms → connect → 440 → reconnect at 2s
→ connect → 440 → reconnect at 4s → connect → 440 → ...
```

The first reconnect (0 ms) was the worst offender. Even if the second and third had some delay, they were still affected because the session conflict on WhatsApp's server hadn't fully resolved.

---

## Why Messages Could Still Be Received Despite The Loop

Receiving worked because of timing:

1. Socket connects (`state.connected = true`)
2. Baileys immediately begins receiving pending messages during the WebSocket handshake response — this happens within milliseconds of connecting
3. Messages arrive via `messages.upsert` events which fire on the socket event emitter synchronously
4. `processMessage()` at `src/server/services/whatsapp.service.ts` runs, saves to DB, SSE broadcasts, UI updates
5. **Only then** does the 440 close frame arrive (WhatsApp's server sends it slightly after completing the handshake)

So there was a brief valid window (~20–100 ms) where the socket was open and messages could arrive. Enough for receiving. Not enough for sending, which requires:

1. Detecting `state.connected = true`
2. Calling `state.sock.sendMessage(resolved, { text })`
3. Waiting for WhatsApp to **acknowledge** the send over the WebSocket
4. Getting the message ID back in the result

That 3-step async flow across a socket that lived for ~20 ms almost always failed. The socket would close mid-await, the `sendMessage` call would throw, the error would be caught in `inbox.service.ts`'s background send handler, and `broadcastInboxEvent("send_failed", ...)` would fire. The message was already saved to the DB with a `tempId` (so the user could see it in the inbox), but it was never actually delivered.

---

## The Fix: Three Changes

### Fix 1 — Minimum 3 s reconnect delay

**File:** `src/server/services/whatsapp.service.ts` — `scheduleReconnect`

```typescript
// BEFORE
const delay = state.reconnectDelay;
state.reconnectDelay = delay === 0 ? 2_000 : Math.min(delay * 2, 30_000);
setTimeout(connectSocket, delay);  // delay=0 on first call → fires immediately

// AFTER
const delay = Math.max(state.reconnectDelay, 3_000);  // floor of 3 s always
state.reconnectDelay = Math.min(delay * 2, 30_000);
setTimeout(connectSocket, delay);  // earliest possible reconnect: 3 s
```

This guarantees at least 3 seconds between any disconnect and the next connection attempt. WhatsApp's server-side TCP cleanup typically completes in 1–3 seconds, so 3 s is enough headroom to avoid the race on normal disconnects.

---

### Fix 2 — 10 s cooldown specifically for 440

**File:** `src/server/services/whatsapp.service.ts` — `connection.update` close handler

```typescript
} else {
  settle({ connected: false });

  // 440 = connectionReplaced: WhatsApp server hasn't released the previous TCP
  // session yet. Override the delay to 10 s so the server can finish cleaning up.
  if (code === DisconnectReason.connectionReplaced || code === 440) {
    state.reconnectDelay = 10_000;
    console.log("[whatsapp] Connection replaced (440) — waiting 10 s before reconnect");
  }

  scheduleReconnect(myGen);
}
```

Why 10 s specifically for 440? Because a 440 means WhatsApp's server **actively has two sessions in conflict**. 3 s might not be enough in that scenario under load. 10 s gives comfortable margin. After the first successful reconnect following a 440, `state.reconnectDelay` is reset to `0` on `connection.update: "open"` (line `state.reconnectDelay = 0`), so future non-440 disconnects go back to the 3 s floor.

---

### Fix 3 — Retry send after mid-flight disconnect

**File:** `src/server/services/whatsapp.service.ts` — `sendMessage`

```typescript
// BEFORE
const result = await state.sock.sendMessage(resolved, { text });

// AFTER
let result: unknown;
try {
  result = await state.sock.sendMessage(resolved, { text });
} catch (sendErr) {
  // Socket may have dropped mid-send (e.g. 440 reconnect) — wait for next
  // connection and retry once rather than failing immediately
  if (!state.connected) {
    console.log("[whatsapp] Socket closed during send — waiting for reconnect before retry…");
    await waitForConnection(35_000);
    if (!state.sock) throw new Error("WhatsApp socket unavailable after reconnect");
    result = await state.sock.sendMessage(resolved, { text });
  } else {
    throw sendErr;
  }
}
```

Even with fixes 1 and 2 stopping the loop, there is a small chance the socket drops **exactly while a send is in flight** (network blip, etc.). Previously this would silently fail — the message would appear in the CRM inbox (saved with `tempId` before the send attempt) but never reach the recipient's phone. This retry catches that case: it waits up to 35 s for the socket to reconnect and then attempts the send one more time.

---

## How the Generation Counter Prevents Cascade Loops

One important safeguard in the codebase is `state.generation`. Every call to `connectSocket` bumps this counter:

```typescript
function dropSocket(): void {
  state.generation++;  // ← every new socket gets a new generation number
  ...
}
```

Every event handler captures `myGen = state.generation` at creation time and checks it before acting:

```typescript
sock.ev.on("connection.update", async (update: any) => {
  if (state.generation !== myGen) return;  // ← stale socket, ignore
  ...
});
```

This means if socket A (gen=1) gets a 440, schedules a reconnect, and socket B (gen=2) is created — any late-arriving events from socket A (gen=1) see `state.generation (2) !== myGen (1)` and exit immediately. Without this, a closing socket could trigger another reconnect on top of the one already scheduled, creating a second cascade loop.

---

## Summary Table

| Symptom | Root Cause | Fix |
|---|---|---|
| Constant connect/disconnect loop | `setTimeout(reconnect, 0)` raced WhatsApp's server-side session cleanup | Minimum 3 s delay in `scheduleReconnect` |
| Loop never settled even with backoff | Code 440 reset `reconnectDelay` progression and kept interval short | Override to 10 s specifically for 440 |
| Messages received but never sent | Socket lived ~20 ms — too short for async send handshake | Retry send once after reconnection |
| Loop didn't compound beyond one socket | `state.generation` counter made stale socket events no-ops | Already existed, no change needed |
