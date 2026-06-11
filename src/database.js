import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'jobs.db');

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

  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id          TEXT PRIMARY KEY,
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
      analyzed_at TEXT
    );
  `);

  // Per-run overview snapshots — persists the LAUF-ÜBERSICHT table so the GUI can
  // show real per-run counters (which are otherwise only printed to the log).
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
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

  // Migrate: add columns for existing DBs
  const cols = db.prepare("PRAGMA table_info(jobs)").all().map(r => r.name);
  if (!cols.includes('score'))        db.exec('ALTER TABLE jobs ADD COLUMN score        INTEGER');
  if (!cols.includes('summary'))      db.exec('ALTER TABLE jobs ADD COLUMN summary      TEXT');
  if (!cols.includes('last_seen_at')) {
    db.exec('ALTER TABLE jobs ADD COLUMN last_seen_at TEXT');
    // Seed existing rows with scraped_at so they aren't instantly treated as expired
    db.exec("UPDATE jobs SET last_seen_at = scraped_at WHERE last_seen_at IS NULL");
  }
  if (!cols.includes('expired'))      db.exec('ALTER TABLE jobs ADD COLUMN expired      INTEGER DEFAULT 0');
  if (!cols.includes('applied'))      db.exec('ALTER TABLE jobs ADD COLUMN applied      INTEGER DEFAULT 0');
  if (!cols.includes('applied_at'))   db.exec('ALTER TABLE jobs ADD COLUMN applied_at   TEXT');
  if (!cols.includes('status'))       db.exec('ALTER TABLE jobs ADD COLUMN status        TEXT');

  return db;
}

const db = openDb();
log(`Database ready at ${DB_PATH}`);

export function isNewJob(id) {
  const row = db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(id);
  return !row;
}

export function saveJob(job) {
  db.prepare(`
    INSERT OR IGNORE INTO jobs
      (id, title, company, url, location, description, source, relevant, notified, scraped_at)
    VALUES
      (@id, @title, @company, @url, @location, @description, @source, NULL, 0, @scraped_at)
  `).run({
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

export function markAnalyzed(id, relevant, score = null, summary = null) {
  db.prepare(`
    UPDATE jobs
    SET relevant = ?, score = ?, summary = ?, analyzed_at = ?
    WHERE id = ?
  `).run(relevant ? 1 : 0, score, summary, new Date().toISOString(), id);
}

export function getRelevantJobs() {
  return db.prepare(`
    SELECT id, title, company, location, url, score, summary, source, scraped_at,
           applied, applied_at, status
    FROM jobs
    WHERE relevant = 1
    ORDER BY applied DESC, score DESC, scraped_at DESC
  `).all();
}

export function getJobById(id) {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

export function setApplicationStatus(id, status) {
  db.prepare(`
    UPDATE jobs SET
      applied    = 1,
      applied_at = CASE WHEN applied_at IS NULL THEN ? ELSE applied_at END,
      status     = ?
    WHERE id = ?
  `).run(new Date().toISOString(), status, id);
}

export function clearApplicationStatus(id) {
  db.prepare(`
    UPDATE jobs SET applied = 0, applied_at = NULL, status = NULL WHERE id = ?
  `).run(id);
}

export function getAppliedJobs() {
  return db.prepare(`
    SELECT id, title, company, location, url, score, status, applied_at
    FROM jobs WHERE applied = 1
    ORDER BY applied_at DESC
  `).all();
}

export function markNotified(id) {
  db.prepare('UPDATE jobs SET notified = 1 WHERE id = ?').run(id);
}

export function getUnanalyzedJobs() {
  return db.prepare('SELECT * FROM jobs WHERE relevant IS NULL').all();
}

export function getRelevantUnnotifiedJobs() {
  return db.prepare('SELECT * FROM jobs WHERE relevant = 1 AND notified = 0').all();
}

export function getRelevantCountBySource() {
  const rows = db.prepare('SELECT source, COUNT(*) as cnt FROM jobs WHERE relevant = 1 GROUP BY source').all();
  return Object.fromEntries(rows.map(r => [r.source, r.cnt]));
}

// Mark every job in the given id list as seen right now.
export function updateLastSeenBatch(ids) {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  const stmt = db.prepare('UPDATE jobs SET last_seen_at = ? WHERE id = ?');
  db.transaction(() => { for (const id of ids) stmt.run(now, id); })();
}

// Jobs that were notified but haven't appeared in any scrape for `thresholdHours`.
export function getJobsToExpire(thresholdHours = 72) {
  const cutoff = new Date(Date.now() - thresholdHours * 60 * 60 * 1000).toISOString();
  return db.prepare(`
    SELECT * FROM jobs
    WHERE notified = 1 AND relevant = 1 AND (expired = 0 OR expired IS NULL)
      AND last_seen_at IS NOT NULL AND last_seen_at < ?
  `).all(cutoff);
}

export function markExpired(id) {
  db.prepare('UPDATE jobs SET expired = 1 WHERE id = ?').run(id);
}

export function markIrrelevant(id) {
  db.prepare('UPDATE jobs SET relevant = 0, analyzed_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id);
}

export function getJobsWithEmptyDescription() {
  return db.prepare(
    "SELECT * FROM jobs WHERE (description IS NULL OR description = '') AND (expired = 0 OR expired IS NULL)"
  ).all();
}

export function updateJobDescription(id, description) {
  db.prepare(`
    UPDATE jobs
    SET description = ?, relevant = NULL, analyzed_at = NULL, score = NULL, summary = NULL
    WHERE id = ?
  `).run(description, id);
}

// ── Stats / overview ─────────────────────────────────────────────────────--

// Persist one run's per-source overview. `rows` items:
//   { source, found, siteTotal, newDb, blocked, analyzed, newRelevant, totalRelevant, notified }
export function saveRunSnapshot(rows) {
  const sum = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const info = db.prepare(`
    INSERT INTO runs
      (ran_at, total_found, total_new, total_blocked, total_analyzed, total_new_relevant, total_relevant, total_notified)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
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
export function getLatestRunOverview() {
  const run = db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get();
  if (!run) return null;
  const rows = db.prepare(`
    SELECT source, found, site_total AS siteTotal, new_db AS newDb, blocked,
           analyzed, new_relevant AS newRelevant, total_relevant AS totalRelevant, notified
    FROM run_stats WHERE run_id = ? ORDER BY total_relevant DESC, found DESC
  `).all(run.id);
  return { ranAt: run.ran_at, rows };
}

