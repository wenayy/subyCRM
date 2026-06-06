# Matrix Bridge Setup — Real-time X & LinkedIn DMs

Two options: **local Docker** (for testing) or **Railway production**.

---

## Architecture

```
Twitter/LinkedIn servers
        ↓
 [mautrix-twitter]   [mautrix-linkedin]
        ↓                    ↓
   [Conduit — Matrix homeserver]
              ↓
   PUT /api/matrix/transactions/:txnId
              ↓
       [Your CRM backend]
              ↓
          Inbox ✓
```

---

## Option A — Local Docker (test it first)

### 1. Create `docker-compose.matrix.yml` at your project root

```yaml
version: "3.9"

services:
  conduit:
    image: matrixconduit/matrix-conduit:latest
    ports:
      - "6167:6167"
    environment:
      CONDUIT_SERVER_NAME: localhost
      CONDUIT_DATABASE_BACKEND: rocksdb
      CONDUIT_MAX_REQUEST_SIZE: "20000000"
      CONDUIT_ALLOW_REGISTRATION: "false"
      CONDUIT_ALLOW_GUESTS: "false"
      CONDUIT_PORT: "6167"
    volumes:
      - conduit-data:/var/lib/matrix-conduit

  mautrix-twitter:
    build: ./railway/mautrix-twitter
    ports:
      - "29327:29327"
    environment:
      HOMESERVER_URL: http://conduit:6167
      MATRIX_DOMAIN: localhost
      TWITTER_BRIDGE_URL: http://mautrix-twitter:29327
      TWITTER_AS_TOKEN: "changeme-twitter-as-token-32chars"
      TWITTER_HS_TOKEN: "changeme-twitter-hs-token-32chars"
      DATABASE_URL: "postgresql://USER:PASS@host.docker.internal:5432/suby"
    volumes:
      - twitter-data:/data
    depends_on:
      - conduit

  mautrix-linkedin:
    build: ./railway/mautrix-linkedin
    ports:
      - "29328:29328"
    environment:
      HOMESERVER_URL: http://conduit:6167
      MATRIX_DOMAIN: localhost
      LINKEDIN_BRIDGE_URL: http://mautrix-linkedin:29328
      LINKEDIN_AS_TOKEN: "changeme-linkedin-as-token-32chars"
      LINKEDIN_HS_TOKEN: "changeme-linkedin-hs-token-32chars"
      DATABASE_URL: "postgresql://USER:PASS@host.docker.internal:5432/suby"
    volumes:
      - linkedin-data:/data
    depends_on:
      - conduit

volumes:
  conduit-data:
  twitter-data:
  linkedin-data:
```

Replace `DATABASE_URL` with your local Postgres connection string.
Use `host.docker.internal` instead of `localhost` inside Docker to reach your Mac's Postgres.

### 2. Add env vars to your local `.env`

```bash
MATRIX_AS_TOKEN=changeme-twitter-as-token-32chars
MATRIX_BRIDGE_OWNER_USER_ID=<your user id from DB>
```

Get your user ID:
```bash
npx prisma studio
# or: psql your-db -c "SELECT id, email FROM users LIMIT 5;"
```

### 3. Start the bridges

```bash
docker compose -f docker-compose.matrix.yml up --build
```

### 4. Register the bridges with Conduit

The bridges generate `/data/registration.yaml` when they first start.
You need to tell Conduit about them. The easiest way: add this to the Conduit environment:

```yaml
# add to conduit service in docker-compose.matrix.yml
CONDUIT_REGISTRATION_FILES: "/registrations/twitter.yaml,/registrations/linkedin.yaml"
```

Then copy the registration files out of the containers:
```bash
docker cp $(docker compose -f docker-compose.matrix.yml ps -q mautrix-twitter):/data/registration.yaml ./registrations/twitter.yaml
docker cp $(docker compose -f docker-compose.matrix.yml ps -q mautrix-linkedin):/data/registration.yaml ./registrations/linkedin.yaml
```

Then add a volume mount to Conduit in docker-compose.matrix.yml:
```yaml
  conduit:
    volumes:
      - conduit-data:/var/lib/matrix-conduit
      - ./registrations:/registrations:ro  # add this line
```

