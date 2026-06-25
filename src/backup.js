// ── Database backups ─────────────────────────────────────────────────────────
// Owns the *filesystem* side of backups: where files live, how they're named,
// read-only protection, retention, and the once-per-day check. The actual DB
// snapshot/restore lives in database.js (backupTo / validateBackup / restoreFromBackup).
//
// Files are full, self-contained SQLite snapshots (WAL-safe). They are stored
// read-only (0o444) so a stray write/redirect can't clobber them; the service
// still owns them, so retention can chmod+unlink its own old daily backups.

import {
  mkdirSync, existsSync, statSync, readdirSync,
  renameSync, chmodSync, unlinkSync, openSync, closeSync, rmSync,
} from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { DB_PATH, backupTo, validateBackup, rmDbFiles } from './database.js';

export const BACKUP_DIR = path.join(path.dirname(DB_PATH), 'backups');
mkdirSync(BACKUP_DIR, { recursive: true });

const KNOWN_TYPES = ['daily', 'manual', 'preimport', 'upload'];
const NAME_RE = new RegExp(`^jobs-(${KNOWN_TYPES.join('|')})-.+\\.db$`);
const LOCK_PATH = path.join(BACKUP_DIR, '.daily.lock');
const LOCK_STALE_MS = 60 * 60 * 1000; // a lock older than 1h is treated as abandoned
const RETENTION_DEFAULT = 30;

function log(msg) { console.log(`[${new Date().toISOString()}] [backup] ${msg}`); }

const pad2 = (n) => String(n).padStart(2, '0');

// Fold any WAL back into the file and switch to a rollback journal, so a backup is
// a single self-contained file: later read-only opens (validate, restore-staging)
// never spawn -wal/-shm sidecars next to the (read-only) backup. Also acts as a
// "is this really a SQLite DB?" check — throws on a non-DB file.
function normalizeDbFile(p) {
  const d = new Database(p);
  try {
    d.pragma('wal_checkpoint(TRUNCATE)');
    d.pragma('journal_mode = DELETE');
  } finally {
    d.close();
  }
}

// Local calendar day + time, matching the app's date(...,'localtime') convention
// so "today's backup" lines up with the user's wall clock.
function localStamp(d = new Date()) {
  return {
    date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    time: `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`,
  };
}

function dailyName(date = localStamp().date) { return `jobs-daily-${date}.db`; }

function fileName(reason) {
  if (reason === 'daily') return dailyName();
  const { date, time } = localStamp();
  return `jobs-${reason}-${date}-${time}.db`;
}

// Describe a backup file for the API/UI. Type comes from the filename prefix.
function meta(file) {
  const st = statSync(path.join(BACKUP_DIR, file));
  const m = file.match(/^jobs-([a-z]+)-/);
  return { file, type: m ? m[1] : 'unknown', size: st.size, createdAt: st.mtime.toISOString() };
}

export function isDailyEnabled() {
  return ['true', '1', 'on', 'yes'].includes(
    String(process.env.BACKUP_ENABLED ?? 'true').trim().toLowerCase()
  );
}

export function retentionDays() {
  const n = parseInt(process.env.BACKUP_RETENTION_DAYS, 10);
  return Number.isFinite(n) && n > 0 ? n : RETENTION_DEFAULT;
}

// Create a snapshot of the live DB. `reason` ∈ daily|manual|preimport. Writes to a
// temp file first, then atomically renames into place and marks it read-only.
export async function createBackup(reason = 'manual') {
  const name = fileName(reason);
  const finalPath = path.join(BACKUP_DIR, name);
  const tmpPath = path.join(BACKUP_DIR, `.${name}.${process.pid}.tmp`);
  try {
    await backupTo(tmpPath);
    normalizeDbFile(tmpPath);          // → clean single-file DB (no sidecars later)
    renameSync(tmpPath, finalPath);
    chmodSync(finalPath, 0o444);
  } catch (err) {
    rmDbFiles(tmpPath);
    rmDbFiles(finalPath);   // rename may have already happened (e.g. chmod failed after)
    throw err;
  }
  log(`Created ${name} (${(statSync(finalPath).size / 1e6).toFixed(1)} MB)`);
  return meta(name);
}

