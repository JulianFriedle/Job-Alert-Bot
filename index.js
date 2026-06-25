import 'dotenv/config';
import { runAll, startScheduler } from './src/scheduler.js';

const isOnce = process.argv.includes('--once');
// Optional: restrict a one-off run to a single client (`--client <id>`).
const clientFlagIdx = process.argv.indexOf('--client');
const onlyClientId = clientFlagIdx !== -1 ? process.argv[clientFlagIdx + 1] : undefined;

if (isOnce) {
  console.log(`[${new Date().toISOString()}] [main] Running once and exiting...`);
  runAll({ onlyClientId })
    .then(() => {
      console.log(`[${new Date().toISOString()}] [main] Done.`);
      process.exit(0);
    })
    .catch(err => {
      console.error(`[${new Date().toISOString()}] [main] Fatal error: ${err.message}`);
      process.exit(1);
    });
} else {
  console.log(`[${new Date().toISOString()}] [main] Starting job alert system...`);
  startScheduler();
}
