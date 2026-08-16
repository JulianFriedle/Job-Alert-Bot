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
//
// The same path covers a shutdown of the long-lived scheduler (`docker stop`,
// systemd restart, Ctrl+C): a run in flight gets to save its work before the
// process goes down, instead of being cut off mid-pipeline.

let aborted = false;
const listeners = new Set();

// A run is "active" only between beginRun() and endRun(). Outside that window a
// termination signal has nothing to save, so it may end the process right away —
// which is what keeps Ctrl+C working on the idle scheduler.
let runActive = false;
let exitAfterRun = false;
let signalsInstalled = false;

function log(msg) {
  console.log(`[${new Date().toISOString()}] [run-control] ${msg}`);
}

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

// Bracket around one pipeline run. Starting a run clears the flag, so on the
// long-lived scheduler an aborted run can't poison the next cron tick.
export function beginRun() {
  aborted = false;
  runActive = true;
}

export function endRun() {
  runActive = false;
}

export function isRunActive() {
  return runActive;
}

// True when the abort came from a termination signal: the process is expected to
// shut down once the run has wound down. The scheduler needs this — it would
// otherwise happily carry on to the next cron tick after a `docker stop`.
export function exitRequested() {
  return exitAfterRun;
}

// Translate SIGTERM/SIGINT into a cooperative abort. Safe to install in both
// modes — one-off runs and the long-lived scheduler alike:
//   • no run in flight  → exit immediately, exactly as Node would have
//   • run in flight     → abort, let it save, the caller exits afterwards
//   • signal again      → the operator is done waiting; exit now
export function installAbortSignals() {
  if (signalsInstalled) return;
  signalsInstalled = true;
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      if (!runActive) process.exit(signal === 'SIGINT' ? 130 : 143);
      if (aborted) {
        log(`${signal} erneut — sofortiger Abbruch.`);
        process.exit(130);
      }
      exitAfterRun = true;
      log(`${signal} — Lauf wird abgebrochen, laufende Schritte werden sauber beendet…`);
      requestAbort();
    });
  }
}

// Test-only: drop the flag, listeners and run state between cases.
export function resetAbort() {
  aborted = false;
  runActive = false;
  exitAfterRun = false;
  listeners.clear();
}
