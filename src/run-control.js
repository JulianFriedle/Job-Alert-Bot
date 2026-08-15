// ── Cooperative abort for a pipeline run ────────────────────────────────────
// The GUI starts a run as a child process (`node index.js --once`) and stops it
// by sending SIGTERM. A hard kill would orphan Playwright's chromium children
// and cut the DB mid-write, so the signal instead flips the flag below and every
// long loop in the pipeline checks it at its next iteration boundary. That lets
// the existing try/finally blocks close their browsers and checkpoint the WAL on
// the way out — the run stops within a few seconds, cleanly.
//
// Jobs already scraped, analyzed and saved before the abort stay in the DB; only
// the remaining work is skipped.

let aborted = false;
const listeners = new Set();

export function isAborted() {
  return aborted;
}

// Idempotent — a second SIGTERM must not re-notify the listeners.
export function requestAbort() {
  if (aborted) return false;
  aborted = true;
  for (const fn of listeners) {
    try { fn(); } catch { /* a failing listener must not block the others */ }
  }
  return true;
}

// Register a callback fired once when an abort is requested. Returns an
// unsubscribe function.
export function onAbort(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Test-only: drop the flag and listeners between cases.
export function resetAbort() {
  aborted = false;
  listeners.clear();
}
