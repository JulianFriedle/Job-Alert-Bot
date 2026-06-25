import Database from 'better-sqlite3';
import { mkdirSync, copyFileSync, rmSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// JOBS_DB_PATH lets a deployment (Docker volume) or a test point the DB elsewhere.
export const DB_PATH = process.env.JOBS_DB_PATH || path.join(__dirname, '..', 'data', 'jobs.db');

// Every table that holds real data — used by the backup/restore copy. Order does
// not matter for the wipe+refill (foreign keys are not enforced), but we keep a
// single source of truth so a new table is never silently left out of a restore.
export const DATA_TABLES = ['clients', 'jobs', 'runs', 'run_stats', 'status_history'];

// The single-user / private install is modelled as exactly one client with this
// fixed id. Multi-tenant (SaaS) installs add further clients alongside it. Every
// jobs/runs row is scoped by client_id; the default client keeps the app working
// out of the box and lets a fresh DB migrate cleanly.
export const DEFAULT_CLIENT_ID = 'default';

function log(msg) {
  console.log(`[${new Date().toISOString()}] [database] ${msg}`);
}

function openDb() {
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  // Wait up to 5s on a locked DB instead of throwing — the GUI server reads/writes
  // while a child `node index.js --once` process may be writing concurrently.
  db.pragma('busy_timeout = 5000');

  // ── Clients (tenants) ──────────────────────────────────────────────────────
  // Each client owns its own profile/sources/filters/prompts (stored as JSON, a
  // 1:1 mapping of the former config/*.json files) plus its own Telegram target.
  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id                     TEXT PRIMARY KEY,
      name                   TEXT NOT NULL,
      enabled                INTEGER DEFAULT 1,
      created_at             TEXT,
      telegram_chat_id       TEXT,
      telegram_notifications TEXT DEFAULT 'on',
      expiry_notifications   TEXT DEFAULT 'on',
      min_relevance_score    INTEGER,
      profile_json           TEXT,
      sources_json           TEXT,
      filters_json           TEXT,
      prompts_json           TEXT
    );
  `);

  // ── Jobs ───────────────────────────────────────────────────────────────────
  // Primary key is (client_id, id): the same posting URL can be tracked for
  // multiple clients independently, each with its own notified/applied/status.
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      client_id   TEXT NOT NULL DEFAULT '${DEFAULT_CLIENT_ID}',
      id          TEXT NOT NULL,
      title       TEXT,
      company     TEXT,
      url         TEXT,
      location    TEXT,
      description TEXT,
      source      TEXT,
      relevant    INTEGER,
      score       INTEGER,
      summary     TEXT,
      notified    INTEGER DEFAULT 0,
      scraped_at  TEXT,
      analyzed_at TEXT,
      last_seen_at TEXT,
      expired     INTEGER DEFAULT 0,
      applied     INTEGER DEFAULT 0,
      applied_at  TEXT,
      status      TEXT,
      PRIMARY KEY (client_id, id)
    );
  `);

  // Per-run overview snapshots — persists the LAUF-ÜBERSICHT table so the GUI can
  // show real per-run counters (which are otherwise only printed to the log).
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id          TEXT DEFAULT '${DEFAULT_CLIENT_ID}',
      ran_at             TEXT,
      total_found        INTEGER,
      total_new          INTEGER,
      total_blocked      INTEGER,
      total_analyzed     INTEGER,
      total_new_relevant INTEGER,
      total_relevant     INTEGER,
      total_notified     INTEGER
    );
    CREATE TABLE IF NOT EXISTS run_stats (
      run_id         INTEGER,
      source         TEXT,
      found          INTEGER,
      site_total     INTEGER,
      new_db         INTEGER,
      blocked        INTEGER,
      analyzed       INTEGER,
      new_relevant   INTEGER,
      total_relevant INTEGER,
      notified       INTEGER
    );
  `);

  // Append-only log of application status changes (applied → interview → offer /
  // rejected). The jobs table only keeps the *current* status; this gives the
  // dated trail behind it, so the GUI can chart "when did I get N rejections".
  db.exec(`
    CREATE TABLE IF NOT EXISTS status_history (
      client_id  TEXT NOT NULL,
      job_id     TEXT NOT NULL,
      status     TEXT NOT NULL,
      changed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_status_history_job
      ON status_history (client_id, job_id);
    CREATE INDEX IF NOT EXISTS idx_status_history_status
      ON status_history (client_id, status);
  `);

  migrateSchema(db);
  ensureDefaultClient(db);

  return db;
}

// Idempotent migrations for DBs created before multi-tenancy. The jobs table is
// rebuilt only when it still lacks a client_id column (old single-user schema),
// because SQLite can't ALTER a primary key in place.
function migrateSchema(db) {
  const jobCols = db.prepare("PRAGMA table_info(jobs)").all().map(r => r.name);

  // Legacy per-column adds (older single-user DBs that predate these columns)
  if (!jobCols.includes('score'))        db.exec('ALTER TABLE jobs ADD COLUMN score        INTEGER');
  if (!jobCols.includes('summary'))      db.exec('ALTER TABLE jobs ADD COLUMN summary      TEXT');
  if (!jobCols.includes('last_seen_at')) {
    db.exec('ALTER TABLE jobs ADD COLUMN last_seen_at TEXT');
    db.exec("UPDATE jobs SET last_seen_at = scraped_at WHERE last_seen_at IS NULL");
  }
  if (!jobCols.includes('expired'))      db.exec('ALTER TABLE jobs ADD COLUMN expired      INTEGER DEFAULT 0');
  if (!jobCols.includes('applied'))      db.exec('ALTER TABLE jobs ADD COLUMN applied      INTEGER DEFAULT 0');
  if (!jobCols.includes('applied_at'))   db.exec('ALTER TABLE jobs ADD COLUMN applied_at   TEXT');
  if (!jobCols.includes('status'))       db.exec('ALTER TABLE jobs ADD COLUMN status        TEXT');

  // Multi-tenant rebuild: old jobs table had `id` as sole PRIMARY KEY. Recreate it
  // with the composite (client_id, id) key and backfill the default client.
  if (!jobCols.includes('client_id')) {
    log('Migrating jobs table to multi-tenant schema (adding client_id, composite PK)…');
    db.exec('BEGIN');
    try {
      db.exec(`ALTER TABLE jobs RENAME TO jobs_legacy;`);
      db.exec(`
        CREATE TABLE jobs (
          client_id   TEXT NOT NULL DEFAULT '${DEFAULT_CLIENT_ID}',
          id          TEXT NOT NULL,
          title       TEXT, company TEXT, url TEXT, location TEXT, description TEXT, source TEXT,
          relevant    INTEGER, score INTEGER, summary TEXT,
          notified    INTEGER DEFAULT 0,
          scraped_at  TEXT, analyzed_at TEXT, last_seen_at TEXT,
          expired     INTEGER DEFAULT 0,
          applied     INTEGER DEFAULT 0, applied_at TEXT, status TEXT,
          PRIMARY KEY (client_id, id)
        );
      `);
      db.exec(`
        INSERT INTO jobs (client_id, id, title, company, url, location, description, source,
                          relevant, score, summary, notified, scraped_at, analyzed_at, last_seen_at,
                          expired, applied, applied_at, status)
        SELECT '${DEFAULT_CLIENT_ID}', id, title, company, url, location, description, source,
               relevant, score, summary, notified, scraped_at, analyzed_at, last_seen_at,
               expired, applied, applied_at, status
        FROM jobs_legacy;
      `);
      db.exec('DROP TABLE jobs_legacy;');
      db.exec('COMMIT');
      log('jobs table migration complete.');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  const runCols = db.prepare("PRAGMA table_info(runs)").all().map(r => r.name);
  if (!runCols.includes('client_id')) {
    db.exec(`ALTER TABLE runs ADD COLUMN client_id TEXT DEFAULT '${DEFAULT_CLIENT_ID}'`);
    db.exec(`UPDATE runs SET client_id = '${DEFAULT_CLIENT_ID}' WHERE client_id IS NULL`);
  }

  // Seed status_history from jobs that were already applied to before this table
  // existed. We only know their current status + applied_at, so we record one
  // entry per such job. Runs once: skipped as soon as any history row exists.
  const hasHistory = db.prepare('SELECT 1 FROM status_history LIMIT 1').get();
  if (!hasHistory) {
    const seeded = db.prepare(`
      INSERT INTO status_history (client_id, job_id, status, changed_at)
      SELECT client_id, id, COALESCE(status, 'applied'), COALESCE(applied_at, scraped_at)
      FROM jobs WHERE applied = 1 AND COALESCE(applied_at, scraped_at) IS NOT NULL
    `).run();
    if (seeded.changes) log(`Seeded status_history with ${seeded.changes} existing application(s).`);
  }
}

// Guarantee the default client row exists so the single-user app always has a
// tenant to operate on. Config (profile/sources/…) is imported separately by the
// migration script; here we only create an empty shell if missing.
function ensureDefaultClient(db) {
  const row = db.prepare('SELECT 1 FROM clients WHERE id = ?').get(DEFAULT_CLIENT_ID);
  if (!row) {
    db.prepare(`
      INSERT INTO clients (id, name, enabled, created_at, telegram_notifications, expiry_notifications)
      VALUES (?, ?, 1, ?, 'on', 'on')
    `).run(DEFAULT_CLIENT_ID, 'Privat', new Date().toISOString());
    log(`Created default client "${DEFAULT_CLIENT_ID}".`);
  }
}

const db = openDb();
log(`Database ready at ${DB_PATH}`);

// ── Clients CRUD ─────────────────────────────────────────────────────────────

const CLIENT_FIELDS = [
  'name', 'enabled', 'telegram_chat_id', 'telegram_notifications',
  'expiry_notifications', 'min_relevance_score',
  'profile_json', 'sources_json', 'filters_json', 'prompts_json',
];

export function getClients() {
  return db.prepare('SELECT * FROM clients ORDER BY (id = ?) DESC, name ASC').all(DEFAULT_CLIENT_ID);
}

export function getClient(id) {
  return db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
}

export function getEnabledClients() {
  return db.prepare('SELECT * FROM clients WHERE enabled = 1 ORDER BY (id = ?) DESC, name ASC').all(DEFAULT_CLIENT_ID);
}

export function createClient(data) {
  const id = data.id || randomUUID();
  db.prepare(`
    INSERT INTO clients
      (id, name, enabled, created_at, telegram_chat_id, telegram_notifications,
       expiry_notifications, min_relevance_score, profile_json, sources_json, filters_json, prompts_json)
    VALUES
      (@id, @name, @enabled, @created_at, @telegram_chat_id, @telegram_notifications,
       @expiry_notifications, @min_relevance_score, @profile_json, @sources_json, @filters_json, @prompts_json)
  `).run({
    id,
    name: data.name || 'Unbenannt',
    enabled: data.enabled === false ? 0 : 1,
    created_at: new Date().toISOString(),
    telegram_chat_id: data.telegram_chat_id ?? null,
    telegram_notifications: data.telegram_notifications ?? 'on',
    expiry_notifications: data.expiry_notifications ?? 'on',
    min_relevance_score: data.min_relevance_score ?? null,
    profile_json: data.profile_json ?? null,
    sources_json: data.sources_json ?? null,
    filters_json: data.filters_json ?? null,
    prompts_json: data.prompts_json ?? null,
  });
  return getClient(id);
}

// Partial update: only the keys present in `data` (and whitelisted) are written.
export function updateClient(id, data) {
  const sets = [];
  const params = {};
  for (const f of CLIENT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(data, f)) {
      let v = data[f];
      if (f === 'enabled') v = v === false || v === 0 ? 0 : 1;
      sets.push(`${f} = @${f}`);
      params[f] = v ?? null;
    }
  }
  if (sets.length) {
    params.id = id;
    db.prepare(`UPDATE clients SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }
  return getClient(id);
}

