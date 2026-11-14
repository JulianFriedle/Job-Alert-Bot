import '../src/env.js';
import { getJobsWithEmptyDescription, updateJobDescription, markAnalyzed, getClients } from '../src/database.js';
import { fetchDescriptions, minDescriptionChars, isThinDescription } from '../src/scraper.js';
import { analyzeJob } from '../src/analyzer.js';
import { getClientConfig } from '../src/client-config.js';

function log(msg) {
  console.log(`[${new Date().toISOString()}] [refetch] ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Same floor as the pipeline: below it a description is a cookie banner or an
// error page, not the posting (MIN_DESCRIPTION_CHARS, 0 = only empty ones).
const minChars = minDescriptionChars();

let grandTotalRelevant = 0;
for (const client of getClients()) {
  const cid = client.id;
  const jobs = getJobsWithEmptyDescription(cid, minChars);
  if (jobs.length === 0) continue;
  log(`Klient "${client.name}": ${jobs.length} job(s) with an empty or too short description (< ${Math.max(1, minChars)} chars) found`);

  // Re-fetch descriptions (mutates job.description in-place)
  const before = new Map(jobs.map(j => [j.id, String(j.description ?? '')]));
  log('Fetching descriptions...');
  await fetchDescriptions(jobs);

  // Update DB and collect jobs that now have a usable description
  const withContent = [];
  for (const job of jobs) {
    const old = before.get(job.id);
    if (job.description && job.description.length > old.length && !isThinDescription(job.description, Math.max(1, minChars))) {
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
