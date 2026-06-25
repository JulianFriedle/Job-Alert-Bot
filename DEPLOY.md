# Deployment (SaaS) & private use

This project runs from **one codebase** in two modes — the difference is only
configuration (env vars), never a fork:

| | Private (localhost) | SaaS (Unraid + NGINX/Authelia) |
|---|---|---|
| `AUTH_ENABLED` | `false` | `true` |
| Clients | one ("Privat") | many, created in the GUI |
| Anthropic key / Telegram bot | yours | operator's, shared by all clients |

The multi-tenant model is the general case; your private use is simply the single
default client. See the model details in [src/database.js](src/database.js) and
[src/client-config.js](src/client-config.js).

---

## 1. One-time migration (existing installs)

Converts the single-user DB to multi-tenant and imports your current
profile/sources/filters/prompts + Telegram chat id into the default "Privat"
client. Safe and idempotent (backup `data/jobs.db` first if you like).

```bash
npm install
npm run migrate
```

Fresh installs need nothing — the schema is created multi-tenant from the start.

## 2. Private use (unchanged workflow)

```bash
# .env: AUTH_ENABLED=false (or unset)
npm run gui          # dashboard on http://localhost:3000, no login
npm run run-once     # one pipeline pass across enabled clients (just you)
npm start            # hourly scheduler
```

Your Telegram alerts keep coming exactly as before; your CV now lives in the DB
row and is edited in the same **Profil** tab.

## 3. SaaS on Unraid (Docker + NGINX + Authelia)

### 3.1 Operator credentials

```bash
npm run hash-password -- "<dein-betreiber-passwort>"   # → OPERATOR_PASSWORD_HASH=…
```

Create a `.env` next to `docker-compose.yml`:

```env
AUTH_ENABLED=true
OPERATOR_USER=admin
OPERATOR_PASSWORD_HASH=scrypt$....            # from hash-password
SESSION_SECRET=<langer-zufallsstring>          # e.g. `openssl rand -hex 32`
ANTHROPIC_API_KEY=sk-ant-...
TELEGRAM_BOT_TOKEN=123456:ABC...               # ONE bot for all clients
```

### 3.2 Start

```bash
docker compose up -d --build
```

This starts two containers sharing `./data`:
- **gui** — dashboard on port 3000 (the operator logs in here)
- **scheduler** — runs the hourly pipeline across all enabled clients

### 3.3 NGINX + Authelia

Put your reverse proxy in front of the **gui** container (port 3000) and protect
it with Authelia SSO. Sketch:

```nginx
location / {
    include /config/nginx/authelia-location.conf;   # Authelia auth_request
    proxy_pass http://job-alert-gui:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
}
```

The app's own login (`AUTH_ENABLED=true`) is a **second layer** behind Authelia —
the app never trusts the network on its own.

## 4. Managing clients (operator)

In the **Klienten** tab: create a client, set its Telegram chat id, then switch to
that client (top-right selector) and fill its **Profil**, **Quellen**, **Filter**
and **Prompts**. Use **Telegram-Test** to confirm the chat id. Clients receive
Telegram alerts only — they have no GUI access.

To get a client's chat id: have them start your bot in Telegram and read the chat
id (e.g. via `@userinfobot` or the bot's `getUpdates`).

---

### Environment reference (most are also editable in the GUI **Einstellungen** tab)

| Var | Scope | Notes |
|---|---|---|
| `AUTH_ENABLED` | global | `true` enables operator login. Restart to apply. |
| `OPERATOR_USER` / `OPERATOR_PASSWORD_HASH` | global | login credentials (`npm run hash-password`). |
| `SESSION_SECRET` | global | signs sessions; set a stable value or logins drop on restart. |
| `ANTHROPIC_API_KEY` | global | one key for all clients. |
| `TELEGRAM_BOT_TOKEN` | global | one bot; each client has its own chat id. |
| `JOBS_DB_PATH` | global | SQLite path (Docker volume). |
| `CRON_SCHEDULE` | global | scheduler cadence (default hourly). |
| profile / sources / filters / prompts / chat id | per client | stored in the DB, edited in the GUI. |