export function deleteClient(id) {
  if (id === DEFAULT_CLIENT_ID) throw new Error('Der Standard-Klient kann nicht gelöscht werden.');
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM run_stats WHERE run_id IN (SELECT id FROM runs WHERE client_id = ?)').run(id);
    db.prepare('DELETE FROM runs WHERE client_id = ?').run(id);
    db.prepare('DELETE FROM jobs WHERE client_id = ?').run(id);
    db.prepare('DELETE FROM clients WHERE id = ?').run(id);
  });
  tx();
}

// ── Jobs (all scoped by clientId) ────────────────────────────────────────────

export function isNewJob(clientId, id) {
  const row = db.prepare('SELECT 1 FROM jobs WHERE client_id = ? AND id = ?').get(clientId, id);
  return !row;
}

export function saveJob(clientId, job) {
  db.prepare(`
    INSERT OR IGNORE INTO jobs
      (client_id, id, title, company, url, location, description, source, relevant, notified, scraped_at)
    VALUES
      (@client_id, @id, @title, @company, @url, @location, @description, @source, NULL, 0, @scraped_at)
  `).run({
    client_id: clientId,
    id: job.id,
    title: job.title || '',
    company: job.company || '',
    url: job.url || '',
    location: job.location || '',
    description: job.description || '',
    source: job.source || '',
    scraped_at: new Date().toISOString(),
  });
}

