// ── Conflict detection for saved configuration (#32) ─────────────────────────
// A GUI window that stays open keeps showing what it loaded. Saving there used
// to overwrite whatever was saved in the meantime from another window or
// client — seen in practice: a stale desktop window with 3 sources would have
// wiped 80 sources saved from a browser tab.
//
// The version of a stored object is a short hash of what GET returns, so no
// schema change is needed and any writer (another window, the wizard, the
// API) changes it. GET hands it out, PUT sends it back as `baseVersion`; a
// mismatch is a conflict. A PUT without `baseVersion` (older callers, scripts)
// is accepted as before. Pure, unit-tested in test/config-version.test.js.
import crypto from 'crypto';

export function versionOf(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 16);
}

// True when the caller based its edit on an older version than `current`.
export function isStale(baseVersion, current) {
  if (baseVersion == null || baseVersion === '') return false;
  return String(baseVersion) !== String(current);
}

export const CONFLICT_ERROR =
  'Die Daten wurden inzwischen an anderer Stelle geändert (anderes Fenster, Assistent oder Klient). ' +
  'Bitte neu laden, sonst würden die neueren Daten überschrieben.';
