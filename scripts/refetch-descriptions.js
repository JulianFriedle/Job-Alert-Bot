import 'dotenv/config';
import { getJobsWithEmptyDescription, updateJobDescription, markAnalyzed } from '../src/database.js';
import { fetchDescriptions } from '../src/scraper.js';
import { analyzeJob } from '../src/analyzer.js';

function log(msg) {
  console.log(`[${new Date().toISOString()}] [refetch] ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const jobs = getJobsWithEmptyDescription();
log(`${jobs.length} job(s) with empty description found`);

if (jobs.length === 0) {
  log('Nothing to do.');
  process.exit(0);
}

// Re-fetch descriptions (mutates job.description in-place)
log('Fetching descriptions...');
await fetchDescriptions(jobs);

// Update DB and collect jobs that now have content
const withContent = [];
for (const job of jobs) {
  if (job.description && job.description.length > 0) {
    updateJobDescription(job.id, job.description);
    withContent.push(job);
  }
}
log(`${withContent.length}/${jobs.length} description(s) successfully fetched`);

if (withContent.length === 0) {
  log('No new content — stopping.');
  process.exit(0);
}

// Re-analyze
log(`Re-analyzing ${withContent.length} job(s)...`);
let relevant = 0;
for (let i = 0; i < withContent.length; i++) {
  const job = withContent[i];
  try {
    const analysis = await analyzeJob(job);
    if (!analysis) { log(`  [${i + 1}/${withContent.length}] No result for "${job.title}"`); continue; }
    markAnalyzed(job.id, analysis.relevant, analysis.score ?? null, analysis.summary ?? null);
    const tag = analysis.relevant ? `RELEVANT (${analysis.score}/10)` : `skip (${analysis.score}/10)`;
    log(`  [${i + 1}/${withContent.length}] ${tag}: ${job.source} – ${job.title}`);
    if (analysis.relevant) relevant++;
  } catch (err) {
    log(`  [${i + 1}/${withContent.length}] ERROR: ${err.message}`);
  }
  await sleep(500);
}

log(`Done — ${relevant} newly relevant job(s) out of ${withContent.length} re-analyzed`);
log('Relevant jobs will be notified on the next regular run (npm run run-once)');
