# Engineering Concepts — Suby CRM

A running log of real problems hit during this build and the concepts behind them.
Each section is written so you can explain it in a technical interview.

---

## 1. OAuth State Parameter & state_mismatch

### What is the `state` parameter?

OAuth 2.0 has a step where your backend sends the user to Google with a URL like:

```
https://accounts.google.com/o/oauth2/auth
  ?client_id=...
  &redirect_uri=https://yourapp.com/callback
  &state=abc123xyz
```

The `state` value is a random string your server generated. Google will echo it back unchanged in the redirect:

```
https://yourapp.com/callback?code=...&state=abc123xyz
```

Your server then checks: does the `state` in the URL match what I originally generated?
If yes → proceed. If no → `state_mismatch` error.

**Why does this exist?** It's a CSRF protection. Without it, an attacker could trick a user into completing someone else's OAuth flow and linking the attacker's Google account to the victim's session.

### How is the state stored between requests?

The server generates `state`, stores it in a **cookie** on the user's browser, then redirects to Google. When Google redirects back, the browser sends that cookie. The server reads the cookie, compares it to the state in the URL.

This is the critical constraint: **the state cookie must be readable on the same domain that handles the callback.**

---

## 2. The Cross-Domain Cookie Problem (why state_mismatch happened here)

### Our architecture

```
Browser → suby-crm.vercel.app    (Next.js frontend, deployed on Vercel)
Browser → subycrm.up.railway.app (Express API, deployed on Railway)
```

### What happened without the fix

1. User clicks "Continue with Google" on `suby-crm.vercel.app`
2. Frontend calls `subycrm.up.railway.app/api/auth/sign-in/social` directly
3. Better-auth (running on Railway) generates `state=abc123`, stores it in a cookie
4. That cookie is set on domain: `subycrm.up.railway.app`
5. Browser follows redirect to Google
6. Google redirects back to `subycrm.up.railway.app/api/auth/callback/google?state=abc123`
7. Browser sends the Railway cookie ✓ — this part works

But the real problem was: auth was being initiated from the Vercel domain. The browser made the initial request through Vercel's domain, so the cookie got set on `suby-crm.vercel.app`. Then the callback hit Railway's domain. Browser doesn't send `suby-crm.vercel.app` cookies to Railway. **state_mismatch.**

### The rule

> Cookies are scoped to a domain. A cookie set on domain A is never sent to domain B.
> Both the start and end of an OAuth flow must happen on the same domain.

---

## 3. The Proxy Pattern — Solving Cross-Domain Auth

### What is a reverse proxy?

A reverse proxy sits in front of a server and forwards requests to it on behalf of the client. The client only ever talks to the proxy — it never knows about the real server behind it.

```
Browser → Proxy → Real Server
                ↑
         Browser doesn't know this exists
```

### How we used it in Next.js

In `next.config.ts`:

```ts
rewrites: async () => [
  {
    source: "/api/auth/:path*",
    destination: `${API_URL}/api/auth/:path*`,
  },
]
```

This tells Vercel's Next.js server: any request to `suby-crm.vercel.app/api/auth/*` should be forwarded server-side to `subycrm.up.railway.app/api/auth/*`.

**Key word: server-side.** The browser never sees a redirect. It just talks to `suby-crm.vercel.app` the whole time.

### Why this fixes state_mismatch

With the proxy in place:

1. Browser calls `suby-crm.vercel.app/api/auth/sign-in/social`
2. Vercel forwards to Railway — Railway generates state, returns Set-Cookie
3. Cookie is set on `suby-crm.vercel.app` (because the browser only talked to Vercel)
4. `AUTH_BASE_URL = https://suby-crm.vercel.app` → callback URL is `suby-crm.vercel.app/api/auth/callback/google`
5. Google redirects to `suby-crm.vercel.app/api/auth/callback/google?state=abc123`
6. Browser sends the cookie (same domain ✓)
7. Vercel proxy forwards to Railway — Railway reads the state, it matches ✓

The entire auth flow stays on one domain from the browser's perspective.

### AUTH_BASE_URL must match where the cookie is

`AUTH_BASE_URL` tells better-auth what URL to put in the `redirect_uri` parameter when it calls Google. If that URL is Railway's domain, Google sends the user to Railway, browser doesn't send the Vercel cookie, state_mismatch. So `AUTH_BASE_URL` must be the Vercel URL — the domain the browser actually talks to.

---

## 4. SameSite Cookie Policy

Browsers have a security policy called `SameSite` that controls when cookies are sent cross-site.

| SameSite value | When cookie is sent |
|---|---|
| `Strict` | Only on same-site requests |
| `Lax` (default) | Same-site + top-level navigations (GET only) |
| `None` | All requests, but requires `Secure` (HTTPS only) |

OAuth callbacks are top-level navigations (the browser follows a redirect). With `SameSite=Lax`, the state cookie will be sent on the redirect back from Google **as long as it's a GET and it's going to the same site the cookie was set on.**

