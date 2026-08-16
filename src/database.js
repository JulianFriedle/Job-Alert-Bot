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
export const DATA_TABLES = [
  'clients', 'jobs', 'runs', 'run_stats', 'status_history',
  'client_credentials', 'applications', 'application_events',
  'telegram_prompts', 'telegram_messages', 'answer_library',
];

// Tables a backup MUST contain to be restorable. Kept separate from DATA_TABLES
// so backups taken before the auto-apply tables existed stay restorable — the
// newer tables are created empty on the staged copy during restore.
export const CORE_TABLES = ['clients', 'jobs', 'runs', 'run_stats', 'status_history'];

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

  createSchema(db);
  migrateSchema(db);
  ensureDefaultClient(db);

  return db;
}

// All CREATE TABLE IF NOT EXISTS blocks live here (not inline in openDb) so a
// restore can bring a staged copy of an older backup up to the full current
// schema before the table-by-table copy runs.
function createSchema(db) {
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
      easy_apply  INTEGER,
      platform    TEXT,
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

  // ── Auto-apply: platform credentials ─────────────────────────────────────────
  // Per-client login for LinkedIn/StepStone/Indeed. email/password are AES-256-GCM
  // blobs (see src/credentials.js) — never stored in plain text.
  db.exec(`
    CREATE TABLE IF NOT EXISTS client_credentials (
      client_id     TEXT NOT NULL,
      platform      TEXT NOT NULL,
      email_enc     TEXT,
      password_enc  TEXT,
      login_state   TEXT DEFAULT 'unknown',
      last_login_at TEXT,
      updated_at    TEXT,
      PRIMARY KEY (client_id, platform)
    );
  `);

  // ── Auto-apply: application queue + audit trail ──────────────────────────────
  // One row per (client, job) application attempt; `state` is the state machine
  // (queued → preparing → awaiting_answers → ready_for_review → approved →
  // submitting → submitted, plus failed/discarded). Transitions happen ONLY via
  // claimApplication's atomic compare-and-set so GUI/worker/Telegram can't race.
  db.exec(`
    CREATE TABLE IF NOT EXISTS applications (
      id             TEXT PRIMARY KEY,
      client_id      TEXT NOT NULL,
      job_id         TEXT NOT NULL,
      platform       TEXT NOT NULL,
      state          TEXT NOT NULL DEFAULT 'queued',
      cover_letter   TEXT,
      questions_json TEXT,
      error          TEXT,
      attempts       INTEGER DEFAULT 0,
      created_at     TEXT,
      prepared_at    TEXT,
      approved_at    TEXT,
      submitted_at   TEXT,
      updated_at     TEXT,
      UNIQUE (client_id, job_id)
    );
    CREATE INDEX IF NOT EXISTS idx_applications_state  ON applications (state);
    CREATE INDEX IF NOT EXISTS idx_applications_client ON applications (client_id, state);
    CREATE TABLE IF NOT EXISTS application_events (
      application_id TEXT NOT NULL,
      event          TEXT NOT NULL,
      detail         TEXT,
      created_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_app_events ON application_events (application_id);
  `);

  // ── Telegram correlation tables ──────────────────────────────────────────────
  // telegram_prompts: maps a sent question message to (application, question) so a
  // reply can be routed. telegram_messages: maps job notifications / review
  // messages to jobs so emoji reactions and text replies can update status.
  db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_prompts (
      chat_id        TEXT NOT NULL,
      message_id     INTEGER NOT NULL,
      application_id TEXT NOT NULL,
      question_id    TEXT NOT NULL,
      answered       INTEGER DEFAULT 0,
      sent_at        TEXT,
      PRIMARY KEY (chat_id, message_id)
    );
    CREATE TABLE IF NOT EXISTS telegram_messages (
      chat_id    TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      client_id  TEXT NOT NULL,
      job_id     TEXT NOT NULL,
      kind       TEXT DEFAULT 'notification',
      sent_at    TEXT,
      PRIMARY KEY (chat_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_telegram_messages_job ON telegram_messages (client_id, job_id);
  `);

  // ── Answer library ───────────────────────────────────────────────────────────
  // Remembered screening-question answers per client. question_key is the
  // normalized label (lowercase, trimmed, punctuation stripped) so the same
  // question re-asked by another posting is matched and pre-filled.
  db.exec(`
    CREATE TABLE IF NOT EXISTS answer_library (
      client_id    TEXT NOT NULL,
      question_key TEXT NOT NULL,
      label        TEXT,
      type         TEXT,
      options_json TEXT,
      answer       TEXT,
      use_count    INTEGER DEFAULT 0,
      updated_at   TEXT,
      PRIMARY KEY (client_id, question_key)
    );
  `);
}

// Idempotent migrations for DBs created before multi-tenancy. The jobs table is
// rebuilt only when it still lacks a client_id column (old single-user schema),
// because SQLite can't ALTER a primary key in place.
function migrateSchema(db) {
  const jobCols = db.prepare("PRAGMA table_info(jobs)").all().map(r => r.name);

  // Legacy per-column adds (older single-user DBs that predate these columns)
  if (!jobCols.includes('score'))        db.exec('ALTER TABLE jobs ADD COLUMN score        INTEGER');
  if (!jobCols.includes('summary'))      db.exec('ALTER TABLE jobs ADD COLUMN summary      TEXT');
  if (!jobCols.includes('analyzed_at'))  db.exec('ALTER TABLE jobs ADD COLUMN analyzed_at  TEXT');
  if (!jobCols.includes('last_seen_at')) {
    db.exec('ALTER TABLE jobs ADD COLUMN last_seen_at TEXT');
    db.exec("UPDATE jobs SET last_seen_at = scraped_at WHERE last_seen_at IS NULL");
  }
  if (!jobCols.includes('expired'))      db.exec('ALTER TABLE jobs ADD COLUMN expired      INTEGER DEFAULT 0');
  if (!jobCols.includes('applied'))      db.exec('ALTER TABLE jobs ADD COLUMN applied      INTEGER DEFAULT 0');
  if (!jobCols.includes('applied_at'))   db.exec('ALTER TABLE jobs ADD COLUMN applied_at   TEXT');
  if (!jobCols.includes('status'))       db.exec('ALTER TABLE jobs ADD COLUMN status        TEXT');
  // Platform-scraper columns: easy_apply is 1/0/NULL (NULL = unknown, e.g.
  // LinkedIn guest search doesn't expose it); platform is linkedin|stepstone|indeed.
  if (!jobCols.includes('easy_apply'))   db.exec('ALTER TABLE jobs ADD COLUMN easy_apply   INTEGER');
  if (!jobCols.includes('platform'))     db.exec('ALTER TABLE jobs ADD COLUMN platform     TEXT');

  const clientCols = db.prepare("PRAGMA table_info(clients)").all().map(r => r.name);
  if (!clientCols.includes('auto_apply'))
    db.exec("ALTER TABLE clients ADD COLUMN auto_apply TEXT DEFAULT 'off'");
  if (!clientCols.includes('max_applies_per_day'))
    db.exec('ALTER TABLE clients ADD COLUMN max_applies_per_day INTEGER');

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
          easy_apply  INTEGER, platform TEXT,
          PRIMARY KEY (client_id, id)
        );
      `);
      // easy_apply/platform exist on the legacy table at this point — the
      // guarded ALTERs above run before the rebuild.
      db.exec(`
        INSERT INTO jobs (client_id, id, title, company, url, location, description, source,
                          relevant, score, summary, notified, scraped_at, analyzed_at, last_seen_at,
                          expired, applied, applied_at, status, easy_apply, platform)
        SELECT '${DEFAULT_CLIENT_ID}', id, title, company, url, location, description, source,
               relevant, score, summary, notified, scraped_at, analyzed_at, last_seen_at,
               expired, applied, applied_at, status, easy_apply, platform
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
  'auto_apply', 'max_applies_per_day',
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
    db.prepare('DELETE FROM status_history WHERE client_id = ?').run(id);
    db.prepare('DELETE FROM application_events WHERE application_id IN (SELECT id FROM applications WHERE client_id = ?)').run(id);
    db.prepare('DELETE FROM telegram_prompts WHERE application_id IN (SELECT id FROM applications WHERE client_id = ?)').run(id);
    db.prepare('DELETE FROM applications WHERE client_id = ?').run(id);
    db.prepare('DELETE FROM client_credentials WHERE client_id = ?').run(id);
    db.prepare('DELETE FROM telegram_messages WHERE client_id = ?').run(id);
    db.prepare('DELETE FROM answer_library WHERE client_id = ?').run(id);
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
  // last_seen_at is set on insert: updateLastSeenBatch runs BEFORE new jobs are
  // saved (it only matches existing rows), and expiry requires a non-NULL value.
  db.prepare(`
    INSERT OR IGNORE INTO jobs
      (client_id, id, title, company, url, location, description, source, relevant, notified, scraped_at,
       last_seen_at, easy_apply, platform)
    VALUES
      (@client_id, @id, @title, @company, @url, @location, @description, @source, NULL, 0, @scraped_at,
       @scraped_at, @easy_apply, @platform)
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
    easy_apply: job.easyApply == null ? null : (job.easyApply ? 1 : 0),
    platform: job.platform ?? null,
  });
}