// All-time per-source aggregates straight from the jobs table (always available).
export function getAllTimeBySource() {
  return db.prepare(`
    SELECT source,
           COUNT(*)                                            AS found,
           SUM(CASE WHEN analyzed_at IS NOT NULL THEN 1 ELSE 0 END) AS analyzed,
           SUM(CASE WHEN relevant = 1 THEN 1 ELSE 0 END)       AS relevant,
           SUM(CASE WHEN notified = 1 THEN 1 ELSE 0 END)       AS notified,
           SUM(CASE WHEN applied  = 1 THEN 1 ELSE 0 END)       AS applied
    FROM jobs
    WHERE source IS NOT NULL AND source <> ''
    GROUP BY source
    ORDER BY relevant DESC, found DESC
  `).all();
}

// Application activity by calendar day (for the contribution heatmap).
export function getApplicationActivity() {
  // 'localtime' so days are grouped by the local calendar date, matching the
  // local-day keys the heatmap builds on the client (avoids a UTC-offset shift).
  const rows = db.prepare(`
    SELECT date(applied_at, 'localtime') AS day, COUNT(*) AS count
    FROM jobs WHERE applied = 1 AND applied_at IS NOT NULL
    GROUP BY day
  `).all();
  return Object.fromEntries(rows.map(r => [r.day, r.count]));
}

export function getScoreDistribution() {
  const rows = db.prepare(`
    SELECT score, COUNT(*) AS count
    FROM jobs WHERE relevant = 1 AND score IS NOT NULL
    GROUP BY score ORDER BY score
  `).all();
  return Object.fromEntries(rows.map(r => [r.score, r.count]));
}

// Companies you applied to most (falls back to source name when company is empty).
export function getAppliedByCompany() {
  return db.prepare(`
    SELECT COALESCE(NULLIF(company, ''), source) AS label, COUNT(*) AS count
    FROM jobs WHERE applied = 1
    GROUP BY label ORDER BY count DESC, label ASC
  `).all();
}

export function getStatusBreakdown() {
  const rows = db.prepare(`
    SELECT COALESCE(status, 'applied') AS status, COUNT(*) AS count
    FROM jobs WHERE applied = 1 GROUP BY status
  `).all();
  return Object.fromEntries(rows.map(r => [r.status, r.count]));
}

export function getRunHistory(limit = 30) {
  return db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit).reverse();
}

export function getTotals() {
  return db.prepare(`
    SELECT
      COUNT(*)                                          AS total,
      SUM(CASE WHEN relevant = 1 THEN 1 ELSE 0 END)     AS relevant,
      SUM(CASE WHEN notified = 1 THEN 1 ELSE 0 END)     AS notified,
      SUM(CASE WHEN applied  = 1 THEN 1 ELSE 0 END)     AS applied,
      SUM(CASE WHEN expired  = 1 THEN 1 ELSE 0 END)     AS expired
    FROM jobs
  `).get();
}

export function close() {
  db.close();
}