This is why the domain must match — even `SameSite=Lax` won't send the cookie to a different domain.

---

## 5. prisma db push vs Pooler URLs

### Transaction-mode vs Session-mode poolers

Supabase uses PgBouncer as a connection pooler. It has two modes:

- **Transaction mode (port 6543):** Each query can be on a different connection. Stateless. Doesn't support prepared statements or DDL (schema changes).
- **Session mode (port 5432 on pooler host):** One connection per client session. Supports everything a direct connection does.

### Why `prisma db push` hung forever

`prisma db push` runs DDL operations (CREATE TABLE, ALTER TABLE, etc.) to sync the schema. DDL requires a stable session-level connection. When run against a transaction-mode pooler (port 6543), PgBouncer can't fulfill the request — it just stalls indefinitely.

**The fix:** Remove `prisma db push` from the startup command. The schema is already in sync from running it locally. For production schema changes, run them as a separate manual step using the direct connection URL, or during the build phase (not startup).

### The rule

> Never run schema migrations against a transaction-mode pooler.
> Use the direct connection URL for `prisma migrate deploy` or `prisma db push`.
> Use the pooler URL for normal application queries (SELECT, INSERT, UPDATE).

---

## 6. Build-time vs Runtime Environment Variables in Next.js

### Two categories of env vars in Next.js

**Runtime (server-side only):**
- Available in API routes, `getServerSideProps`, Server Components
- Never exposed to the browser
- Can be changed without rebuilding — Next.js reads them at request time
- Example: `DATABASE_URL`, `API_SECRET`

**Build-time (`NEXT_PUBLIC_` prefix):**
- Inlined into the JavaScript bundle at build time
- Available in both browser and server code
- **Changing them requires a rebuild to take effect**
- Example: `NEXT_PUBLIC_API_URL`

### Why this caused the 404 bug

`next.config.ts` runs at build time. It reads `process.env.NEXT_PUBLIC_API_URL` to configure the rewrite destination. If that variable wasn't set in Vercel when the build ran, the rewrite baked in `localhost:4002` as the destination — permanently — until the next build.

Setting the variable in Vercel's dashboard doesn't help until you trigger a new deployment so Next.js can rebuild with the correct value.

**The rule:**
> If you change a `NEXT_PUBLIC_` variable in Vercel, always redeploy. The old build doesn't know about the new value.

---

## 7. PORT Environment Variable on Railway

Railway injects a `PORT` environment variable into every running service. Its value is the port Railway's internal proxy will forward HTTP traffic to. The app **must** listen on exactly this port.

When you click "Generate Domain" in Railway and enter a port number (e.g. 4002), Railway sets `PORT=4002` and its proxy routes traffic to port 4002 on your container.

If your app hardcodes a different port:
```ts
const PORT = process.env.API_PORT || 4002; // API_PORT not set → listens on 4002
```
But Railway's proxy is forwarding to port 8080 (if that's what you entered) → **502 Bad Gateway.**

**The fix:**
```ts
const PORT = process.env.PORT || process.env.API_PORT || 4002;
```
Always prefer `process.env.PORT` first so Railway's injected value takes precedence.

---

## 8. Why All API Calls Must Go Through the Proxy (Session Cookie Scope)

### The problem

After fixing auth (OAuth flow through Vercel proxy), the app still got 401 Unauthorized on every other API call — `/api/gmail/connect-url`, `/api/contacts`, etc.

The network tab showed:
```
Request URL: https://subycrm-production.up.railway.app/api/gmail/connect-url
Status: 401 Unauthorized
```

The frontend was calling Railway directly. But the session cookie (set during login) lives on `suby-crm.vercel.app`. Cookies are never sent to a different domain — so Railway never received the session, and `requireAuth` middleware rejected every request.

### Why credentials: 'include' doesn't fix it

A common misconception: "just add `credentials: 'include'` to fetch calls and the cookie will be sent."

This only works for cookies that belong to the **target domain**. The session cookie is on `suby-crm.vercel.app`. A fetch to `subycrm-production.up.railway.app` with `credentials: 'include'` sends cookies that belong to Railway's domain — not Vercel's domain. The session cookie never leaves Vercel's domain.

### The fix: proxy all /api/* not just /api/auth/*

```ts
// next.config.ts — before (broken)
rewrites: async () => [
  { source: "/api/auth/:path*", destination: `${API_URL}/api/auth/:path*` },
]

// next.config.ts — after (fixed)
rewrites: async () => [
  { source: "/api/:path*", destination: `${API_URL}/api/:path*` },
]
```

Now every API call stays on `suby-crm.vercel.app` from the browser's perspective. Vercel forwards it server-side to Railway. The session cookie is sent on every request. Railway reads it, validates the session, and authorises the request.

### The general rule

> In a split frontend/backend deployment, if auth cookies are set on the frontend domain, ALL backend API calls must go through the frontend's proxy — not directly to the backend. Otherwise the backend never sees the session.

---

*More concepts will be added as new problems are encountered.*