export function markAnalyzed(clientId, id, relevant, score = null, summary = null) {
  db.prepare(`
    UPDATE jobs
    SET relevant = ?, score = ?, summary = ?, analyzed_at = ?
    WHERE client_id = ? AND id = ?
  `).run(relevant ? 1 : 0, score, summary, new Date().toISOString(), clientId, id);
}

export function getRelevantJobs(clientId) {
  return db.prepare(`
    SELECT id, title, company, location, url, score, summary, source, scraped_at,
           applied, applied_at, status
    FROM jobs
    WHERE client_id = ? AND relevant = 1
    ORDER BY applied DESC, score DESC, scraped_at DESC
  `).all(clientId);
}

export function getJobById(clientId, id) {
  return db.prepare('SELECT * FROM jobs WHERE client_id = ? AND id = ?').get(clientId, id);
}

export function setApplicationStatus(clientId, id, status) {
  const now = new Date().toISOString();
  const prev = db.prepare('SELECT status FROM jobs WHERE client_id = ? AND id = ?').get(clientId, id);
  db.prepare(`
    UPDATE jobs SET
      applied    = 1,
      applied_at = CASE WHEN applied_at IS NULL THEN ? ELSE applied_at END,
      status     = ?
    WHERE client_id = ? AND id = ?
  `).run(now, status, clientId, id);
  // Append to the history trail only on an actual change (re-saving the same
  // status — e.g. clicking "Applied" twice — must not create duplicate entries).
  if (!prev || prev.status !== status) {
    db.prepare(`
      INSERT INTO status_history (client_id, job_id, status, changed_at) VALUES (?, ?, ?, ?)
    `).run(clientId, id, status, now);
  }
}