export function setJobEasyApply(clientId, id, easyApply) {
  db.prepare('UPDATE jobs SET easy_apply = ? WHERE client_id = ? AND id = ?')
    .run(easyApply == null ? null : (easyApply ? 1 : 0), clientId, id);
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
    SELECT j.id, j.title, j.company, j.location, j.url, j.score, j.summary, j.source, j.scraped_at,
           j.applied, j.applied_at, j.status, j.platform, j.easy_apply,
           a.id AS application_id, a.state AS application_state
    FROM jobs j
    LEFT JOIN applications a ON a.client_id = j.client_id AND a.job_id = j.id
    WHERE j.client_id = ? AND j.relevant = 1
    ORDER BY j.applied DESC, j.score DESC, j.scraped_at DESC
  `).all(clientId);
}

// Same set of rows (and the same order) as getRelevantJobs, but with every
// column the CSV export offers — including the full description and the
// analysis/expiry timestamps the dashboard list doesn't need.
export function getRelevantJobsDetailed(clientId) {
  return db.prepare(`
    SELECT j.id, j.title, j.company, j.location, j.url, j.description, j.score, j.summary,
           j.source, j.scraped_at, j.analyzed_at, j.last_seen_at, j.expired,
           j.applied, j.applied_at, j.status, j.platform, j.easy_apply,
           a.id AS application_id, a.state AS application_state
    FROM jobs j
    LEFT JOIN applications a ON a.client_id = j.client_id AND a.job_id = j.id
    WHERE j.client_id = ? AND j.relevant = 1
    ORDER BY j.applied DESC, j.score DESC, j.scraped_at DESC
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
  const runStmt = db.prepare(`
    INSERT INTO runs
      (client_id, ran_at, total_found, total_new, total_blocked, total_analyzed, total_new_relevant, total_relevant, total_notified)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const stmt = db.prepare(`
    INSERT INTO run_stats
      (run_id, source, found, site_total, new_db, blocked, analyzed, new_relevant, total_relevant, notified)
    VALUES (@run_id, @source, @found, @site_total, @new_db, @blocked, @analyzed, @new_relevant, @total_relevant, @notified)
  `);
  // Parent + children in ONE transaction — a failing child insert must not
  // leave an orphan runs row behind.
  return db.transaction(() => {
    const info = runStmt.run(
      clientId,
      new Date().toISOString(),
      sum('found'), sum('newDb'), sum('blocked'), sum('analyzed'),
      sum('newRelevant'), sum('totalRelevant'), sum('notified')
    );
    const runId = info.lastInsertRowid;
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
    return runId;
  })();
}


// All recorded runs aggregated per source. Flow counters (found, new, blocked,
// analyzed, new-relevant, notified) are summed across every run; snapshot
// counters (per-site total, total-relevant) keep their most recent value.
// Powers the combined "Lauf-Übersicht" on the stats page.
export function getCombinedRunOverview(clientId) {
  const meta = db.prepare(
    'SELECT COUNT(*) AS runCount, MIN(ran_at) AS firstRanAt, MAX(ran_at) AS lastRanAt FROM runs WHERE client_id = ?'
  ).get(clientId);
  if (!meta || !meta.runCount) return null;
  const rows = db.prepare(`
    SELECT rs.source                       AS source,
           SUM(rs.found)                   AS found,
           SUM(rs.new_db)                  AS newDb,
           SUM(rs.blocked)                 AS blocked,
           SUM(rs.analyzed)                AS analyzed,
           SUM(rs.new_relevant)            AS newRelevant,
           SUM(rs.notified)                AS notified,
           (SELECT rs2.site_total FROM run_stats rs2 JOIN runs r2 ON r2.id = rs2.run_id
              WHERE r2.client_id = @cid AND rs2.source = rs.source
              ORDER BY r2.id DESC LIMIT 1) AS siteTotal,
           (SELECT rs3.total_relevant FROM run_stats rs3 JOIN runs r3 ON r3.id = rs3.run_id
              WHERE r3.client_id = @cid AND rs3.source = rs.source
              ORDER BY r3.id DESC LIMIT 1) AS totalRelevant
    FROM run_stats rs JOIN runs r ON r.id = rs.run_id
    WHERE r.client_id = @cid
    GROUP BY rs.source
    ORDER BY totalRelevant DESC, found DESC
  `).all({ cid: clientId });
  return { combined: true, runCount: meta.runCount, firstRanAt: meta.firstRanAt, lastRanAt: meta.lastRanAt, rows };
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

// Companies you applied to most (falls back to source name when company is empty).
export function getAppliedByCompany(clientId) {
  return db.prepare(`
    SELECT COALESCE(NULLIF(company, ''), source) AS label, COUNT(*) AS count
    FROM jobs WHERE client_id = ? AND applied = 1
    GROUP BY label ORDER BY count DESC, label ASC
  `).all(clientId);
}

export function getStatusBreakdown(clientId) {
  // GROUP BY must repeat the COALESCE: a bare `GROUP BY status` resolves to the
  // raw column (SQLite prefers source columns over result aliases), yielding two
  // 'applied' rows that Object.fromEntries would collapse — dropping legacy
  // NULL-status applications from the funnel.
  const rows = db.prepare(`
    SELECT COALESCE(status, 'applied') AS status, COUNT(*) AS count
    FROM jobs WHERE client_id = ? AND applied = 1 GROUP BY COALESCE(status, 'applied')
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

// ── Applications (auto-apply queue) ──────────────────────────────────────────

// Fields updateApplication may touch. `state` is deliberately NOT here — state
// changes go through claimApplication only, so no code path can skip the
// compare-and-set guard.
const APPLICATION_FIELDS = [
  'cover_letter', 'questions_json', 'error', 'attempts',
  'prepared_at', 'approved_at', 'submitted_at',
];

export function createApplication(clientId, jobId, platform) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO applications (id, client_id, job_id, platform, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'queued', ?, ?)
  `).run(randomUUID(), clientId, jobId, platform, now, now);
  return getApplicationByJob(clientId, jobId);
}

export function getApplicationById(id) {
  return db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
}

export function getApplicationByJob(clientId, jobId) {
  return db.prepare('SELECT * FROM applications WHERE client_id = ? AND job_id = ?').get(clientId, jobId);
}

// List a client's applications (newest first), joined with the job's headline
// fields so the GUI can render the queue without extra lookups.
export function getApplications(clientId, { state } = {}) {
  const where = state ? 'a.client_id = ? AND a.state = ?' : 'a.client_id = ?';
  const params = state ? [clientId, state] : [clientId];
  return db.prepare(`
    SELECT a.*, j.title, j.company, j.location, j.url, j.score
    FROM applications a
    LEFT JOIN jobs j ON j.client_id = a.client_id AND j.id = a.job_id
    WHERE ${where}
    ORDER BY a.created_at DESC
  `).all(...params);
}

// Partial update of non-state fields (whitelisted).
export function updateApplication(id, patch) {
  const sets = [];
  const params = { id, updated_at: new Date().toISOString() };
  for (const f of APPLICATION_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, f)) {
      sets.push(`${f} = @${f}`);
      params[f] = patch[f] ?? null;
    }
  }
  if (sets.length) {
    db.prepare(`UPDATE applications SET ${sets.join(', ')}, updated_at = @updated_at WHERE id = @id`).run(params);
  }
  return getApplicationById(id);
}

// The ONLY way to change an application's state: an atomic compare-and-set.
// Returns true when this caller won the transition; false means someone else
// (GUI, Telegram button, worker) already moved the row — back off.
export function claimApplication(id, fromState, toState) {
  const res = db.prepare(`
    UPDATE applications SET state = ?, updated_at = ? WHERE id = ? AND state = ?
  `).run(toState, new Date().toISOString(), id, fromState);
  return res.changes === 1;
}

// Oldest application in a state — the worker's work queue (across all clients).
export function getNextApplicationByState(state) {
  return db.prepare(
    'SELECT * FROM applications WHERE state = ? ORDER BY created_at ASC LIMIT 1'
  ).get(state);
}

export function getApplicationsByState(state) {
  return db.prepare('SELECT * FROM applications WHERE state = ? ORDER BY created_at ASC').all(state);
}

export function logApplicationEvent(applicationId, event, detail = null) {
  db.prepare(`
    INSERT INTO application_events (application_id, event, detail, created_at) VALUES (?, ?, ?, ?)
  `).run(applicationId, event, detail, new Date().toISOString());
}

export function getApplicationEvents(applicationId) {
  return db.prepare(
    'SELECT event, detail, created_at FROM application_events WHERE application_id = ? ORDER BY created_at ASC'
  ).all(applicationId);
}

// Safety-rail queries: submissions in the local calendar day / most recent one.
export function countSubmittedToday(clientId, platform) {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM applications
    WHERE client_id = ? AND platform = ? AND state = 'submitted'
      AND date(submitted_at, 'localtime') = date('now', 'localtime')
  `).get(clientId, platform);
  return row.n;
}

