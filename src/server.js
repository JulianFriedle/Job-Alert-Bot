import 'dotenv/config';
import http from 'http';
import { readFile, writeFile, stat } from 'fs/promises';
import { createReadStream, createWriteStream, readFileSync } from 'fs';
import { spawn } from 'child_process';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  getRelevantJobs, getJobById, setApplicationStatus,
  clearApplicationStatus, markIrrelevant,
  getLatestRunOverview, getAllTimeBySource, getApplicationActivity,
  getAppliedByCompany, getStatusBreakdown, getRunHistory, getRecentRuns, getTotals,
  getClients, getClient, createClient, updateClient, deleteClient,
  DEFAULT_CLIENT_ID,
} from './database.js';
import {
  createBackup, listBackups, resolveBackupPath, ingestUpload,
  maybeRunDailyBackup, isDailyEnabled, retentionDays, BACKUP_DIR,
} from './backup.js';
import { restoreFromBackup } from './database.js';
import { generateCoverLetter } from './cover-letter.js';
import { sendTelegramTest } from './notifier.js';
import { handleSetupApi } from './setup.js';
import { DEFAULT_PROMPTS, PROMPT_FIELDS, minimizePromptOverrides } from './prompts.js';
import { getProfile, getSources, getFilters, getPrompts } from './client-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const ENV_FILE = path.join(ROOT, '.env');
const PORT = process.env.GUI_PORT || 3000;

// App version shown in the GUI footer — read once from package.json (maintained
// manually). Falls back to an empty string if it can't be read.
const APP_VERSION = (() => {
  try { return JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version || ''; }
  catch { return ''; }
})();

// ── Operator authentication ─────────────────────────────────────────────────
// Disabled by default (private/localhost). On the SaaS deployment set
// AUTH_ENABLED=true; the operator logs in with OPERATOR_USER + password. A signed,
// stateless cookie carries the session. This sits *behind* NGINX/Authelia as a
// second layer — the app never trusts the network alone.
const AUTH_ENABLED = ['true', '1', 'on', 'yes'].includes(
  String(process.env.AUTH_ENABLED || '').trim().toLowerCase()
);
const OPERATOR_USER = process.env.OPERATOR_USER || 'admin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

// Multi-tenant clients UI. Off by default → a private/single-user install sees no
// client management at all (the app still operates on the default client behind
// the scenes). Read at request time so the Einstellungen toggle takes effect on
// the next page load, without restarting the service.
function clientsEnabled() {
  return ['true', '1', 'on', 'yes'].includes(
    String(process.env.CLIENTS_ENABLED || '').trim().toLowerCase()
  );
}
// Stable across restarts when SESSION_SECRET is set; otherwise random (sessions
// drop on restart, which is acceptable for a single operator).
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