export function listBackups() {
  return readdirSync(BACKUP_DIR)
    .filter(f => NAME_RE.test(f))
    .map(meta)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function todaysDailyBackupExists() {
  return existsSync(path.join(BACKUP_DIR, dailyName()));
}

// Resolve a user-supplied filename to a real path inside BACKUP_DIR, defeating any
// path traversal (we only ever trust the basename). Throws if it doesn't exist.
export function resolveBackupPath(file) {
  const safe = path.basename(String(file || ''));
  if (!NAME_RE.test(safe)) throw new Error('Ungültiger Backup-Dateiname.');
  const full = path.join(BACKUP_DIR, safe);
  if (!existsSync(full)) throw new Error('Backup-Datei nicht gefunden.');
  return full;
}

// Keep the newest `n` *daily* backups; remove older ones. Daily filenames sort
// chronologically by name, so a lexical sort is enough. Other types are untouched.
export function pruneDailyBackups(n = retentionDays()) {
  const daily = readdirSync(BACKUP_DIR)
    .filter(f => /^jobs-daily-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort();                       // oldest → newest
  const remove = daily.slice(0, Math.max(0, daily.length - n));
  for (const f of remove) {
    const p = path.join(BACKUP_DIR, f);
    try {
      chmodSync(p, 0o644);         // lift the read-only bit before deleting our own file
      unlinkSync(p);
      log(`Pruned old daily backup ${f}`);
    } catch (err) { log(`Could not prune ${f}: ${err.message}`); }
  }
}

// Finalize an already-streamed upload: validate it's a real, intact DB, then move
// it into the backup folder as an `upload` snapshot (read-only). Deletes the temp
// file on failure so a bad upload never lingers.
export function ingestUpload(tmpPath) {
  try {
    validateBackup(tmpPath);           // integrity + required tables (nice errors)
    normalizeDbFile(tmpPath);          // collapse any WAL → clean single file
  } catch (err) {
    rmDbFiles(tmpPath);
    throw err;
  }
  const { date, time } = localStamp();
  const name = `jobs-upload-${date}-${time}.db`;
  const finalPath = path.join(BACKUP_DIR, name);
  renameSync(tmpPath, finalPath);
  rmDbFiles(tmpPath);                   // remove any sidecars left by the temp name
  chmodSync(finalPath, 0o444);
  log(`Stored uploaded backup ${name}`);
  return meta(name);
}

// Once-per-day automatic backup. Idempotent: does nothing if today's daily backup
// already exists. An O_EXCL lock file prevents the GUI and scheduler processes from
// creating it twice at the same moment. Safe to call as often as you like.
export async function maybeRunDailyBackup() {
  if (!isDailyEnabled() || todaysDailyBackupExists()) return;

  // Acquire the lock; if another process holds a fresh one, let it do the work.
  let lockFd;
  try {
    lockFd = openSync(LOCK_PATH, 'wx');
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    try {
      if (Date.now() - statSync(LOCK_PATH).mtimeMs > LOCK_STALE_MS) {
        rmSync(LOCK_PATH, { force: true });   // abandoned by a crashed process
        lockFd = openSync(LOCK_PATH, 'wx');
      } else {
        return;                                // someone else is on it
      }
    } catch { return; }
  }

  try {
    if (todaysDailyBackupExists()) return;     // re-check under the lock
    await createBackup('daily');
    pruneDailyBackups();
  } catch (err) {
    log(`Daily backup failed: ${err.message}`);
  } finally {
    try { closeSync(lockFd); } catch { /* ignore */ }
    try { unlinkSync(LOCK_PATH); } catch { /* ignore */ }
  }
}