export function clearApplicationStatus(clientId, id) {
  db.prepare(`
    UPDATE jobs SET applied = 0, applied_at = NULL, status = NULL WHERE client_id = ? AND id = ?
  `).run(clientId, id);
  // Un-applying reverts the job entirely, so drop its history trail too.
  db.prepare('DELETE FROM status_history WHERE client_id = ? AND job_id = ?').run(clientId, id);
}

// Full status-change trail for a client (oldest first), used for timeline charts.
export function getStatusHistory(clientId) {
  return db.prepare(`
    SELECT job_id, status, changed_at
    FROM status_history WHERE client_id = ?
    ORDER BY changed_at ASC
  `).all(clientId);
}

// Count of status changes per calendar day, grouped by status — feeds a
// per-status activity view (e.g. "when did I get rejections"). Mirrors the
// localtime-day bucketing used by getApplicationActivity.
export function getStatusActivity(clientId) {
  const rows = db.prepare(`
    SELECT date(changed_at, 'localtime') AS day, status, COUNT(*) AS count
    FROM status_history WHERE client_id = ?
    GROUP BY day, status
  `).all(clientId);
  const byStatus = {};
  for (const r of rows) (byStatus[r.status] ||= {})[r.day] = r.count;
  return byStatus;
}

export function getAppliedJobs(clientId) {
  return db.prepare(`
    SELECT id, title, company, location, url, score, status, applied_at
    FROM jobs WHERE client_id = ? AND applied = 1
    ORDER BY applied_at DESC
  `).all(clientId);
}

export function markNotified(clientId, id) {
  db.prepare('UPDATE jobs SET notified = 1 WHERE client_id = ? AND id = ?').run(clientId, id);
}

export function getUnanalyzedJobs(clientId) {
  return db.prepare('SELECT * FROM jobs WHERE client_id = ? AND relevant IS NULL').all(clientId);
}

export function getRelevantUnnotifiedJobs(clientId) {
  return db.prepare('SELECT * FROM jobs WHERE client_id = ? AND relevant = 1 AND notified = 0').all(clientId);
}