Restart: `docker compose -f docker-compose.matrix.yml restart conduit`

### 5. Connect your Twitter account

DM the bridge bot using Element (element.io — free, works in browser):
1. Go to element.io → Sign in → use server: `http://localhost:6167`
2. Create account (any username/password since registration is off — wait, you need to enable it once)

Easier: use the bridge's built-in login command directly:
```bash
# Open a shell in the twitter bridge container
docker compose -f docker-compose.matrix.yml exec mautrix-twitter /bin/sh
# The bridge logs will show you the login URL
```

Or just watch the logs — the bridge will print instructions:
```bash
docker compose -f docker-compose.matrix.yml logs -f mautrix-twitter
```

---

## Option B — Railway Production (two accounts)

### Account layout

| Account | Services |
|---------|----------|
| Account A (existing) | CRM backend, Redis, Postgres |
| Account B (new) | Conduit, mautrix-twitter, mautrix-linkedin, Postgres (for bridges) |

The bridges reach your CRM via Account A's **public URL** (not private networking — that only works within one account).

---

### Account B — Step 1: Create a new Railway project

Go to railway.app → New Project → Empty Project. Name it "suby-matrix-bridges".

---

### Account B — Step 2: Add Postgres for bridge data

New Service → Database → PostgreSQL.

After it provisions, click it → **Variables** tab → copy the `DATABASE_URL` value. You'll paste this into both bridge services.

---

### Account B — Step 3: Add Conduit

New Service → Docker Image → paste:
```
matrixconduit/matrix-conduit:latest
```

Click the service → **Variables** tab → add:

| Variable | Value |
|----------|-------|
| `CONDUIT_SERVER_NAME` | `conduit.up.railway.app` ← use the domain Railway assigns (see Settings → Domains) |
| `CONDUIT_DATABASE_BACKEND` | `rocksdb` |
| `CONDUIT_MAX_REQUEST_SIZE` | `20000000` |
| `CONDUIT_ALLOW_REGISTRATION` | `false` |
| `CONDUIT_ALLOW_GUESTS` | `false` |
| `CONDUIT_PORT` | `6167` |

Click the service → **Settings** → **Domains** → Generate Domain. It'll look like:
`conduit-production-xxxx.up.railway.app`

Copy this URL — you need it in the next steps.

Add a Volume: Settings → Volumes → Mount Path: `/var/lib/matrix-conduit`

---

### Account B — Step 4: Add mautrix-twitter

New Service → GitHub Repo → select your repo → set **Root Directory** to:
```
railway/mautrix-twitter
```

Variables:

| Variable | Value | Notes |
|----------|-------|-------|
| `HOMESERVER_URL` | `https://conduit-production-xxxx.up.railway.app` | Conduit's public URL from step 3 |
| `MATRIX_DOMAIN` | `conduit-production-xxxx.up.railway.app` | Same domain, no https:// |
| `TWITTER_BRIDGE_URL` | `https://mautrix-twitter-production-xxxx.up.railway.app` | This service's own domain (set after generating it) |
| `TWITTER_AS_TOKEN` | generate below | Random secret string |
| `TWITTER_HS_TOKEN` | generate below | Different random secret string |
| `DATABASE_URL` | paste from Account B Postgres | From step 2 |

Generate tokens — run this in terminal:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# run twice — one for AS_TOKEN, one for HS_TOKEN
```

Add Volume: Mount Path `/data`

Generate a domain for this service (Settings → Domains) and paste it back into `TWITTER_BRIDGE_URL`.

---

### Account B — Step 5: Add mautrix-linkedin

Same as step 4 but Root Directory = `railway/mautrix-linkedin`.

Variables:

| Variable | Value |
|----------|-------|
| `HOMESERVER_URL` | `https://conduit-production-xxxx.up.railway.app` |
| `MATRIX_DOMAIN` | `conduit-production-xxxx.up.railway.app` |
| `LINKEDIN_BRIDGE_URL` | `https://mautrix-linkedin-production-xxxx.up.railway.app` |
| `LINKEDIN_AS_TOKEN` | generate (different from Twitter tokens) |
| `LINKEDIN_HS_TOKEN` | generate |
| `DATABASE_URL` | same Postgres from step 2 |

Add Volume: Mount Path `/data`

