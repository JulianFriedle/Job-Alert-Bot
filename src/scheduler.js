import 'dotenv/config';
import cron from 'node-cron';
import { readFile } from 'fs/promises';
import { readFileSync, createWriteStream, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { scrapeAll, fetchDescriptions } from './scraper.js';
import { isNewJob, saveJob, markAnalyzed, markNotified, getUnanalyzedJobs, getRelevantUnnotifiedJobs, getRelevantCountBySource, updateLastSeenBatch, getJobsToExpire, markExpired, saveRunSnapshot } from './database.js';
import { analyzeJob } from './analyzer.js';
import { notifyBatch, notifyExpired, isTelegramEnabled } from './notifier.js';
import { exportToExcel } from './exporter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JOBS_CONFIG = path.join(__dirname, '..', 'config', 'jobs.json');
const FILTERS_CONFIG = path.join(__dirname, '..', 'config', 'filters.json');

// Tunable knobs (env override; defaults preserve original behavior)
const CRON_SCHEDULE          = process.env.CRON_SCHEDULE || '0 * * * *';
const EXPIRY_THRESHOLD_HOURS = Number(process.env.EXPIRY_THRESHOLD_HOURS) || 72;
const ANALYSIS_CONCURRENCY   = Number(process.env.ANALYSIS_CONCURRENCY) || 2;

// German-tuned defaults; overridden by config/filters.json when present.
const DEFAULT_TITLE_BLOCKLIST = [
  'praktikum', 'ausbildung', 'berufsausbildung', 'schulpraktikum', 'logistik', 'buchhaltung', ' sap ', 'accounting', 'werkschutz', 'küche',
  'duales studium', 'dualer student', 'kooperatives studium', 'sales', ' hr ', 'elektroniker', 'koch', 'facility', 'praktikant', ' erp ', 'schulpraktikant',
  'vertrieb', 'thesis', 'internship', 'abschlussarbeit', 'ferienhelfer', 'apprentice', 'werkstudent', 'ferienaushilfe', 'ausbilder', 'umkreissuche', 'auszubildender',
];
const DEFAULT_PRIORITY_KEYWORDS = ['initiativbewerbung', 'initiativ', 'phd', 'doktorand', 'promotion', 'wissenschaftlicher mitarbeiter', 'wissenschaftliche mitarbeiterin'];

let TITLE_BLOCKLIST = DEFAULT_TITLE_BLOCKLIST;
let PRIORITY_KEYWORDS = DEFAULT_PRIORITY_KEYWORDS;
try {
  const f = JSON.parse(readFileSync(FILTERS_CONFIG, 'utf-8'));
  if (Array.isArray(f.titleBlocklist))  TITLE_BLOCKLIST  = f.titleBlocklist;
  if (Array.isArray(f.priorityKeywords)) PRIORITY_KEYWORDS = f.priorityKeywords;
} catch { /* fall back to built-in German defaults */ }

function log(msg) {
  console.log(`[${new Date().toISOString()}] [scheduler] ${msg}`);
}

function printOverview(sources, sourceStats, relevantBySource, expiredCount = 0) {
  const C1 = 28, C2 = 10, CW = 10, C3 = 9, C4 = 10, C5 = 11, C6 = 10, C7 = 10, C8 = 10;
  const WIDTH = C1 + C2 + CW + C3 + C4 + C5 + C6 + C7 + C8 + 2;
  const SEP  = '─'.repeat(WIDTH);
  const SEP2 = '─'.repeat(WIDTH - 2);

  console.log(`\n${SEP}`);
  console.log(`  LAUF-ÜBERSICHT  —  ${new Date().toLocaleString('de-DE')}`);
  console.log(SEP);
  console.log(
    `  ${'Unternehmen'.padEnd(C1)}` +
    `${'Gefunden'.padStart(C2)}` +
    `${'Laut Web'.padStart(CW)}` +
    `${'Neu(DB)'.padStart(C3)}` +
    `${'Geblockt'.padStart(C4)}` +
    `${'Analysiert'.padStart(C5)}` +
    `${'Neu Rel.'.padStart(C6)}` +
    `${'Ges. Rel.'.padStart(C7)}` +
    `${'Notified'.padStart(C8)}`
  );
  console.log(`  ${SEP2}`);

  let totFound = 0, totNewDB = 0, totBlocked = 0, totNew = 0, totRelevant = 0, totAllRelevant = 0, totNotified = 0;

  for (const source of sources) {
    const s = sourceStats[source.name] || { total: 0, siteTotal: null, newTotal: 0, blocked: 0, newCount: 0, relevant: 0, notified: 0 };
    const allRel = relevantBySource[source.name] || 0;
    totFound        += s.total;
    totNewDB        += s.newTotal || 0;
    totBlocked      += s.blocked || 0;
    totNew          += s.newCount;
    totRelevant     += s.relevant;
    totAllRelevant  += allRel;
    totNotified     += s.notified;
    const webStr = s.siteTotal != null ? String(s.siteTotal) : '–';
    console.log(
      `  ${source.name.padEnd(C1)}` +
      `${String(s.total).padStart(C2)}` +
      `${webStr.padStart(CW)}` +
      `${String(s.newTotal || 0).padStart(C3)}` +
      `${String(s.blocked || 0).padStart(C4)}` +
      `${String(s.newCount).padStart(C5)}` +
      `${String(s.relevant).padStart(C6)}` +
      `${String(allRel).padStart(C7)}` +
      `${String(s.notified).padStart(C8)}`
    );
  }

  console.log(`  ${SEP2}`);
  console.log(
    `  ${'Gesamt'.padEnd(C1)}` +
    `${String(totFound).padStart(C2)}` +
    `${''.padStart(CW)}` +
    `${String(totNewDB).padStart(C3)}` +
    `${String(totBlocked).padStart(C4)}` +
    `${String(totNew).padStart(C5)}` +
    `${String(totRelevant).padStart(C6)}` +
    `${String(totAllRelevant).padStart(C7)}` +
    `${String(totNotified).padStart(C8)}`
  );
  console.log(SEP);
  if (expiredCount > 0) {
    console.log(`  ❌ ${expiredCount} Job(s) nicht mehr ausgeschrieben — Benachrichtigung versendet`);
    console.log(SEP);
  }
  console.log('');
}

export async function runOnce() {
  const startTime = Date.now();
  const logsDir = path.join(__dirname, '..', 'logs');
  mkdirSync(logsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/T/, '_').replace(/:/g, '-').slice(0, 19);
  const logFile = path.join(logsDir, `${ts}.log`);
  const logStream = createWriteStream(logFile);
  const _origLog = console.log;
  console.log = (...args) => {
    const line = args.map(a => (typeof a === 'string' ? a : String(a))).join(' ');
    _origLog(line);
    logStream.write(line + '\n');
  };

  const t = {};
  const tick = (label) => { t[label] = Date.now(); };
  const tock = (label) => `${((Date.now() - t[label]) / 1000).toFixed(1)}s`;

  try {
  log('Pipeline starting...');

  // 1. Load source URLs
  let sources;
  try {
    const config = JSON.parse(await readFile(JOBS_CONFIG, 'utf-8'));
    sources = config.sources;
    log(`Loaded ${sources.length} source(s) from config`);
  } catch (err) {
    log(`ERROR loading jobs.json: ${err.message}`);
    return;
  }

  // 2. Scrape all sources
  let scrapedJobs = [];
  let scrapeStats = {};
  tick('scrape');
  try {
    const result = await scrapeAll(sources);
    scrapedJobs = result.jobs;
    scrapeStats = result.stats;
  } catch (err) {
    log(`ERROR during scraping: ${err.message}`);
    return;
  }
  log(`⏱  Scraping: ${tock('scrape')}`);

  // 3. Mark every scraped job as seen (for expiry tracking), then filter to new
  updateLastSeenBatch(scrapedJobs.map(j => j.id));
  const newJobs = scrapedJobs.filter(job => isNewJob(job.id));
  log(`${scrapedJobs.length} scraped, ${newJobs.length} new`);

  // 4. Title blocklist — skip jobs that are structurally irrelevant before touching Claude or detail pages
  //    (loaded from config/filters.json at startup)
  const isTitleBlocked = (title) =>
    TITLE_BLOCKLIST.some(kw => title.toLowerCase().includes(kw));

  const blockedJobs = newJobs.filter(job => isTitleBlocked(job.title));
  const jobsToProcess = newJobs.filter(job => !isTitleBlocked(job.title));

  if (blockedJobs.length > 0) {
    log(`Title-filtered ${blockedJobs.length} job(s) (saving as irrelevant to skip on future runs):`);
    for (const job of blockedJobs) {
      log(`  ✗ ${job.title}`);
      try {
        saveJob(job);
        markAnalyzed(job.id, false);
      } catch (err) { log(`ERROR saving blocked job "${job.title}": ${err.message}`); }
    }
  }

  const newJobIds = new Set(jobsToProcess.map(j => j.id));

  // 5. Fetch full descriptions only for jobs that passed the title filter
  tick('descriptions');
  if (jobsToProcess.length > 0) {
    try {
      await fetchDescriptions(jobsToProcess);
    } catch (err) {
      log(`ERROR fetching descriptions: ${err.message}`);
    }
  }
  log(`⏱  Descriptions (${jobsToProcess.length} jobs): ${tock('descriptions')}`);

  // 6. Save passing jobs to DB (now with descriptions)
  for (const job of jobsToProcess) {
    try { saveJob(job); } catch (err) { log(`ERROR saving "${job.title}": ${err.message}`); }
  }

  // 7. Build per-source counters
  const sourceStats = Object.fromEntries(sources.map(s => [s.name, { total: 0, siteTotal: scrapeStats[s.name]?.siteTotal ?? null, newTotal: 0, blocked: 0, newCount: 0, relevant: 0, notified: 0 }]));
  for (const job of scrapedJobs) {
    if (sourceStats[job.source]) sourceStats[job.source].total++;
  }
  for (const job of newJobs) {
    if (sourceStats[job.source]) sourceStats[job.source].newTotal++;
  }
  for (const job of blockedJobs) {
    if (sourceStats[job.source]) sourceStats[job.source].blocked++;
  }
  for (const job of jobsToProcess) {
    if (sourceStats[job.source]) sourceStats[job.source].newCount++;
  }

  // 7. Analyze unanalyzed jobs — collect results for new jobs found this run
  const allUnanalyzed = getUnanalyzedJobs();

  // Apply title blocklist retroactively to jobs saved before the blocklist was updated
  const retroBlocked = allUnanalyzed.filter(job => isTitleBlocked(job.title));
  if (retroBlocked.length > 0) {
    log(`Retroactively blocking ${retroBlocked.length} already-saved job(s) matching title filter`);
    for (const job of retroBlocked) {
      markAnalyzed(job.id, false);
    }
  }
  const toAnalyze = allUnanalyzed.filter(job => !isTitleBlocked(job.title));
  log(`Analyzing ${toAnalyze.length} unanalyzed job(s)...`);

  const isPriority = (title) => PRIORITY_KEYWORDS.some(kw => title.toLowerCase().includes(kw));

  const analysisCache = new Map(); // id → analysis (reused for notifications)
  let analysisIdx = 0;

  tick('analysis');
  async function analysisWorker() {
    while (analysisIdx < toAnalyze.length) {
      const i = analysisIdx++;
      const job = toAnalyze[i];
      const progress = `[${i + 1}/${toAnalyze.length}]`;
      try {
        const analysis = await analyzeJob(job);
        if (!analysis) { log(`  ${progress} No result for "${job.title}"`); continue; }

        if (isPriority(job.title)) {
          if (analysis.score < 7) analysis.score = 7;
          analysis.relevant = analysis.relevant || analysis.score >= 4;
        }

        markAnalyzed(job.id, analysis.relevant, analysis.score ?? null, analysis.summary ?? null);
        analysisCache.set(job.id, analysis);

        if (newJobIds.has(job.id) && analysis.relevant && sourceStats[job.source]) {
          sourceStats[job.source].relevant++;
        }

        const tag = analysis.relevant ? `RELEVANT (${analysis.score}/10)` : `skip (${analysis.score}/10)`;
        log(`  ${progress} ${tag}: ${job.source} – ${job.title}`);
      } catch (err) {
        log(`ERROR analyzing "${job.title}": ${err.message}`);
      }
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(ANALYSIS_CONCURRENCY, toAnalyze.length) },
    analysisWorker
  ));
  log(`⏱  Analysis (${toAnalyze.length} jobs): ${tock('analysis')}`);

  // 8. Send notifications — use cached analysis, only re-call Claude if truly missing.
  //    Telegram is optional: when disabled, skip sending (and skip marking jobs as
  //    "notified", since they weren't) — relevant jobs remain visible in the GUI.
  tick('notifications');
  const toNotify = getRelevantUnnotifiedJobs();

  let notifiedCount = 0;
  if (!isTelegramEnabled()) {
    if (toNotify.length > 0)
      log(`Telegram nicht aktiv — ${toNotify.length} relevante(r) Job(s) nur in der GUI sichtbar (npm run gui).`);
  } else {
    log(`Sending notifications for ${toNotify.length} job(s)...`);
    if (toNotify.length > 0) {
      const pairs = [];
      for (const job of toNotify) {
        const analysis = analysisCache.get(job.id) ?? await analyzeJob(job).catch(() => null);
        if (analysis) pairs.push({ job, analysis });
      }

      notifiedCount = await notifyBatch(pairs);

      for (const { job } of pairs) {
        try {
          markNotified(job.id);
          if (sourceStats[job.source]) sourceStats[job.source].notified++;
        } catch (err) { log(`ERROR marking notified "${job.title}": ${err.message}`); }
      }
    }
  }
  log(`⏱  Notifications (${toNotify.length} jobs): ${tock('notifications')}`);

  // 9. Detect and notify expired jobs (notified but not seen for 3+ days).
  //    Only relevant when Telegram is active (expiry alerts go out via Telegram).
  const expiredJobs = isTelegramEnabled() ? getJobsToExpire(EXPIRY_THRESHOLD_HOURS) : [];
  let expiredCount = 0;
  if (expiredJobs.length > 0) {
    log(`${expiredJobs.length} job(s) no longer listed — sending expiry notifications...`);
    for (const job of expiredJobs) {
      try {
        await notifyExpired(job);
        markExpired(job.id);
        expiredCount++;
      } catch (err) {
        log(`ERROR sending expiry notification for "${job.title}": ${err.message}`);
      }
    }
  }

  // 10. Print overview + persist a snapshot for the GUI stats page
  const relevantBySource = getRelevantCountBySource();
  printOverview(sources, sourceStats, relevantBySource, expiredCount);

  try {
    const snapshotRows = sources.map(source => {
      const s = sourceStats[source.name] || {};
      return {
        source:        source.name,
        found:         s.total || 0,
        siteTotal:     s.siteTotal ?? null,
        newDb:         s.newTotal || 0,
        blocked:       s.blocked || 0,
        analyzed:      s.newCount || 0,
        newRelevant:   s.relevant || 0,
        totalRelevant: relevantBySource[source.name] || 0,
        notified:      s.notified || 0,
      };
    });
    saveRunSnapshot(snapshotRows);
  } catch (err) {
    log(`ERROR saving run snapshot: ${err.message}`);
  }

  // 11. Export all relevant jobs to Excel
  tick('export');
  await exportToExcel();
  log(`⏱  Export: ${tock('export')}`);

  } finally {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`Run finished in ${elapsed}s — log: ${logFile}`);
    console.log = _origLog;
    await new Promise(resolve => logStream.end(resolve));
  }
}

export function startScheduler() {
  log(`Scheduler starting — schedule: ${CRON_SCHEDULE}`);
  runOnce().catch(err => log(`Unhandled error in initial run: ${err.message}`));
  cron.schedule(CRON_SCHEDULE, () => {
    log('Cron triggered');
    runOnce().catch(err => log(`Unhandled error in scheduled run: ${err.message}`));
  });
}
