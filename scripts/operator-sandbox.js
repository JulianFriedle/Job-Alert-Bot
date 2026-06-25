// ── Operator (SaaS) sandbox launcher ─────────────────────────────────────────
// Starts a SECOND, fully isolated GUI instance to test the operator/multi-client
// experience WITHOUT touching your private setup:
//   • separate port (default 3001) — your private `npm run gui` on :3000 keeps running
//   • separate DB under data/operator-sandbox/ — a clean snapshot of your real DB,
//     so it has real data but creating/deleting test clients never affects the original
//   • AUTH_ENABLED=true with throwaway login credentials
//
// Usage:
//   npm run gui:operator              # snapshot real DB on first run, then reuse it
//   npm run gui:operator -- --fresh   # start from an empty DB (only the default client)
//   npm run gui:operator -- --reset   # delete the sandbox DB and re-snapshot
//
// Override defaults via env: OPERATOR_PORT, OPERATOR_USER, OPERATOR_PASSWORD.
// Shared keys (ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN) are loaded from your normal
// .env so analysis and the Telegram test actually work.

import Database from 'better-sqlite3';
import { mkdirSync, existsSync, rmSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const REAL_DB = path.join(ROOT, 'data', 'jobs.db');
const SANDBOX_DIR = path.join(ROOT, 'data', 'operator-sandbox');
const SANDBOX_DB = path.join(SANDBOX_DIR, 'jobs.db');

const args = process.argv.slice(2);
const FRESH = args.includes('--fresh');
const RESET = args.includes('--reset');

function log(msg) { console.log(`[operator-sandbox] ${msg}`); }

mkdirSync(SANDBOX_DIR, { recursive: true });

if (RESET) {
  for (const ext of ['', '-wal', '-shm']) {
    const f = SANDBOX_DB + ext;
    if (existsSync(f)) rmSync(f);
  }
  log('Sandbox DB reset.');
}

// Seed the sandbox from a clean, consistent snapshot of the real DB (WAL-safe via
// better-sqlite3's online backup). Only on first run / after --reset; skipped with
// --fresh or when no real DB exists yet.
if (!existsSync(SANDBOX_DB)) {
  if (!FRESH && existsSync(REAL_DB)) {
    log('Snapshotting your real DB into the sandbox (your original is untouched)…');
    const src = new Database(REAL_DB, { readonly: true });
    await src.backup(SANDBOX_DB);
    src.close();
    log('Snapshot done.');
  } else {
    log(FRESH ? 'Starting from an empty sandbox DB (--fresh).' : 'No real DB found — starting empty.');
  }
} else {
  log('Reusing existing sandbox DB. (--reset to re-snapshot, --fresh ignored once it exists.)');
}

// Operator config — set BEFORE importing the server. dotenv (loaded inside the
// server) does not override already-set vars, so these win while your real
// ANTHROPIC_API_KEY / TELEGRAM_BOT_TOKEN are still pulled from .env.
const PORT = process.env.OPERATOR_PORT || '3001';
const USER = process.env.OPERATOR_USER || 'admin';
const PASSWORD = process.env.OPERATOR_PASSWORD || 'operator';

process.env.JOBS_DB_PATH = SANDBOX_DB;
process.env.GUI_PORT = PORT;
process.env.AUTH_ENABLED = 'true';
process.env.OPERATOR_USER = USER;
// Plaintext password is fine for a local sandbox; production uses OPERATOR_PASSWORD_HASH.
process.env.OPERATOR_PASSWORD = PASSWORD;
// Stable secret so logins survive restarts of the sandbox.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'operator-sandbox-secret';

log('──────────────────────────────────────────────');
log(`Operator GUI  →  http://localhost:${PORT}`);
log(`Login         →  user: ${USER}   password: ${PASSWORD}`);
log(`Sandbox DB    →  ${path.relative(ROOT, SANDBOX_DB)}`);
log('Your private GUI on :3000 and real data are unaffected.');
log('──────────────────────────────────────────────');

// Boot the normal server with the sandbox environment.
await import('../src/server.js');