---

### Account B — Step 6: Register bridges with Conduit

After both bridges start, their `/data/registration.yaml` files are generated.
Railway doesn't have SSH by default, but the registration files contents are predictable — they match exactly what the entrypoint.sh writes.

You can reconstruct them manually. For twitter, the file looks like:
```yaml
id: twitter
url: https://mautrix-twitter-production-xxxx.up.railway.app
as_token: <your TWITTER_AS_TOKEN value>
hs_token: <your TWITTER_HS_TOKEN value>
sender_localpart: twitterbot
rate_limited: false
namespaces:
  users:
    - exclusive: true
      regex: "@twitter_.+:conduit-production-xxxx.up.railway.app"
  aliases: []
  rooms: []
```

For linkedin, same but with linkedin values.

To register these with Conduit, add env vars to the Conduit service:
```
CONDUIT_REGISTRATION_FILES=/registrations/twitter.yaml,/registrations/linkedin.yaml
```

Then mount the files — easiest way is to add them as env vars and have a small wrapper. Alternatively, use the Conduit admin API (advanced).

> **Shortcut**: Many mautrix bridge versions auto-register with the homeserver on first start if you set `HOMESERVER_URL` correctly and the tokens match. Check the bridge logs — if you see "Registered as application service" it worked automatically.

---

### Account A — Step 7: Add env vars to your CRM

Go to your Account A Railway project → your backend service → Variables:

| Variable | Value |
|----------|-------|
| `MATRIX_AS_TOKEN` | Paste your `TWITTER_AS_TOKEN` value (the bridges use this to authenticate to your CRM webhook) |
| `MATRIX_BRIDGE_OWNER_USER_ID` | Your user ID from the CRM database |

To get your user ID, connect to your Account A Postgres and run:
```sql
SELECT id, email FROM "contacts"."users" LIMIT 10;
```

> Note: `MATRIX_AS_TOKEN` must match what you set as `TWITTER_AS_TOKEN` on Account B. The CRM validates this header to accept webhook calls from the bridges.

---

### Account A — Step 8: Make the CRM webhook reachable

Your CRM backend must be publicly reachable. The webhook URL the bridges call is:
```
https://your-crm-domain.up.railway.app/api/matrix/transactions/:txnId
```

The bridges push to Conduit → Conduit forwards to this URL. Make sure your CRM has a Railway domain generated (it already does if your app is deployed).

---

### Step 9: Connect your accounts (one-time login per bridge)

Once everything is running, DM the bridge bots to link your accounts:

**For Twitter:**
1. Go to [element.io](https://app.element.io) → Sign In → use Custom Server → enter your Conduit URL
2. Create an account (you'll need to temporarily set `CONDUIT_ALLOW_REGISTRATION=true`, create account, then set it back to false)
3. Find user `@twitterbot:your-conduit-domain` and send a DM
4. Type `!tw login` and follow the instructions (it'll ask for cookies or show a QR)

**For LinkedIn:**
1. Same Element setup
2. DM `@linkedinbot:your-conduit-domain`
3. Type `!li login` and follow instructions

After login, both bridges stay connected permanently and push new DMs in real-time to your inbox.

---

## Quick Token Generator

Run this once to generate all 4 tokens you need:
```bash
node -e "
  const c = require('crypto');
  console.log('TWITTER_AS_TOKEN=' + c.randomBytes(32).toString('hex'));
  console.log('TWITTER_HS_TOKEN=' + c.randomBytes(32).toString('hex'));
  console.log('LINKEDIN_AS_TOKEN=' + c.randomBytes(32).toString('hex'));
  console.log('LINKEDIN_HS_TOKEN=' + c.randomBytes(32).toString('hex'));
"
```

Copy the output and paste into the Railway Variable panels.

---

## What flows after setup

1. Someone DMs you on X → mautrix-twitter picks it up → pushes to Conduit → Conduit calls `PUT /api/matrix/transactions/:id` on your CRM → contact auto-created if new → message appears in Inbox.
2. Same for LinkedIn DMs.
3. Real-time, no polling, no cookie expiry issues.


! docker run -d --name redis-local -p 6379:6379 redis:alpine
! docker compose -f docker-compose.matrix.yml up --build
