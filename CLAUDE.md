# Job Alert Bot — working notes for Claude

## ⚠️ Never kill the user's processes

A running GUI or pipeline run is **live work that costs real money** (Anthropic
tokens per analyzed job) and must never be interrupted. This has already gone
wrong once: a `pkill -f "server.js"` meant for a test server killed the user's
GUI, and the pipeline run it had spawned died with it — the child writes to the
parent's stdout pipe, so killing the server kills the run via EPIPE. That cost
~30 € in tokens.

**Rules:**

- **Never** use `pkill`, `killall`, or any pattern-matching kill. They match the
  user's processes too.
- Kill **only** PIDs you started yourself, captured at launch:
  `node src/server.js & PID=$!` … `kill $PID`.
- **Before starting anything**, check what is already running:
  ```bash
  lsof -nP -iTCP:3000 -sTCP:LISTEN; pgrep -fl "node (src/server|index)\.js"
  ```
- If a GUI or a run is active, **leave it alone** and use your own port + DB
  (below). Never "free up" port 3000 by killing what holds it.
- Never restart the GUI, stop a run, or clear `logs/` without being asked.

## Testing and troubleshooting: your own instance

Never test against the real GUI, the real database, or the real sources.

```bash
GUI_PORT=3999 JOBS_DB_PATH=<scratchpad>/jobs.db TELEGRAM_NOTIFICATIONS=off \
  AUTO_APPLY_ENABLED=false node src/server.js
```

- **Port**: 3999 or another free one. `3000` is the user's GUI, `3001` is the
  operator sandbox (`npm run gui:operator`) — both are theirs.
- **Database**: always a throwaway `JOBS_DB_PATH`. `data/jobs.db` holds the real
  job history.
- **Sources**: a fresh DB has a `default` client with no sources, and
  `getSources()` falls back to the real `config/jobs.json` for that client
  (`allowLegacyFallback`) — so a run will scrape the user's actual career pages.
  Seed `sources_json` on the client with a local test source instead.
- Keep `TELEGRAM_NOTIFICATIONS=off` and `AUTO_APPLY_ENABLED=false` so tests
  never message anyone or queue an application.
- Anything that reaches the analysis stage calls the Anthropic API for real.
  Abort before it, or use a source that yields few jobs.
- Clean up your own processes and scratch files when done; leave the user's
  running.

## What costs money or reaches the outside world

Never trigger any of these to "check that it works":

| Path | Effect |
|---|---|
| `analyzeJob` (`src/analyzer.js`) | One Anthropic call **per job** — a full backlog is thousands |
| `src/cover-letter.js` | Anthropic call on a stronger (pricier) model |
| `src/notifier.js` | Real Telegram messages to real people |
| `src/apply-worker.js` | Real job applications on LinkedIn/StepStone/Indeed |

## Auto-apply: the rails stay as they are

Automated applying violates the platforms' terms of service and can get the
account banned, so the safety rails are deliberate. Do not weaken any of them
without being asked in that message:

- `APPLY_DRY_RUN` is **`true` whenever unset** — forms are filled but never
  submitted.
- `PLATFORM_HARD_CAP` (LinkedIn 5, Indeed 5, StepStone 10) applies regardless of
  `APPLY_DAILY_CAP`, plus a cooldown between submissions.
- Submission always requires the user's explicit approval. Enqueuing means
  "prepare it", never "send it".

## Invariants that are easy to break

- **Multi-tenancy.** Every `jobs` / `runs` / `applications` row is scoped by
  `client_id`, and every `database.js` function takes `clientId` as its first
  argument. A query that forgets it mixes one client's data into another's —
  and with a single test client, nothing looks wrong.
- **Exactly one Telegram poller per token.** The interactive bot and the apply
  worker run in the scheduler process only (`startScheduler`). A second poller —
  including one from a test instance — breaks polling with 409 conflicts.
- **`CREDENTIALS_KEY` is unrecoverable.** Regenerating it makes every stored
  platform credential undecryptable. Never run
  `npm run generate-credentials-key` on an existing setup.

## Project

Job scraper → Claude relevance analysis → Telegram alerts → Excel export, with a
web GUI. Multi-tenant: every job, run and setting is scoped by `client_id`.

| Path | Role |
|---|---|
| `index.js` | Entry point: `--once` (single run) or scheduler mode |
| `src/scheduler.js` | `runClientPipeline` — the scrape→analyze→notify→export pipeline |
| `src/scraper.js` | Generic career-page scraper (heuristics + pagination strategies) |
| `src/scrapers/` | Platform scrapers (LinkedIn, StepStone, Indeed) + shared browser setup |
| `src/server.js` | GUI: raw `http` server, one big `if (pathname === …)` router |
| `src/database.js` | better-sqlite3, all SQL lives here |
| `src/run-control.js` | Cooperative abort flag for stopping a run |
| `public/` | Vanilla-JS front end (`app.js`, `i18n.js`, no framework, no build step) |

## Conventions

- **ESM only** (`"type": "module"`), no TypeScript, no bundler. Docker runs on
  the Playwright base image (`mcr.microsoft.com/playwright:v1.52.0-jammy`).
- **No web framework** — plain `http`, manual routing, `sendJson` helper.
  Match the surrounding style rather than introducing Express etc.
- **All SQL in `src/database.js`.** Schema changes need an idempotent
  `ALTER TABLE` migration next to the existing ones.
- **User-facing strings are German.** Log lines and API error messages are
  German; GUI strings go through `public/i18n.js` and need **both** a `de` and
  an `en` entry. Code comments and identifiers stay English.
- **Tests**: `npm test` (node:test, no framework). Keep them offline — no
  network, no real DB, no API calls.
- **Keep the dependency list small.** Eight runtime deps, and crawlee was
  recently removed. Reach for the stdlib before adding one.
- Long loops in the pipeline should check `isAborted()` at their boundary so a
  stop stays responsive.

## Changes that touch more than one place

- **A new env var lives in three places**: `.env.example`, `SETTINGS_SCHEMA` in
  `src/server.js` (otherwise it never shows up in Einstellungen), and the setup
  wizard `STEPS` in `src/setup.js` if a new user must set it. Advanced knobs may
  skip the settings form on purpose — then say so in `.env.example`.
- **Bump `SETUP_VERSION`** (`src/setup.js`) when adding a wizard step that
  existing users should be re-prompted for.
- **Log lines are colorized by regex** in `colorizeLog` (`public/app.js`):
  `ERROR|FEHLER|Failed|Fatal` → red, `skip|Rate limit|retry` → amber,
  `RELEVANT|✓|Finished|complete` → green. A harmless line containing "Failed"
  makes the GUI console look broken.

## Keep the README current

`README.md` is the only documentation users have — it must never lag behind the
code. Update it **in the same commit** as the change, not afterwards:

- New or changed GUI behavior → the tab table in the GUI section.
- New env var, npm script, or per-source config field → its table.
- Changed setup, Docker, or backup steps → the matching section.

Documented behavior that no longer matches the code is a bug like any other.

## Data that must never leave the machine

`.env`, `config/profile.json`, `data/*.db` and `logs/` are gitignored and
personal. Never commit them, never paste their contents into a PR or issue, and
keep `config/profile.example.json` an anonymous placeholder.

## Git

- **No Claude attribution.** No `Co-Authored-By` trailer, no "Generated with"
  footer — in commits or PR bodies. Commits show Julian Friedle only.
- Never `git push` or open a PR unless asked in that message. Local commits on a
  feature branch are fine.
- Branch off `main`; don't commit directly to it.