export function getRelevantCountBySource(clientId) {
  const rows = db.prepare('SELECT source, COUNT(*) as cnt FROM jobs WHERE client_id = ? AND relevant = 1 GROUP BY source').all(clientId);
  return Object.fromEntries(rows.map(r => [r.source, r.cnt]));
}

// Mark every job in the given id list as seen right now (within one client).
export function updateLastSeenBatch(clientId, ids) {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  const stmt = db.prepare('UPDATE jobs SET last_seen_at = ? WHERE client_id = ? AND id = ?');
  db.transaction(() => { for (const id of ids) stmt.run(now, clientId, id); })();
}

// Jobs that were notified but haven't appeared in any scrape for `thresholdHours`.
export function getJobsToExpire(clientId, thresholdHours = 72) {
  const cutoff = new Date(Date.now() - thresholdHours * 60 * 60 * 1000).toISOString();
  return db.prepare(`
    SELECT * FROM jobs
    WHERE client_id = ? AND notified = 1 AND relevant = 1 AND (expired = 0 OR expired IS NULL)
      AND last_seen_at IS NOT NULL AND last_seen_at < ?
  `).all(clientId, cutoff);
}

export function markExpired(clientId, id) {
  db.prepare('UPDATE jobs SET expired = 1 WHERE client_id = ? AND id = ?').run(clientId, id);
}

export function markIrrelevant(clientId, id) {
  db.prepare('UPDATE jobs SET relevant = 0, analyzed_at = ? WHERE client_id = ? AND id = ?')
    .run(new Date().toISOString(), clientId, id);
}

export function getJobsWithEmptyDescription(clientId) {
  return db.prepare(
    "SELECT * FROM jobs WHERE client_id = ? AND (description IS NULL OR description = '') AND (expired = 0 OR expired IS NULL)"
  ).all(clientId);
}

export function updateJobDescription(clientId, id, description) {
  db.prepare(`
    UPDATE jobs
    SET description = ?, relevant = NULL, analyzed_at = NULL, score = NULL, summary = NULL
    WHERE client_id = ? AND id = ?
  `).run(description, clientId, id);
}

// ── Stats / overview (scoped by clientId) ────────────────────────────────────

