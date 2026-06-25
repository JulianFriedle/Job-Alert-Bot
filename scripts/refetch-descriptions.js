import 'dotenv/config';
import { getJobsWithEmptyDescription, updateJobDescription, markAnalyzed, getClients } from '../src/database.js';
import { fetchDescriptions } from '../src/scraper.js';
import { analyzeJob } from '../src/analyzer.js';
import { getClientConfig } from '../src/client-config.js';

function log(msg) {
  console.log(`[${new Date().toISOString()}] [refetch] ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

let grandTotalRelevant = 0;
for (const client of getClients()) {
  const cid = client.id;
  const jobs = getJobsWithEmptyDescription(cid);
  if (jobs.length === 0) continue;
  log(`Klient "${client.name}": ${jobs.length} job(s) with empty description found`);

  // Re-fetch descriptions (mutates job.description in-place)
  log('Fetching descriptions...');
  await fetchDescriptions(jobs);

  // Update DB and collect jobs that now have content
  const withContent = [];
  for (const job of jobs) {
    if (job.description && job.description.length > 0) {
      updateJobDescription(cid, job.id, job.description);
      withContent.push(job);
    }
  }
  log(`${withContent.length}/${jobs.length} description(s) successfully fetched`);
  if (withContent.length === 0) continue;

  // Re-analyze
  const cfg = getClientConfig(client);
  log(`Re-analyzing ${withContent.length} job(s)...`);
  for (let i = 0; i < withContent.length; i++) {
    const job = withContent[i];
    try {
      const analysis = await analyzeJob(job, cfg);
      if (!analysis) { log(`  [${i + 1}/${withContent.length}] No result for "${job.title}"`); continue; }
      markAnalyzed(cid, job.id, analysis.relevant, analysis.score ?? null, analysis.summary ?? null);
      const tag = analysis.relevant ? `RELEVANT (${analysis.score}/10)` : `skip (${analysis.score}/10)`;
      log(`  [${i + 1}/${withContent.length}] ${tag}: ${job.source} – ${job.title}`);
      if (analysis.relevant) grandTotalRelevant++;
    } catch (err) {
      log(`  [${i + 1}/${withContent.length}] ERROR: ${err.message}`);
    }
    await sleep(500);
  }
}

log(`Done — ${grandTotalRelevant} newly relevant job(s) across all clients`);
log('Relevant jobs will be notified on the next regular run (npm run run-once)');
