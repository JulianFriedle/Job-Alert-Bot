import 'dotenv/config';
import http from 'http';
import { readFile, writeFile, stat } from 'fs/promises';
import { createReadStream } from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  getRelevantJobs, getJobById, setApplicationStatus,
  clearApplicationStatus, markIrrelevant,
  getLatestRunOverview, getAllTimeBySource, getApplicationActivity,
  getAppliedByCompany, getStatusBreakdown, getRunHistory, getTotals,
} from './database.js';
import { generateCoverLetter } from './cover-letter.js';
import { handleSetupApi } from './setup.js';
import { DEFAULT_PROMPTS, PROMPT_FIELDS, PROMPTS_PATH, loadPrompts } from './prompts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const JOBS_CONFIG = path.join(ROOT, 'config', 'jobs.json');
const PROFILE_CONFIG = path.join(ROOT, 'config', 'profile.json');
const ENV_FILE = path.join(ROOT, '.env');
const PORT = process.env.GUI_PORT || 3000;

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
];
const SCHEMA_BY_KEY = Object.fromEntries(SETTINGS_SCHEMA.map(s => [s.key, s]));

// Parse a .env file into { KEY: value }, ignoring comments and blank lines.
function parseEnvFile(raw) {
  const out = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
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

function startRun() {
  if (run.active) return false;
  run.active = true;
  run.startedAt = new Date().toISOString();
  run.logs = [];
  broadcast('status', { active: true, startedAt: run.startedAt });

  const child = spawn('node', ['index.js', '--once'], {
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

      // ---- Setup wizard (delegated to setup.js) ----
      if (pathname.startsWith('/api/setup')) {
        const handled = await handleSetupApi(req, res, url, { sendJson, readBody });
        if (handled) return;
      }

      // GET /api/jobs — all relevant jobs (the dashboard list)
      if (method === 'GET' && pathname === '/api/jobs') {
        return sendJson(res, 200, getRelevantJobs());
      }

      // GET /api/jobs/:id — single job with full description
      let m = pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (method === 'GET' && m) {
        const job = getJobById(decodeURIComponent(m[1]));
        return job ? sendJson(res, 200, job) : sendJson(res, 404, { error: 'not found' });
      }

      // POST /api/jobs/:id/status  { status }   (status null/"" clears it)
      m = pathname.match(/^\/api\/jobs\/([^/]+)\/status$/);
      if (method === 'POST' && m) {
        const id = decodeURIComponent(m[1]);
        if (!getJobById(id)) return sendJson(res, 404, { error: 'not found' });
        const { status } = JSON.parse(await readBody(req) || '{}');
        if (!status) clearApplicationStatus(id);
        else if (VALID_STATUSES.includes(status)) setApplicationStatus(id, status);
        else return sendJson(res, 400, { error: `invalid status; allowed: ${VALID_STATUSES.join(', ')}` });
        return sendJson(res, 200, getJobById(id));
      }

      // POST /api/jobs/:id/ignore — mark not relevant
      m = pathname.match(/^\/api\/jobs\/([^/]+)\/ignore$/);
      if (method === 'POST' && m) {
        const id = decodeURIComponent(m[1]);
        if (!getJobById(id)) return sendJson(res, 404, { error: 'not found' });
        markIrrelevant(id);
        return sendJson(res, 200, { ok: true });
      }

      // POST /api/jobs/:id/cover-letter — generate a tailored cover letter via Claude
      m = pathname.match(/^\/api\/jobs\/([^/]+)\/cover-letter$/);
      if (method === 'POST' && m) {
        const job = getJobById(decodeURIComponent(m[1]));
        if (!job) return sendJson(res, 404, { error: 'not found' });
        try {
          const text = await generateCoverLetter(job);
          return sendJson(res, 200, { text });
        } catch (err) {
          log(`Cover-letter error for "${job.title}": ${err.message}`);
          return sendJson(res, 502, { error: `Anschreiben konnte nicht erstellt werden: ${err.message}` });
        }
      }

      // GET /api/stats — everything the stats page needs in one payload
      if (method === 'GET' && pathname === '/api/stats') {
        return sendJson(res, 200, {
          totals:       getTotals(),
          overview:     getLatestRunOverview(),   // null if no run recorded yet
          allTime:      getAllTimeBySource(),
          activity:     getApplicationActivity(),
          appliedByCompany: getAppliedByCompany(),
          statusBreak:  getStatusBreakdown(),
          runHistory:   getRunHistory(30),
        });
      }

      // GET /api/sources — raw jobs.json
      if (method === 'GET' && pathname === '/api/sources') {
        const raw = await readFile(JOBS_CONFIG, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(raw);
      }

      // PUT /api/sources — overwrite jobs.json (validated)
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
        await writeFile(JOBS_CONFIG, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
        return sendJson(res, 200, { ok: true, count: parsed.sources.length });
      }

      // GET /api/profile — the CV/preferences JSON (empty object if not created yet)
      if (method === 'GET' && pathname === '/api/profile') {
        let profile = {};
        try { profile = JSON.parse(await readFile(PROFILE_CONFIG, 'utf-8')); } catch { /* none yet */ }
        return sendJson(res, 200, { profile });
      }

      // PUT /api/profile — overwrite profile.json with the full object
      if (method === 'PUT' && pathname === '/api/profile') {
        let body;
        try { body = JSON.parse(await readBody(req) || '{}'); }
        catch (e) { return sendJson(res, 400, { error: `kein gültiges JSON: ${e.message}` }); }
        const profile = body && body.profile;
        if (!profile || typeof profile !== 'object' || Array.isArray(profile))
          return sendJson(res, 400, { error: 'Erwarte { profile: { … } }' });
        await writeFile(PROFILE_CONFIG, JSON.stringify(profile, null, 2) + '\n', 'utf-8');
        return sendJson(res, 200, { ok: true });
      }

      // GET /api/prompts — editable prompt fields + current/default values
      if (method === 'GET' && pathname === '/api/prompts') {
        const current = loadPrompts();
        return sendJson(res, 200, {
          fields: PROMPT_FIELDS,
          prompts: current,
          defaults: DEFAULT_PROMPTS,
        });
      }

      // PUT /api/prompts — persist overrides to config/prompts.json.
      // Empty or default-equal values are dropped so the file stays minimal and
      // future default changes still flow through for untouched fields.
      if (method === 'PUT' && pathname === '/api/prompts') {
        let body;
        try { body = JSON.parse(await readBody(req) || '{}'); }
        catch (e) { return sendJson(res, 400, { error: `kein gültiges JSON: ${e.message}` }); }
        const incoming = body && body.prompts;
        if (!incoming || typeof incoming !== 'object')
          return sendJson(res, 400, { error: 'Erwarte { prompts: { KEY: text } }' });
        const overrides = {};
        for (const key of Object.keys(DEFAULT_PROMPTS)) {
          const v = incoming[key];
          if (typeof v === 'string' && v.trim() !== '' && v !== DEFAULT_PROMPTS[key]) overrides[key] = v;
        }
        await writeFile(PROMPTS_PATH, JSON.stringify(overrides, null, 2) + '\n', 'utf-8');
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

      // POST /api/run — start a pipeline run
      if (method === 'POST' && pathname === '/api/run') {
        const started = startRun();
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