export function getLastSubmittedAt(platform) {
  const row = db.prepare(`
    SELECT MAX(submitted_at) AS last FROM applications WHERE platform = ? AND state = 'submitted'
  `).get(platform);
  return row?.last || null;
}

// ── Platform credentials (encrypted blobs — see src/credentials.js) ──────────

export function getCredentialRow(clientId, platform) {
  return db.prepare('SELECT * FROM client_credentials WHERE client_id = ? AND platform = ?')
    .get(clientId, platform);
}

export function listCredentialRows(clientId) {
  return db.prepare('SELECT * FROM client_credentials WHERE client_id = ?').all(clientId);
}

export function setCredentialRow(clientId, platform, { email_enc, password_enc }) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO client_credentials (client_id, platform, email_enc, password_enc, login_state, updated_at)
    VALUES (@client_id, @platform, @email_enc, @password_enc, 'unknown', @now)
    ON CONFLICT (client_id, platform) DO UPDATE SET
      email_enc    = COALESCE(@email_enc, email_enc),
      password_enc = COALESCE(@password_enc, password_enc),
      login_state  = 'unknown',
      updated_at   = @now
  `).run({ client_id: clientId, platform, email_enc: email_enc ?? null, password_enc: password_enc ?? null, now });
}

export function deleteCredentialRow(clientId, platform) {
  db.prepare('DELETE FROM client_credentials WHERE client_id = ? AND platform = ?').run(clientId, platform);
}

export function setLoginState(clientId, platform, state, { touchLogin = false } = {}) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE client_credentials SET login_state = ?, last_login_at = CASE WHEN ? THEN ? ELSE last_login_at END
    WHERE client_id = ? AND platform = ?
  `).run(state, touchLogin ? 1 : 0, now, clientId, platform);
}