function signSession(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifySession(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

// Verify a password against OPERATOR_PASSWORD_HASH (scrypt$salt$hash) or, as a
// convenience for self-host, plaintext OPERATOR_PASSWORD.
function verifyPassword(password) {
  const hash = process.env.OPERATOR_PASSWORD_HASH;
  if (hash && hash.startsWith('scrypt$')) {
    const [, saltHex, keyHex] = hash.split('$');
    try {
      const derived = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 32);
      const expected = Buffer.from(keyHex, 'hex');
      return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
    } catch { return false; }
  }
  const plain = process.env.OPERATOR_PASSWORD;
  if (plain) return password === plain;
  return false;
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthenticated(req) {
  if (!AUTH_ENABLED) return true;
  return Boolean(verifySession(parseCookies(req).session));
}

// Whether the session cookie should carry the `Secure` flag (browser only sends
// it over HTTPS). Explicit override via SESSION_COOKIE_SECURE; otherwise auto:
// on when reached over HTTPS (X-Forwarded-Proto from the TLS proxy) or via a real
// hostname, off for localhost so the local sandbox keeps working over plain HTTP.
function cookieIsSecure(req) {
  const override = String(process.env.SESSION_COOKIE_SECURE || '').trim().toLowerCase();
  if (['true', '1', 'on', 'yes'].includes(override)) return true;
  if (['false', '0', 'off', 'no'].includes(override)) return false;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  if (proto) return proto === 'https';
  return !/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(String(req.headers.host || ''));
}

// Build a session Set-Cookie header with consistent, hardened flags.
function sessionCookie(value, maxAgeSec, req) {
  const flags = ['HttpOnly'];
  if (cookieIsSecure(req)) flags.push('Secure');
  flags.push('SameSite=Lax', 'Path=/', `Max-Age=${maxAgeSec}`);
  return `session=${value}; ${flags.join('; ')}`;
}

// ── Settings schema ─────────────────────────────────────────────────────────
// Single source of truth for every variable shown in the GUI "Einstellungen" tab.
// type: 'secret' (never sent to the browser), 'text', or 'int'.
const SETTINGS_SCHEMA = [
  { key: 'ANTHROPIC_API_KEY', group: 'Schlüssel & Telegram', label: 'Anthropic API Key', type: 'secret', required: true,
    help: 'API-Schlüssel von console.anthropic.com' },
  { key: 'TELEGRAM_BOT_TOKEN', group: 'Schlüssel & Telegram', label: 'Telegram Bot Token', type: 'secret',
    help: 'Bot-Token von @BotFather (optional – leer lassen, wenn Telegram nicht genutzt wird)' },
  { key: 'TELEGRAM_CHAT_ID', group: 'Schlüssel & Telegram', label: 'Telegram Chat ID', type: 'secret',
    help: 'Deine Chat-ID für Benachrichtigungen (optional)' },
  { key: 'TELEGRAM_NOTIFICATIONS', group: 'Schlüssel & Telegram', label: 'Telegram aktiv', type: 'text', default: 'on',
    help: "Auf 'off' setzen, um Telegram-Benachrichtigungen abzuschalten – relevante Jobs bleiben in der GUI sichtbar" },
  { key: 'EXPIRY_NOTIFICATIONS', group: 'Schlüssel & Telegram', label: 'Ablauf-Benachrichtigungen', type: 'text', default: 'on',
    help: "Auf 'off' setzen, um keine Telegram-Nachrichten für ausgelaufene Jobs zu senden – neue Jobs werden weiterhin gemeldet" },

  { key: 'ANALYZER_MODEL', group: 'KI-Modelle', label: 'Analyse-Modell', type: 'text', default: 'claude-haiku-4-5-20251001',
    help: 'Claude-Modell zur Relevanz-Bewertung (günstig/schnell empfohlen)' },
  { key: 'COVER_LETTER_MODEL', group: 'KI-Modelle', label: 'Anschreiben-Modell', type: 'text', default: 'claude-sonnet-4-6',
    help: 'Claude-Modell für Anschreiben (stärkeres Modell empfohlen)' },

  { key: 'MIN_RELEVANCE_SCORE', group: 'Analyse & Filter', label: 'Min. Relevanz-Score', type: 'int', default: '4', min: 1, max: 10,
    help: 'Mindest-Score (1–10), ab dem ein Job als relevant gilt' },
  { key: 'EXPIRY_THRESHOLD_HOURS', group: 'Analyse & Filter', label: 'Ablauf-Schwelle (Std.)', type: 'int', default: '72', min: 1, max: 8760,
    help: 'Stunden ohne erneute Sichtung, bis ein gemeldeter Job als abgelaufen markiert wird' },

  { key: 'ANALYSIS_CONCURRENCY', group: 'Performance', label: 'Analyse-Parallelität', type: 'int', default: '2', min: 1, max: 20,
    help: 'Parallele Claude-Analysen (vorsichtig erhöhen – Rate-Limits)' },
  { key: 'SCRAPE_CONCURRENCY', group: 'Performance', label: 'Scraper-Parallelität', type: 'int', default: '4', min: 1, max: 20,
    help: 'Parallele Browser-Worker beim Scrapen' },

  { key: 'CRON_SCHEDULE', group: 'Server', label: 'Zeitplan (Cron)', type: 'text', default: '0 * * * *',
    help: 'node-cron Ausdruck. Standard: stündlich zur vollen Stunde' },
  { key: 'GUI_PORT', group: 'Server', label: 'GUI-Port', type: 'int', default: '3000', min: 1, max: 65535,
    help: 'Port der Weboberfläche (Neustart der GUI nötig)' },

  { key: 'BACKUP_ENABLED', group: 'Datensicherung', label: 'Tägliches Backup', type: 'bool', default: 'true',
    help: 'Erstellt einmal pro Tag automatisch eine Sicherung der Datenbank (auch ohne aktiven Lauf). Manuelle Sicherung, Import, Download und Upload bleiben unabhängig davon verfügbar.' },
  { key: 'BACKUP_RETENTION_DAYS', group: 'Datensicherung', label: 'Aufbewahrung (Tage)', type: 'int', default: '30', min: 1, max: 3650,
    help: 'So viele tägliche Sicherungen werden behalten, ältere werden automatisch gelöscht. Manuelle, hochgeladene und Vor-Import-Sicherungen bleiben immer erhalten.' },

  { key: 'CLIENTS_ENABLED', group: 'Klienten (Mehrbenutzer)', label: 'Klienten-Verwaltung anzeigen', type: 'bool', default: 'false',
    help: 'Blendet die Mehrbenutzer-Verwaltung ein (Klienten-Tab und Klienten-Auswahl oben rechts). Für die private Nutzung aus lassen. Seite neu laden, damit die Änderung greift.' },

  { key: 'AUTH_ENABLED', group: 'Sicherheit (SaaS)', label: 'Login aktiv', type: 'text', default: 'false',
    help: "Auf 'true' setzen, um das Betreiber-Login zu aktivieren (SaaS). Privat/localhost: 'false'. Neustart nötig." },
  { key: 'OPERATOR_USER', group: 'Sicherheit (SaaS)', label: 'Betreiber-Benutzer', type: 'text', default: 'admin',
    help: 'Benutzername für das GUI-Login (nur bei aktiviertem Login)' },
  { key: 'OPERATOR_PASSWORD_HASH', group: 'Sicherheit (SaaS)', label: 'Passwort-Hash', type: 'secret',
    help: 'scrypt-Hash des Betreiber-Passworts. Erzeugen mit: npm run hash-password -- "<passwort>"' },
  { key: 'SESSION_SECRET', group: 'Sicherheit (SaaS)', label: 'Session-Secret', type: 'secret',
    help: 'Zufälliger String zum Signieren der Login-Sitzungen (sonst bei jedem Neustart neu → Logout). Neustart nötig.' },
];
const SCHEMA_BY_KEY = Object.fromEntries(SETTINGS_SCHEMA.map(s => [s.key, s]));

// Parse a .env file into { KEY: value }, ignoring comments and blank lines.
function parseEnvFile(raw) {
  const out = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"'))
      val = val.slice(1, -1).replace(/\\"/g, '"');   // undo envQuote's \" escaping
    else if (val.length >= 2 && val.startsWith("'") && val.endsWith("'"))
      val = val.slice(1, -1);
    out[m[1]] = val;
  }
  return out;
}

async function readEnvMap() {
  try { return parseEnvFile(await readFile(ENV_FILE, 'utf-8')); }
  catch { return {}; }
}

function envQuote(v) {
  return /[\s#"'=]/.test(v) ? `"${String(v).replace(/"/g, '\\"')}"` : v;
}

// Rebuild a tidy, grouped, commented .env from a { KEY: value } map.
// Unknown keys (added by hand) are preserved in a trailing section.
function buildEnvFile(values) {
  const groups = [...new Set(SETTINGS_SCHEMA.map(s => s.group))];
  let out = '# Verwaltet über den Einstellungen-Tab der Job-Alert-GUI.\n# Kann auch von Hand bearbeitet werden.\n\n';
  for (const g of groups) {
    out += `# ── ${g} ${'─'.repeat(Math.max(2, 56 - g.length))}\n`;
    for (const s of SETTINGS_SCHEMA.filter(x => x.group === g)) {
      out += `# ${s.help}\n`;
      const v = values[s.key];
      if (v == null || v === '') out += `# ${s.key}=${s.default ?? ''}\n`;
      else out += `${s.key}=${envQuote(v)}\n`;
    }
    out += '\n';
  }
  const known = new Set(SETTINGS_SCHEMA.map(s => s.key));
  const extras = Object.entries(values).filter(([k, v]) => !known.has(k) && v != null && v !== '');
  if (extras.length) {
    out += '# ── Weitere ──────────────────────────────────────────────\n';
    for (const [k, v] of extras) out += `${k}=${envQuote(v)}\n`;
    out += '\n';
  }
  return out;
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] [server] ${msg}`);
}

const VALID_STATUSES = ['applied', 'interview', 'offer', 'rejected'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// ── In-memory state for the "run" feature ──────────────────────────────────
// A single child `node index.js --once` process at a time. Its stdout/stderr is
// buffered (capped) and broadcast to any connected Server-Sent-Events clients.
const run = {
  active: false,
  startedAt: null,
  logs: [],            // capped ring buffer of log lines
  clients: new Set(),  // SSE response objects
};
const LOG_CAP = 800;

function pushLog(line) {
  run.logs.push(line);
  if (run.logs.length > LOG_CAP) run.logs.shift();
  broadcast('log', line);
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of run.clients) res.write(payload);
}

function startRun(clientId) {
  if (run.active) return false;
  run.active = true;
  run.startedAt = new Date().toISOString();
  run.logs = [];
  broadcast('status', { active: true, startedAt: run.startedAt });

  // Scope the run to one client when given, otherwise run all enabled clients.
  const args = ['index.js', '--once'];
  if (clientId) args.push('--client', clientId);
  const child = spawn('node', args, {
    cwd: ROOT,
    env: process.env,
  });

  const onData = (buf) => {
    for (const line of buf.toString().split('\n')) {
      if (line.trim().length) pushLog(line);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  child.on('close', (code) => {
    run.active = false;
    pushLog(`— Lauf beendet (exit code ${code}) —`);
    broadcast('status', { active: false, exitCode: code });
  });
  child.on('error', (err) => {
    run.active = false;
    pushLog(`FEHLER beim Starten: ${err.message}`);
    broadcast('status', { active: false, error: err.message });
  });

  return true;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 5_000_000) reject(new Error('Body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Stream a raw request body straight to a file (for binary backup uploads — the DB
// can be tens of MB, far past readBody's string/5 MB limit). Aborts and cleans up
// if the upload exceeds maxBytes.
function streamToFile(req, destPath, maxBytes = 200_000_000) {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(destPath);
    let size = 0;
    let aborted = false;
    const fail = (err) => {
      if (aborted) return;
      aborted = true;
      out.destroy();
      import('fs').then(({ rmSync }) => { try { rmSync(destPath, { force: true }); } catch { /* ignore */ } });
      reject(err);
    };
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { fail(new Error('Upload zu groß.')); req.destroy(); }
    });
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => { if (!aborted) resolve(size); });
    req.pipe(out);
  });
}

// Resolve the active client from a request's ?clientId= (defaulting to the
// single-user default client). Returns null when the id is unknown.
function resolveClientId(url) {
  const id = url.searchParams.get('clientId') || DEFAULT_CLIENT_ID;
  return getClient(id) ? id : null;
}

// Run a git command in the project root and capture its output. Resolves with
// { code, out } where `out` is combined stdout+stderr (never rejects on a
// non-zero exit — callers inspect `code`).
function git(args) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn('git', args, { cwd: ROOT });
    } catch (err) {
      return resolve({ code: -1, out: `git konnte nicht gestartet werden: ${err.message}` });
    }
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (err) => resolve({ code: -1, out: `git konnte nicht gestartet werden: ${err.message}` }));
    child.on('close', (code) => resolve({ code: code ?? -1, out: out.trim() }));
  });
}

async function serveStatic(req, res, urlPath) {
  // Map "/" → index.html; prevent path traversal
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

// ── Router ───────────────────────────────────────────────────────────────--
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;
  const method = req.method;

  try {
    // ---- API ----
    if (pathname.startsWith('/api/')) {

      // ---- Auth (always reachable) ----
      // GET /api/auth/status — lets the SPA decide whether to show the login screen
      if (method === 'GET' && pathname === '/api/auth/status') {
        return sendJson(res, 200, {
          authEnabled: AUTH_ENABLED,
          authenticated: isAuthenticated(req),
          clientsEnabled: clientsEnabled(),
          version: APP_VERSION,
        });
      }
      // POST /api/login { user, password }
      if (method === 'POST' && pathname === '/api/login') {
        const body = JSON.parse(await readBody(req) || '{}');
        const okUser = String(body.user || '') === OPERATOR_USER;
        if (okUser && verifyPassword(String(body.password || ''))) {
          const token = signSession({ u: OPERATOR_USER, exp: Date.now() + SESSION_TTL_MS });
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Set-Cookie': sessionCookie(token, SESSION_TTL_MS / 1000, req),
          });
          return res.end(JSON.stringify({ ok: true }));
        }
        return sendJson(res, 401, { error: 'Benutzername oder Passwort falsch' });
      }
      // POST /api/logout
      if (method === 'POST' && pathname === '/api/logout') {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': sessionCookie('', 0, req),
        });
        return res.end(JSON.stringify({ ok: true }));
      }

      // ---- Auth gate: everything below requires a session when AUTH_ENABLED ----
      if (!isAuthenticated(req)) {
        return sendJson(res, 401, { error: 'Nicht angemeldet' });
      }

      // ---- Clients (tenant management) ----
      // GET /api/clients — list (secrets included; operator owns them)
      if (method === 'GET' && pathname === '/api/clients') {
        return sendJson(res, 200, { clients: getClients(), defaultClientId: DEFAULT_CLIENT_ID });
      }
      // POST /api/clients — create
      if (method === 'POST' && pathname === '/api/clients') {
        const body = JSON.parse(await readBody(req) || '{}');
        if (!body.name || !String(body.name).trim())
          return sendJson(res, 400, { error: 'Name ist erforderlich' });
        const created = createClient({
          name: String(body.name).trim(),
          enabled: body.enabled,
          telegram_chat_id: body.telegram_chat_id || null,
          telegram_notifications: body.telegram_notifications || 'on',
          expiry_notifications: body.expiry_notifications || 'on',
          min_relevance_score: body.min_relevance_score ?? null,
        });
        return sendJson(res, 201, { client: created });
      }
      // PUT /api/clients/:id — update meta (name, telegram, toggles)
      let cm = pathname.match(/^\/api\/clients\/([^/]+)$/);
      if (method === 'PUT' && cm) {
        const id = decodeURIComponent(cm[1]);
        if (!getClient(id)) return sendJson(res, 404, { error: 'Klient nicht gefunden' });
        const body = JSON.parse(await readBody(req) || '{}');
        const patch = {};
        for (const f of ['name', 'enabled', 'telegram_chat_id', 'telegram_notifications', 'expiry_notifications', 'min_relevance_score']) {
          if (Object.prototype.hasOwnProperty.call(body, f)) patch[f] = body[f];
        }
        return sendJson(res, 200, { client: updateClient(id, patch) });
      }
      // POST /api/clients/:id/telegram-test — send a test message to a chat id
      let ctm = pathname.match(/^\/api\/clients\/([^/]+)\/telegram-test$/);
      if (method === 'POST' && ctm) {
        const id = decodeURIComponent(ctm[1]);
        const client = getClient(id);
        if (!client) return sendJson(res, 404, { error: 'Klient nicht gefunden' });
        let chatId = client.telegram_chat_id;
        try { chatId = (JSON.parse(await readBody(req) || '{}').telegram_chat_id || chatId); } catch { /* use stored */ }
        try {
          await sendTelegramTest(chatId);
          return sendJson(res, 200, { ok: true });
        } catch (err) {
          return sendJson(res, 502, { error: err.message });
        }
      }

      // DELETE /api/clients/:id
      if (method === 'DELETE' && cm) {
        const id = decodeURIComponent(cm[1]);
        if (id === DEFAULT_CLIENT_ID) return sendJson(res, 400, { error: 'Der Standard-Klient kann nicht gelöscht werden.' });
        if (!getClient(id)) return sendJson(res, 404, { error: 'Klient nicht gefunden' });
        deleteClient(id);
        return sendJson(res, 200, { ok: true });
      }

      // ---- Setup wizard (delegated to setup.js) ----
      if (pathname.startsWith('/api/setup')) {
        const handled = await handleSetupApi(req, res, url, { sendJson, readBody });
        if (handled) return;
      }

      // From here on, data endpoints operate on the active client (?clientId=…).
      const clientId = resolveClientId(url);
      if (!clientId) return sendJson(res, 404, { error: 'Unbekannter Klient' });

      // GET /api/jobs — all relevant jobs (the dashboard list)
      if (method === 'GET' && pathname === '/api/jobs') {
        return sendJson(res, 200, getRelevantJobs(clientId));
      }

      // GET /api/jobs/:id — single job with full description
      let m = pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (method === 'GET' && m) {
        const job = getJobById(clientId, decodeURIComponent(m[1]));
        return job ? sendJson(res, 200, job) : sendJson(res, 404, { error: 'not found' });
      }

      // POST /api/jobs/:id/status  { status }   (status null/"" clears it)
      m = pathname.match(/^\/api\/jobs\/([^/]+)\/status$/);
      if (method === 'POST' && m) {
        const id = decodeURIComponent(m[1]);
        if (!getJobById(clientId, id)) return sendJson(res, 404, { error: 'not found' });
        const { status } = JSON.parse(await readBody(req) || '{}');
        if (!status) clearApplicationStatus(clientId, id);
        else if (VALID_STATUSES.includes(status)) setApplicationStatus(clientId, id, status);
        else return sendJson(res, 400, { error: `invalid status; allowed: ${VALID_STATUSES.join(', ')}` });
        return sendJson(res, 200, getJobById(clientId, id));
      }

      // POST /api/jobs/:id/ignore — mark not relevant
      m = pathname.match(/^\/api\/jobs\/([^/]+)\/ignore$/);
      if (method === 'POST' && m) {
        const id = decodeURIComponent(m[1]);
        if (!getJobById(clientId, id)) return sendJson(res, 404, { error: 'not found' });
        markIrrelevant(clientId, id);
        return sendJson(res, 200, { ok: true });
      }

      // POST /api/jobs/:id/cover-letter — generate a tailored cover letter via Claude
      m = pathname.match(/^\/api\/jobs\/([^/]+)\/cover-letter$/);
      if (method === 'POST' && m) {
        const job = getJobById(clientId, decodeURIComponent(m[1]));
        if (!job) return sendJson(res, 404, { error: 'not found' });
        let notes = '';
        try { notes = (JSON.parse(await readBody(req) || '{}').notes || '').toString().trim(); }
        catch { /* no/invalid body — generate without extra notes */ }
        try {
          const text = await generateCoverLetter(job, notes);
          return sendJson(res, 200, { text });
        } catch (err) {
          log(`Cover-letter error for "${job.title}": ${err.message}`);
          return sendJson(res, 502, { error: `Anschreiben konnte nicht erstellt werden: ${err.message}` });
        }
      }

      // GET /api/stats — everything the stats page needs in one payload
      if (method === 'GET' && pathname === '/api/stats') {
        return sendJson(res, 200, {
          totals:       getTotals(clientId),
          overview:     getLatestRunOverview(clientId),   // null if no run recorded yet
          allTime:      getAllTimeBySource(clientId),
          activity:     getApplicationActivity(clientId),
          appliedByCompany: getAppliedByCompany(clientId),
          statusBreak:  getStatusBreakdown(clientId),
          runHistory:   getRunHistory(clientId, 30),
        });
      }

      // GET /api/runs?limit=N — last N runs with per-source breakdown (Run tab)
      if (method === 'GET' && pathname === '/api/runs') {
        const raw = parseInt(url.searchParams.get('limit'), 10);
        const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 100) : 10;
        return sendJson(res, 200, { runs: getRecentRuns(clientId, limit) });
      }

      // GET /api/sources — this client's job sources
      if (method === 'GET' && pathname === '/api/sources') {
        return sendJson(res, 200, { sources: getSources(clientId) });
      }

      // PUT /api/sources — overwrite this client's sources (validated)
      if (method === 'PUT' && pathname === '/api/sources') {
        const body = await readBody(req);
        let parsed;
        try { parsed = JSON.parse(body); }
        catch (e) { return sendJson(res, 400, { error: `kein gültiges JSON: ${e.message}` }); }
        if (!parsed || !Array.isArray(parsed.sources))
          return sendJson(res, 400, { error: 'Erwarte { "sources": [...] }' });
        for (const s of parsed.sources) {
          if (!s || typeof s.name !== 'string' || typeof s.url !== 'string')
            return sendJson(res, 400, { error: 'Jede Quelle braucht name und url' });
        }
        updateClient(clientId, { sources_json: JSON.stringify({ sources: parsed.sources }) });
        return sendJson(res, 200, { ok: true, count: parsed.sources.length });
      }

      // GET /api/profile — this client's CV/preferences JSON
      if (method === 'GET' && pathname === '/api/profile') {
        return sendJson(res, 200, { profile: getProfile(clientId) });
      }

      // PUT /api/profile — overwrite this client's profile object
      if (method === 'PUT' && pathname === '/api/profile') {
        let body;
        try { body = JSON.parse(await readBody(req) || '{}'); }
        catch (e) { return sendJson(res, 400, { error: `kein gültiges JSON: ${e.message}` }); }
        const profile = body && body.profile;
        if (!profile || typeof profile !== 'object' || Array.isArray(profile))
          return sendJson(res, 400, { error: 'Erwarte { profile: { … } }' });
        updateClient(clientId, { profile_json: JSON.stringify(profile) });
        return sendJson(res, 200, { ok: true });
      }

      // GET /api/filters — this client's title blocklist + priority keywords
      if (method === 'GET' && pathname === '/api/filters') {
        return sendJson(res, 200, { filters: getFilters(clientId) });
      }

      // PUT /api/filters — overwrite this client's filters
      if (method === 'PUT' && pathname === '/api/filters') {
        let body;
        try { body = JSON.parse(await readBody(req) || '{}'); }
        catch (e) { return sendJson(res, 400, { error: `kein gültiges JSON: ${e.message}` }); }
        const f = body && body.filters;
        if (!f || typeof f !== 'object')
          return sendJson(res, 400, { error: 'Erwarte { filters: { titleBlocklist, priorityKeywords } }' });
        const clean = {
          titleBlocklist:  Array.isArray(f.titleBlocklist)  ? f.titleBlocklist.map(String)  : [],
          priorityKeywords: Array.isArray(f.priorityKeywords) ? f.priorityKeywords.map(String) : [],
        };
        updateClient(clientId, { filters_json: JSON.stringify(clean) });
        return sendJson(res, 200, { ok: true });
      }

      // GET /api/prompts — editable prompt fields + this client's current/default values
      if (method === 'GET' && pathname === '/api/prompts') {
        return sendJson(res, 200, {
          fields: PROMPT_FIELDS,
          prompts: getPrompts(clientId),
          defaults: DEFAULT_PROMPTS,
        });
      }

      // PUT /api/prompts — persist this client's prompt overrides (minimal diff vs defaults)
      if (method === 'PUT' && pathname === '/api/prompts') {
        let body;
        try { body = JSON.parse(await readBody(req) || '{}'); }
        catch (e) { return sendJson(res, 400, { error: `kein gültiges JSON: ${e.message}` }); }
        const incoming = body && body.prompts;
        if (!incoming || typeof incoming !== 'object')
          return sendJson(res, 400, { error: 'Erwarte { prompts: { KEY: text } }' });
        const overrides = minimizePromptOverrides(incoming);
        updateClient(clientId, { prompts_json: Object.keys(overrides).length ? JSON.stringify(overrides) : null });
        return sendJson(res, 200, { ok: true });
      }

      // GET /api/settings — schema + current values.
      // Note: this is a localhost self-host tool; the operator owns these keys and
      // explicitly wants to view/copy them, so secrets are returned too (hidden
      // behind a reveal toggle in the UI). The .env is gitignored and never shipped.
      if (method === 'GET' && pathname === '/api/settings') {
        const current = await readEnvMap();
        const settings = SETTINGS_SCHEMA.map(s => {
          const raw = current[s.key];
          const hasValue = raw != null && raw !== '';
          const out = {
            key: s.key, group: s.group, label: s.label, type: s.type,
            default: s.default ?? '', required: !!s.required, help: s.help,
            min: s.min, max: s.max,
          };
          if (s.type === 'secret') { out.isSet = hasValue; out.value = hasValue ? raw : ''; }
          else out.value = hasValue ? raw : (s.default ?? '');   // prefill effective value
          return out;
        });
        return sendJson(res, 200, { settings });
      }

      // PUT /api/settings — validate and persist to .env
      if (method === 'PUT' && pathname === '/api/settings') {
        let incoming;
        try { incoming = JSON.parse(await readBody(req) || '{}'); }
        catch (e) { return sendJson(res, 400, { error: `kein gültiges JSON: ${e.message}` }); }
        const updates = incoming && incoming.settings;
        if (!updates || typeof updates !== 'object')
          return sendJson(res, 400, { error: 'Erwarte { settings: { KEY: value } }' });

        const final = { ...(await readEnvMap()) };   // keep any unknown/extra keys
        const errors = [];
        for (const [key, rawVal] of Object.entries(updates)) {
          const s = SCHEMA_BY_KEY[key];
          if (!s) continue;   // ignore unknown keys from the client
          const val = rawVal == null ? '' : String(rawVal).trim();
          // Interior newlines would break out of their .env line on the next
          // read (parseEnvFile is line-based), injecting/overwriting other keys.
          if (/[\r\n]/.test(val)) { errors.push(`${s.label}: darf keine Zeilenumbrüche enthalten`); continue; }

          if (s.type === 'secret') {
            if (val !== '') final[key] = val;   // empty = leave unchanged
            continue;
          }
          if (val === '') { delete final[key]; continue; }   // unset → code default applies
          if (s.type === 'int') {
            if (!/^-?\d+$/.test(val)) { errors.push(`${s.label}: muss eine ganze Zahl sein`); continue; }
            const n = Number(val);
            if (s.min != null && n < s.min) { errors.push(`${s.label}: mindestens ${s.min}`); continue; }
            if (s.max != null && n > s.max) { errors.push(`${s.label}: höchstens ${s.max}`); continue; }
            final[key] = String(n);
          } else if (key === 'CRON_SCHEDULE') {
            const parts = val.split(/\s+/);
            if (parts.length < 5 || parts.length > 6) { errors.push('Zeitplan (Cron): 5 Felder erwartet, z. B. 0 * * * *'); continue; }
            final[key] = val;
          } else {
            final[key] = val;
          }
        }
        if (errors.length) return sendJson(res, 400, { error: errors.join(' · ') });

        await writeFile(ENV_FILE, buildEnvFile(final), 'utf-8');
        // Reflect into the live process so freshly spawned runs (and in-process
        // helpers that read process.env at call time) pick changes up immediately.
        for (const s of SETTINGS_SCHEMA) {
          if (final[s.key] != null && final[s.key] !== '') process.env[s.key] = final[s.key];
          else delete process.env[s.key];
        }
        return sendJson(res, 200, { ok: true });
      }

      // POST /api/run — start a pipeline run for the active client, or all clients
      // when ?all=1 is set.
      if (method === 'POST' && pathname === '/api/run') {
        const runAllClients = ['1', 'true', 'yes'].includes((url.searchParams.get('all') || '').toLowerCase());
        const started = startRun(runAllClients ? undefined : clientId);
        return started
          ? sendJson(res, 202, { started: true })
          : sendJson(res, 409, { started: false, error: 'Lauf läuft bereits' });
      }

      // GET /api/run/status
      if (method === 'GET' && pathname === '/api/run/status') {
        return sendJson(res, 200, { active: run.active, startedAt: run.startedAt });
      }

      // GET /api/run/stream — Server-Sent Events of live logs
      if (method === 'GET' && pathname === '/api/run/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        res.write(`event: status\ndata: ${JSON.stringify({ active: run.active, startedAt: run.startedAt })}\n\n`);
        for (const line of run.logs) res.write(`event: log\ndata: ${JSON.stringify(line)}\n\n`);
        run.clients.add(res);
        req.on('close', () => run.clients.delete(res));
        return;
      }

      // POST /api/update — pull the latest version from GitHub (git pull --ff-only)
      if (method === 'POST' && pathname === '/api/update') {
        if (run.active) return sendJson(res, 409, { error: 'Ein Lauf ist aktiv – bitte zuerst beenden.' });

        const inside = await git(['rev-parse', '--is-inside-work-tree']);
        if (inside.code !== 0 || inside.out.trim() !== 'true') {
          return sendJson(res, 200, { ok: false, output: 'Kein Git-Repository – Update nur möglich, wenn das Projekt per "git clone" installiert wurde.' });
        }

        const before = (await git(['rev-parse', 'HEAD'])).out.trim();
        log('Update angefordert – git pull …');
        const pull = await git(['pull', '--ff-only']);
        const after = (await git(['rev-parse', 'HEAD'])).out.trim();
        const updated = before !== '' && after !== '' && before !== after;

        let depsChanged = false;
        if (updated) {
          const diff = await git(['diff', '--name-only', before, after]);
          depsChanged = /(^|\n)(package\.json|package-lock\.json)(\n|$)/.test(diff.out);
        }

        if (pull.code !== 0) {
          log('Update fehlgeschlagen.');
          return sendJson(res, 200, { ok: false, output: pull.out });
        }
        log(updated ? 'Update angewendet.' : 'Bereits aktuell.');
        return sendJson(res, 200, { ok: true, updated, depsChanged, needsRestart: updated, output: pull.out });
      }

      // ---- Backups (operator-wide: cover the whole DB, all clients) ----

      // GET /api/backups — list existing backups + current settings
      if (method === 'GET' && pathname === '/api/backups') {
        return sendJson(res, 200, {
          backups: listBackups(),
          enabled: isDailyEnabled(),
          retentionDays: retentionDays(),
        });
      }

      // POST /api/backups — create a manual snapshot now
      if (method === 'POST' && pathname === '/api/backups') {
        try {
          const backup = await createBackup('manual');
          return sendJson(res, 200, { ok: true, backup });
        } catch (err) {
          log(`Backup failed: ${err.message}`);
          return sendJson(res, 500, { error: `Sicherung fehlgeschlagen: ${err.message}` });
        }
      }

      // GET /api/backups/download?file=… — download a backup file
      if (method === 'GET' && pathname === '/api/backups/download') {
        let full;
        try { full = resolveBackupPath(url.searchParams.get('file')); }
        catch (err) { return sendJson(res, 404, { error: err.message }); }
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${path.basename(full)}"`,
        });
        return createReadStream(full).pipe(res);
      }

      // POST /api/backups/upload — accept an externally stored backup file (raw body)
      if (method === 'POST' && pathname === '/api/backups/upload') {
        const tmp = path.join(BACKUP_DIR, `.upload-${Date.now()}.tmp`);
        try {
          await streamToFile(req, tmp);
          const backup = ingestUpload(tmp);   // validates; throws (and cleans up) if invalid
          return sendJson(res, 200, { ok: true, backup });
        } catch (err) {
          log(`Upload rejected: ${err.message}`);
          return sendJson(res, 400, { error: `Upload abgelehnt: ${err.message}` });
        }
      }

      // POST /api/backups/restore { file } — restore a backup. Always takes a fresh
      // pre-import safety backup FIRST, so the current state is never lost.
      if (method === 'POST' && pathname === '/api/backups/restore') {
        if (run.active) return sendJson(res, 409, { error: 'Ein Lauf ist aktiv – bitte zuerst beenden.' });
        let full;
        try { full = resolveBackupPath(JSON.parse(await readBody(req) || '{}').file); }
        catch (err) { return sendJson(res, 400, { error: err.message }); }
        try {
          const safetyBackup = await createBackup('preimport');   // safety net before any change
          restoreFromBackup(full);                                // atomic; rolls back on error
          log(`Restored from ${path.basename(full)} (safety: ${safetyBackup.file}).`);
          return sendJson(res, 200, { ok: true, safetyBackup });
        } catch (err) {
          log(`Restore failed: ${err.message}`);
          return sendJson(res, 500, { error: `Wiederherstellung fehlgeschlagen: ${err.message}` });
        }
      }

      // POST /api/restart — restart the GUI server itself
      if (method === 'POST' && pathname === '/api/restart') {
        if (run.active) return sendJson(res, 409, { error: 'Ein Lauf ist aktiv – bitte zuerst beenden.' });
        sendJson(res, 200, { ok: true });
        log('Neustart angefordert …');
        // Under pm2/systemd, exiting is enough — the manager restarts us. Otherwise
        // re-exec a detached copy of this process. The new instance retries binding
        // the port (see server 'error' handler) until this one has released it.
        const managed = process.env.pm_id !== undefined;
        setTimeout(() => {
          if (!managed) {
            const child = spawn(process.argv[0], process.argv.slice(1), {
              cwd: ROOT, env: process.env, detached: true, stdio: 'inherit',
            });
            child.unref();
          }
          process.exit(0);
        }, 300);
        return;
      }

      return sendJson(res, 404, { error: 'unknown endpoint' });
    }

    // ---- Static files ----
    if (method === 'GET') return serveStatic(req, res, pathname);

    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
  } catch (err) {
    log(`ERROR ${method} ${pathname}: ${err.message}`);
    sendJson(res, 500, { error: err.message });
  }
});

// On restart the freshly spawned process may briefly race the old one for the
// port; retry binding until it is released instead of crashing.
let bindRetries = 0;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && bindRetries < 30) {
    if (bindRetries++ === 0) log(`Port ${PORT} noch belegt – warte auf Freigabe …`);
    setTimeout(() => server.listen(PORT), 300);
  } else {
    log(`FATAL: ${err.message}`);
    process.exit(1);
  }
});
server.listen(PORT, () => log(`GUI ready → http://localhost:${PORT}`));

// Daily DB backup: check on startup, then every 6h so a long-running server still
// creates one after crossing midnight. Idempotent — skips if today's already exists.
// Skip while a run is active: the spawned `--once` child is writing, and a snapshot
// taken mid-run can capture a stale state. The next 6h tick (or the scheduler, which
// backs up before its own run) catches up once the run finishes.
function safeDailyBackup() {
  if (run.active) {
    log('Daily backup deferred — a run is active.');
    return;
  }
  maybeRunDailyBackup().catch(err => log(`Daily backup check failed: ${err.message}`));
}
safeDailyBackup();
setInterval(safeDailyBackup, 6 * 60 * 60 * 1000).unref();
