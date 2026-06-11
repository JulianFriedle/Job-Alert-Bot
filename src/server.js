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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const JOBS_CONFIG = path.join(ROOT, 'config', 'jobs.json');
const PORT = process.env.GUI_PORT || 3000;

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

server.listen(PORT, () => {
  log(`GUI ready → http://localhost:${PORT}`);
});