// ── Telegram correlation ─────────────────────────────────────────────────────

export function recordTelegramMessage(chatId, messageId, clientId, jobId, kind = 'notification') {
  db.prepare(`
    INSERT OR REPLACE INTO telegram_messages (chat_id, message_id, client_id, job_id, kind, sent_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(String(chatId), messageId, clientId, jobId, kind, new Date().toISOString());
}

export function getTelegramMessage(chatId, messageId) {
  return db.prepare('SELECT * FROM telegram_messages WHERE chat_id = ? AND message_id = ?')
    .get(String(chatId), messageId);
}

export function recordTelegramPrompt(chatId, messageId, applicationId, questionId) {
  db.prepare(`
    INSERT OR REPLACE INTO telegram_prompts (chat_id, message_id, application_id, question_id, answered, sent_at)
    VALUES (?, ?, ?, ?, 0, ?)
  `).run(String(chatId), messageId, applicationId, questionId, new Date().toISOString());
}

export function getTelegramPrompt(chatId, messageId) {
  return db.prepare('SELECT * FROM telegram_prompts WHERE chat_id = ? AND message_id = ?')
    .get(String(chatId), messageId);
}

export function getOpenTelegramPrompts(chatId) {
  return db.prepare('SELECT * FROM telegram_prompts WHERE chat_id = ? AND answered = 0 ORDER BY sent_at ASC')
    .all(String(chatId));
}

export function markTelegramPromptAnswered(chatId, messageId) {
  db.prepare('UPDATE telegram_prompts SET answered = 1 WHERE chat_id = ? AND message_id = ?')
    .run(String(chatId), messageId);
}

// Cancel every open prompt of an application (e.g. the GUI answered the
// questions) so a late Telegram reply to a stale prompt is ignored.
export function closeTelegramPromptsForApplication(applicationId) {
  db.prepare('UPDATE telegram_prompts SET answered = 1 WHERE application_id = ?').run(applicationId);
}

// ── Answer library (remembered screening-question answers) ───────────────────

export function getLibraryAnswer(clientId, questionKey) {
  return db.prepare('SELECT * FROM answer_library WHERE client_id = ? AND question_key = ?')
    .get(clientId, questionKey);
}

export function getLibraryAnswers(clientId) {
  return db.prepare('SELECT * FROM answer_library WHERE client_id = ? ORDER BY updated_at DESC').all(clientId);
}

export function upsertLibraryAnswer(clientId, { question_key, label, type, options_json, answer }) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO answer_library (client_id, question_key, label, type, options_json, answer, use_count, updated_at)
    VALUES (@client_id, @question_key, @label, @type, @options_json, @answer, 1, @now)
    ON CONFLICT (client_id, question_key) DO UPDATE SET
      label = @label, type = @type, options_json = @options_json,
      answer = @answer, use_count = use_count + 1, updated_at = @now
  `).run({ client_id: clientId, question_key, label: label ?? null, type: type ?? null,
           options_json: options_json ?? null, answer: answer ?? null, now });
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
    // better-sqlite3 opens files lazily — a non-DB file only fails HERE, at the
    // first pragma, so the friendly message must wrap this call too.
    let integ;
    try {
      integ = probe.pragma('integrity_check', { simple: true });
    } catch (err) {
      throw new Error(`Datei ist keine lesbare SQLite-Datenbank: ${err.message}`);
    }
    if (integ !== 'ok') throw new Error(`Integritätsprüfung fehlgeschlagen (${integ}).`);
    const tables = new Set(
      probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
    );
    // Only the core tables are required — backups from before the auto-apply
    // tables existed must stay restorable (those tables are created empty).
    const missing = CORE_TABLES.filter(t => !tables.has(t));
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
    // createSchema first: an older backup may lack entire tables (e.g. the
    // auto-apply ones), which migrateSchema's column-adds don't create.
    const staged = new Database(tmp);
    createSchema(staged);
    migrateSchema(staged);
    // Fold any WAL back into the main file and switch to a rollback journal, so the
    // single ATTACH below sees every row and no WAL/SHM sidecars linger.
    staged.pragma('wal_checkpoint(TRUNCATE)');
    staged.pragma('journal_mode = DELETE');
    staged.close();

    // Bring the LIVE schema up to date too, BEFORE computing the column
    // intersection below — otherwise a column present in the backup but still
    // missing live would be silently dropped instead of restored.
    createSchema(db);
    migrateSchema(db);

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
