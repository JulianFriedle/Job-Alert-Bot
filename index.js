import 'dotenv/config';
import { runOnce, startScheduler } from './src/scheduler.js';

const isOnce = process.argv.includes('--once');

if (isOnce) {
  console.log(`[${new Date().toISOString()}] [main] Running once and exiting...`);
  runOnce()
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
