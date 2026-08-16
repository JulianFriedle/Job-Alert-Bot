import 'dotenv/config';
import { runAll, startScheduler } from './src/scheduler.js';
import { installAbortSignals, isAborted } from './src/run-control.js';

const isOnce = process.argv.includes('--once');
// Optional: restrict a one-off run to a single client (`--client <id>`).
const clientFlagIdx = process.argv.indexOf('--client');
const onlyClientId = clientFlagIdx !== -1 ? process.argv[clientFlagIdx + 1] : undefined;
// A missing or flag-shaped value would silently run ALL clients (or swallow
// the next flag as an id) — fail loudly instead.
if (clientFlagIdx !== -1 && (!onlyClientId || onlyClientId.startsWith('--'))) {
  console.error(`[${new Date().toISOString()}] [main] --client braucht eine Klienten-ID, z. B.: node index.js --once --client default`);
  process.exit(1);
}

// SIGTERM is how the GUI's "Lauf stoppen" button and Docker/systemd shutdown
// reach us. Ask the pipeline to wind down at its next loop boundary so browsers
// close, the work done so far is saved and the DB gets checkpointed.
//
// Installed for BOTH modes. Outside a run the handler exits immediately, so the
// idle scheduler still quits on Ctrl+C the way it always did — but a `docker
// stop` that lands mid-run no longer throws that run's work away.
installAbortSignals();

if (isOnce) {
  console.log(`[${new Date().toISOString()}] [main] Running once and exiting...`);
  runAll({ onlyClientId })
    .then(() => {
      const stopped = isAborted();
      console.log(`[${new Date().toISOString()}] [main] ${stopped ? 'Abgebrochen.' : 'Done.'}`);
      // 130 = terminated by signal, so the GUI and shell agree the run did not
      // finish its work even though the shutdown itself was orderly.
      process.exit(stopped ? 130 : 0);
    })
    .catch(err => {
      console.error(`[${new Date().toISOString()}] [main] Fatal error: ${err.message}`);
      process.exit(1);
    });
} else {
  console.log(`[${new Date().toISOString()}] [main] Starting job alert system...`);
  startScheduler();
}
