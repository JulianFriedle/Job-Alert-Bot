import 'dotenv/config';
import { runAll, startScheduler } from './src/scheduler.js';
import { requestAbort, isAborted } from './src/run-control.js';

const isOnce = process.argv.includes('--once');
// Optional: restrict a one-off run to a single client (`--client <id>`).
const clientFlagIdx = process.argv.indexOf('--client');
const onlyClientId = clientFlagIdx !== -1 ? process.argv[clientFlagIdx + 1] : undefined;

if (isOnce) {
  // SIGTERM is how the GUI's "Lauf stoppen" button (and Docker/systemd shutdown)
  // reaches us. Ask the pipeline to wind down at its next loop boundary so
  // browsers close and the DB gets checkpointed; a second signal gives up waiting.
  // Only for one-off runs: registering these on the long-lived scheduler would
  // replace Node's default signal handling and stop Ctrl+C from quitting it.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      if (requestAbort()) {
        console.log(`[${new Date().toISOString()}] [main] ${signal} — Lauf wird abgebrochen, laufende Schritte werden sauber beendet…`);
      } else {
        console.log(`[${new Date().toISOString()}] [main] ${signal} erneut — sofortiger Abbruch.`);
        process.exit(130);
      }
    });
  }

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