// Persist one run's per-source overview. `rows` items:
//   { source, found, siteTotal, newDb, blocked, analyzed, newRelevant, totalRelevant, notified }
export function saveRunSnapshot(clientId, rows) {
  const sum = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const info = db.prepare(`
    INSERT INTO runs
      (client_id, ran_at, total_found, total_new, total_blocked, total_analyzed, total_new_relevant, total_relevant, total_notified)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    clientId,
    new Date().toISOString(),
    sum('found'), sum('newDb'), sum('blocked'), sum('analyzed'),
    sum('newRelevant'), sum('totalRelevant'), sum('notified')
  );
  const runId = info.lastInsertRowid;
  const stmt = db.prepare(`
    INSERT INTO run_stats
      (run_id, source, found, site_total, new_db, blocked, analyzed, new_relevant, total_relevant, notified)
    VALUES (@run_id, @source, @found, @site_total, @new_db, @blocked, @analyzed, @new_relevant, @total_relevant, @notified)
  `);
  db.transaction(() => {
    for (const r of rows) stmt.run({
      run_id: runId,
      source: r.source,
      found: r.found ?? 0,
      site_total: r.siteTotal ?? null,
      new_db: r.newDb ?? 0,
      blocked: r.blocked ?? 0,
      analyzed: r.analyzed ?? 0,
      new_relevant: r.newRelevant ?? 0,
      total_relevant: r.totalRelevant ?? 0,
      notified: r.notified ?? 0,
    });
  })();
  return runId;
}

// The per-source overview from the most recent recorded run (exact LAUF-ÜBERSICHT columns).
export function getLatestRunOverview(clientId) {
  const run = db.prepare('SELECT * FROM runs WHERE client_id = ? ORDER BY id DESC LIMIT 1').get(clientId);
  if (!run) return null;
  const rows = db.prepare(`
    SELECT source, found, site_total AS siteTotal, new_db AS newDb, blocked,
           analyzed, new_relevant AS newRelevant, total_relevant AS totalRelevant, notified
    FROM run_stats WHERE run_id = ? ORDER BY total_relevant DESC, found DESC
  `).all(run.id);
  return { ranAt: run.ran_at, rows };
}

// The last `limit` recorded runs (newest first), each with its totals and the
// full per-source breakdown — powers the "Letzte Läufe" overview on the Run tab.
export function getRecentRuns(clientId, limit = 10) {
  const runs = db.prepare(`
    SELECT id, ran_at, total_found, total_new, total_blocked, total_analyzed,
           total_new_relevant, total_relevant, total_notified
    FROM runs WHERE client_id = ? ORDER BY id DESC LIMIT ?
  `).all(clientId, limit);
  const rowStmt = db.prepare(`
    SELECT source, found, site_total AS siteTotal, new_db AS newDb, blocked,
           analyzed, new_relevant AS newRelevant, total_relevant AS totalRelevant, notified
    FROM run_stats WHERE run_id = ? ORDER BY total_relevant DESC, found DESC
  `);
  return runs.map(r => ({
    id: r.id,
    ranAt: r.ran_at,
    totals: {
      found: r.total_found, new: r.total_new, blocked: r.total_blocked,
      analyzed: r.total_analyzed, newRelevant: r.total_new_relevant,
      relevant: r.total_relevant, notified: r.total_notified,
    },
    rows: rowStmt.all(r.id),
  }));
}

// All-time per-source aggregates straight from the jobs table (always available).
export function getAllTimeBySource(clientId) {
  return db.prepare(`
    SELECT source,
           COUNT(*)                                            AS found,
           SUM(CASE WHEN analyzed_at IS NOT NULL THEN 1 ELSE 0 END) AS analyzed,
           SUM(CASE WHEN relevant = 1 THEN 1 ELSE 0 END)       AS relevant,
           SUM(CASE WHEN notified = 1 THEN 1 ELSE 0 END)       AS notified,
           SUM(CASE WHEN applied  = 1 THEN 1 ELSE 0 END)       AS applied
    FROM jobs
    WHERE client_id = ? AND source IS NOT NULL AND source <> ''
    GROUP BY source
    ORDER BY relevant DESC, found DESC
  `).all(clientId);
}

// Application activity by calendar day (for the contribution heatmap).
export function getApplicationActivity(clientId) {
  const rows = db.prepare(`
    SELECT date(applied_at, 'localtime') AS day, COUNT(*) AS count
    FROM jobs WHERE client_id = ? AND applied = 1 AND applied_at IS NOT NULL
    GROUP BY day
  `).all(clientId);
  return Object.fromEntries(rows.map(r => [r.day, r.count]));
}

export function getScoreDistribution(clientId) {
  const rows = db.prepare(`
    SELECT score, COUNT(*) AS count
    FROM jobs WHERE client_id = ? AND relevant = 1 AND score IS NOT NULL
    GROUP BY score ORDER BY score
  `).all(clientId);
  return Object.fromEntries(rows.map(r => [r.score, r.count]));
}

// Companies you applied to most (falls back to source name when company is empty).
export function getAppliedByCompany(clientId) {
  return db.prepare(`
    SELECT COALESCE(NULLIF(company, ''), source) AS label, COUNT(*) AS count
    FROM jobs WHERE client_id = ? AND applied = 1
    GROUP BY label ORDER BY count DESC, label ASC
  `).all(clientId);
}

export function getStatusBreakdown(clientId) {
  const rows = db.prepare(`
    SELECT COALESCE(status, 'applied') AS status, COUNT(*) AS count
    FROM jobs WHERE client_id = ? AND applied = 1 GROUP BY status
  `).all(clientId);
  return Object.fromEntries(rows.map(r => [r.status, r.count]));
}

export function getRunHistory(clientId, limit = 30) {
  return db.prepare('SELECT * FROM runs WHERE client_id = ? ORDER BY id DESC LIMIT ?').all(clientId, limit).reverse();
}

export function getTotals(clientId) {
  return db.prepare(`
    SELECT
      COUNT(*)                                          AS total,
      SUM(CASE WHEN relevant = 1 THEN 1 ELSE 0 END)     AS relevant,
      SUM(CASE WHEN notified = 1 THEN 1 ELSE 0 END)     AS notified,
      SUM(CASE WHEN applied  = 1 THEN 1 ELSE 0 END)     AS applied,
      SUM(CASE WHEN expired  = 1 THEN 1 ELSE 0 END)     AS expired
    FROM jobs WHERE client_id = ?
  `).get(clientId);
}

export function close() {
  db.close();
}

// ── Backup & restore ─────────────────────────────────────────────────────────

// Remove a SQLite DB file together with any WAL/SHM/journal sidecars. Used to tidy
// up temp/staging databases so the backup folder never accumulates orphan sidecars.
export function rmDbFiles(p) {
  for (const ext of ['', '-wal', '-shm', '-journal']) {
    try { rmSync(p + ext, { force: true }); } catch { /* best effort */ }
  }
}

// Fold the write-ahead log back into the main DB file and shrink it to zero. Call
// after each run (and before every backup) so the live -wal can't grow without
// bound and a snapshot always reflects a fully checkpointed file. TRUNCATE only
// fully resets the -wal when no other connection is mid-read; otherwise it still
// checkpoints what it can. Never throws — a busy checkpoint is harmless and simply
// retried on the next call.
export function checkpointWal() {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (err) {
    log(`WAL checkpoint skipped: ${err.message}`);
  }
}

// WAL-safe, point-in-time consistent snapshot of the live DB into a single file.
// SQLite's online backup copies pages while other queries keep running, so callers
// may run this during an active pipeline run without blocking or corrupting it.
export async function backupTo(dest) {
  // Fold the WAL into the main file first so the snapshot reflects every committed
  // write — a large un-checkpointed WAL must never make the copy miss recent rows.
  checkpointWal();
  await db.backup(dest);
}

// Verify a file really is one of our SQLite DBs and is not corrupt, BEFORE it is
// ever used as a restore source. Throws a descriptive error otherwise.
export function validateBackup(srcPath) {
  let probe;
  try {
    probe = new Database(srcPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    throw new Error(`Datei ist keine lesbare SQLite-Datenbank: ${err.message}`);
  }
  try {
    const integ = probe.pragma('integrity_check', { simple: true });
    if (integ !== 'ok') throw new Error(`Integritätsprüfung fehlgeschlagen (${integ}).`);
    const tables = new Set(
      probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
    );
    const missing = DATA_TABLES.filter(t => !tables.has(t));
    if (missing.length) throw new Error(`Backup unvollständig — fehlende Tabellen: ${missing.join(', ')}.`);
  } finally {
    probe.close();
  }
}

// Replace ALL data in the live DB with the contents of a backup file, atomically.
// Steps: validate → upgrade a throwaway copy of the backup to the current schema
// (so an older backup's columns line up) → ATTACH it → wipe+refill every table in
// ONE transaction. Any failure rolls back, leaving the live DB exactly as it was.
export function restoreFromBackup(srcPath) {
  validateBackup(srcPath);

  // Work on a copy so the (read-only) backup file is never modified, and so the
  // schema upgrade can't touch the original.
  const tmp = `${DB_PATH}.restore-${Date.now()}.tmp`;
  copyFileSync(srcPath, tmp);
  try {
    // Bring the copy up to the current schema, then make sure WAL is fully folded
    // back into the main file so the single ATTACH below sees all rows.
    const staged = new Database(tmp);
    migrateSchema(staged);
    // Fold any WAL back into the main file and switch to a rollback journal, so the
    // single ATTACH below sees every row and no WAL/SHM sidecars linger.
    staged.pragma('wal_checkpoint(TRUNCATE)');
    staged.pragma('journal_mode = DELETE');
    staged.close();

    db.exec(`ATTACH DATABASE '${tmp.replace(/'/g, "''")}' AS restore`);
    try {
      const swap = db.transaction(() => {
        for (const table of DATA_TABLES) {
          // Copy only columns that exist on BOTH sides (post-migration they match,
          // but this stays correct even if a future column lands on just one side).
          const liveCols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
          const bakCols = new Set(
            db.prepare(`PRAGMA restore.table_info(${table})`).all().map(c => c.name)
          );
          const cols = liveCols.filter(c => bakCols.has(c));
          const colList = cols.map(c => `"${c}"`).join(', ');
          db.prepare(`DELETE FROM main.${table}`).run();
          db.prepare(`INSERT INTO main.${table} (${colList}) SELECT ${colList} FROM restore.${table}`).run();
        }
      });
      swap();
    } finally {
      db.exec('DETACH DATABASE restore');
    }
    // Safety net: ensure the live schema is current (normally a no-op).
    migrateSchema(db);
  } finally {
    rmDbFiles(tmp);
  }
}
