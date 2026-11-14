import './env.js';
import cron from 'node-cron';
import { createWriteStream, mkdirSync } from 'fs';
import path from 'path';

import { scrapeAll, fetchDescriptions, minDescriptionChars, isThinDescription, DESC_MISSING_SUMMARY, uniqueJobsById } from './scraper.js';
import {
  isNewJob, saveJob, markAnalyzed, markNotified, getUnanalyzedJobs,
  getRelevantUnnotifiedJobs, getRelevantCountBySource, updateLastSeenBatch,
  getJobsToExpire, markExpired, saveRunSnapshot, getEnabledClients, getClient,
  checkpointWal, getJobById, createApplication, recordDescriptionAttempt,
  getJobsWithSummary, reopenForAnalysis,
} from './database.js';
import { analyzeJob } from './analyzer.js';
import { notifyBatch, notifyExpired, isTelegramEnabled } from './notifier.js';
import { exportToExcel } from './exporter.js';
import { getClientConfig } from './client-config.js';
import { maybeRunDailyBackup } from './backup.js';
import { startApplyWorker } from './apply-worker.js';
import { startTelegramBot } from './telegram-bot.js';
import { isTruthy } from './scrapers/browser.js';
import { isAborted, beginRun, endRun, exitRequested } from './run-control.js';
import { LOGS_DIR } from './paths.js';
import { classifySourceProblem } from './source-report.js';


// Tunable knobs (env override; defaults preserve original behavior)
const CRON_SCHEDULE          = process.env.CRON_SCHEDULE || '0 * * * *';
const EXPIRY_THRESHOLD_HOURS = Number(process.env.EXPIRY_THRESHOLD_HOURS) || 72;
// Telegram pings for jobs that are no longer listed. Default on; can be switched
// off per client. (Global env kept as an operator-wide kill switch.)
const EXPIRY_NOTIFICATIONS_GLOBAL = String(process.env.EXPIRY_NOTIFICATIONS || 'on').trim().toLowerCase() !== 'off';
const ANALYSIS_CONCURRENCY   = Number(process.env.ANALYSIS_CONCURRENCY) || 2;

function log(msg) {
  console.log(`[${new Date().toISOString()}] [scheduler] ${msg}`);
}

function printOverview(clientName, sources, sourceStats, relevantBySource, expiredCount = 0, thin = null) {
  const C1 = 28, C2 = 10, CW = 10, C3 = 9, C4 = 10, C5 = 11, C6 = 10, C7 = 10, C8 = 10;
  const WIDTH = C1 + C2 + CW + C3 + C4 + C5 + C6 + C7 + C8 + 2;
  const SEP  = '─'.repeat(WIDTH);
  const SEP2 = '─'.repeat(WIDTH - 2);

  console.log(`\n${SEP}`);
  console.log(`  LAUF-ÜBERSICHT  —  ${clientName}  —  ${new Date().toLocaleString('de-DE')}`);
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
  if (thin?.total > 0) {
    console.log(`  📄 ${thin.total} Stelle(n) mit zu kurzer Beschreibung nicht analysiert` +
      (thin.gaveUp > 0 ? ` (${thin.gaveUp} davon endgültig, „Beschreibung fehlt“)` : ' — neuer Abruf im nächsten Lauf'));
    console.log(SEP);
  }
  console.log('');
}

// ── Too-short descriptions (#40) ─────────────────────────────────────────────
// A cookie banner or JS shell instead of the posting leaves a few dozen
// characters; scored from the title alone the result is unreliable and the call
// wasted. Such jobs stay unanalyzed and their detail page is fetched again on
// later runs — at most MAX_DESC_ATTEMPTS times — before they are given up and
// stored as not relevant with DESC_MISSING_SUMMARY.
export const MAX_DESC_ATTEMPTS = 2;
export { DESC_MISSING_SUMMARY };

// Returns the jobs that are ready for analysis plus counters for the overview.
// `freshIds` are jobs whose detail page was fetched earlier in this very run:
// fetching them again seconds later rarely helps, so they wait for the next run.
// `fetch` and `minChars` are injectable for tests.
export async function settleThinDescriptions(clientId, jobs, freshIds,
  { fetch = fetchDescriptions, minChars = minDescriptionChars() } = {}) {
  const none = { ready: jobs, held: [], total: 0, recovered: 0, gaveUp: 0 };
  if (minChars <= 0) return none;
  const thin = jobs.filter(j => isThinDescription(j.description, minChars));
  if (thin.length === 0) return none;
  const textLen = (d) => String(d ?? '').trim().length;

  let recovered = 0;
  const retry = thin.filter(j => !freshIds.has(j.id) && (j.desc_attempts ?? 0) < MAX_DESC_ATTEMPTS);
  if (retry.length > 0 && !isAborted()) {
    log(`${retry.length} Stelle(n) mit zu kurzer Beschreibung — Detailseite wird erneut abgerufen…`);
    const before = new Map(retry.map(j => [j.id, String(j.description ?? '')]));
    const visited = new Set();
    const countAttempt = (job) => {
      try { recordDescriptionAttempt(clientId, job.id, job.description); }
      catch (err) { log(`ERROR saving description of "${job.title}": ${err.message}`); return; }
      job.desc_attempts = (job.desc_attempts ?? 0) + 1;
    };
    const onJob = (job) => {
      visited.add(job.id);
      const old = before.get(job.id) ?? '';
      // Never trade a stored text for a shorter one from a worse fetch.
      if (textLen(job.description) < textLen(old)) job.description = old;
      const improved = textLen(job.description) > textLen(old);
      // Cut off by a stop: that visit says nothing about the page.
      if (!improved && isAborted()) return;
      countAttempt(job);
      if (!isThinDescription(job.description, minChars)) recovered++;
    };
    try { await fetch(retry, { onJob }); }
    catch (err) { log(`ERROR re-fetching descriptions: ${err.message}`); }
    // A fetch that failed before reaching a job (browser didn't start, …) still
    // counts, or such a job would wait forever instead of being given up.
    if (!isAborted()) for (const job of retry) if (!visited.has(job.id)) countAttempt(job);
  }

  let gaveUp = 0;
  for (const job of thin) {
    if (!isThinDescription(job.description, minChars)) continue;
    if ((job.desc_attempts ?? 0) >= MAX_DESC_ATTEMPTS) {
      try { markAnalyzed(clientId, job.id, false, null, DESC_MISSING_SUMMARY); gaveUp++; }
      catch (err) { log(`ERROR marking "${job.title}": ${err.message}`); }
    }
  }

  const ready = jobs.filter(j => !isThinDescription(j.description, minChars));
  const held = jobs.filter(j => isThinDescription(j.description, minChars));
  // Per source, so a site whose postings are legitimately short (or that serves
  // only a cookie wall) stands out instead of hiding in one total.
  const bySource = {};
  for (const j of held) bySource[j.source] = (bySource[j.source] || 0) + 1;
  const sourceList = Object.entries(bySource).sort((a, b) => b[1] - a[1])
    .map(([src, n]) => `${src} ${n}`).join(', ');
  log(`Beschreibung zu kurz (< ${minChars} Zeichen): ${held.length} Stelle(n) nicht analysiert (${sourceList})` +
      `${recovered > 0 ? `, ${recovered} nach erneutem Abruf vollständig` : ''}` +
      `${gaveUp > 0 ? `, ${gaveUp} endgültig als „Beschreibung fehlt“ abgelegt` : ''}.`);
  return { ready, held, total: held.length, recovered, gaveUp };
}

// German postings routinely wedge a gender marker into the middle of the title
// ("Entwickler (m/w/d) für Embedded Systeme", "Ingenieur*in Fertigungstechnik"),
// which breaks the plain substring match the filters use — the first would miss a
// keyword like "entwickler für embedded" entirely. Drop the marker before matching
// so a keyword list stays a list of role names, not a list of spelling variants.
const foldTitle = (s) => String(s || '')
  .toLowerCase()
  .replace(/\(\s*[mwdfx*:/\s-]+\)/g, ' ')  // (m/w/d), (w/m/d), (m/w/x), (d/w/m) …
  .replace(/[*:]in\b/g, 'in')              // Referent*in / Referent:in → Referentin
  .replace(/\s+/g, ' ');

export function normalizeTitle(title) {
  return foldTitle(title).trim();
}

// Keywords go through the same folding as the title — lowercase, gender forms,
// whitespace — or "Praktikum" or "referent:in" could never match. Not trimmed:
// a padded keyword like " sap " (config/filters.json) matches a whole word.
const keywordList = (list) => (Array.isArray(list) ? list : [])
  .map(k => {
    const raw = String(k ?? '');
    let folded = foldTitle(raw);
    // Keep padding the user typed, drop padding the folding created
    // ("Ingenieur (m/w/d)" → "ingenieur", not "ingenieur ").
    if (!/^\s/.test(raw)) folded = folded.replace(/^\s+/, '');
    if (!/\s$/.test(raw)) folded = folded.replace(/\s+$/, '');
    return folded;
  })
  .filter(k => k.trim() !== '');

// Summary of a job dropped only because it matched no allowlist term. Unlike a
// blocklist drop this is undone: once the allowlist lets the title through
// (typo fixed, term added), the job goes back to the analysis queue.
export const NOT_ALLOWED_SUMMARY = 'Titel nicht in der Positivliste – nicht bewertet';
// At most this many such jobs go back per run: one broad new term could
// otherwise release thousands of detail-page fetches and Claude calls at once.
export const MAX_REOPEN_PER_RUN = 100;

// ── Location pre-filter (#36) ────────────────────────────────────────────────
// Large career pages list openings worldwide. With a location list set, a
// career-page job whose location contains none of its terms never reaches
// Claude. Deliberately lenient: a job without a location, a remote job, and
// every job-board result (those searches carry their own location + radius,
// so "Stuttgart" would wrongly drop "Esslingen") always pass.
export const WRONG_LOCATION_SUMMARY = 'Ort nicht in der Ortsliste – nicht bewertet';
const ALWAYS_OK_LOCATIONS = ['remote', 'homeoffice', 'home office', 'home-office', 'mobiles arbeiten',
  'deutschlandweit', 'bundesweit'];
const foldPlace = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

export function createLocationFilter(list) {
  const terms = (Array.isArray(list) ? list : []).map(foldPlace).filter(Boolean);
  const reject = (job) => {
    if (terms.length === 0 || job?.platform) return null;
    const loc = foldPlace(job?.location);
    if (!loc || ALWAYS_OK_LOCATIONS.some(t => loc.includes(t))) return null;
    return terms.some(t => loc.includes(t)) ? null : 'wrong-location';
  };
  return { reject, hasList: terms.length > 0 };
}

// The title pre-filters of one client. `reject(title)` says why a job never
// reaches Claude: 'blocked' (blocklist hit) or 'not-allowed' (an allowlist is
// set and the title matches none of it) — null means it goes on. An empty
// allowlist restricts nothing; a priority keyword counts as allowed; the
// blocklist always wins.
export function createTitleFilter({ titleBlocklist, priorityKeywords, titleAllowlist } = {}) {
  const block = keywordList(titleBlocklist);
  const prio = keywordList(priorityKeywords);
  const allow = keywordList(titleAllowlist);
  const hits = (title, list) => {
    const t = normalizeTitle(title);
    return list.some(kw => t.includes(kw));
  };
  const isBlocked = (title) => hits(title, block);
  const isPriority = (title) => hits(title, prio);
  const isAllowed = (title) => allow.length === 0 || hits(title, allow) || isPriority(title);
  const reject = (title) => (isBlocked(title) ? 'blocked' : isAllowed(title) ? null : 'not-allowed');
  return { isBlocked, isPriority, isAllowed, reject, hasAllowlist: allow.length > 0 };
}

// Run the full scrape→analyze→notify→export pipeline for ONE client.
async function runClientPipeline(client) {
  const clientId = client.id;
  const cfg = getClientConfig(client);
  const sources = cfg.sources;
  const titleFilter = createTitleFilter(cfg.filters);
  const locationFilter = createLocationFilter(cfg.filters.locationAllowlist);

  const t = {};
  const tick = (label) => { t[label] = Date.now(); };
  const tock = (label) => `${((Date.now() - t[label]) / 1000).toFixed(1)}s`;

  log(`▶ Klient "${client.name}" (${clientId}) — Pipeline startet…`);

  if (!sources.length) {
    log(`Keine Quellen für "${client.name}" konfiguriert — übersprungen.`);
    return;
  }
  log(`Loaded ${sources.length} source(s) for "${client.name}"`);

  // 1. Scrape all sources
  let scrapedJobs = [];
  let scrapeStats = {};
  let scrapeIncomplete = false;
  tick('scrape');
  try {
    const result = await scrapeAll(sources);
    scrapedJobs = result.jobs;
    scrapeStats = result.stats;
    scrapeIncomplete = Boolean(result.incomplete);
  } catch (err) {
    log(`ERROR during scraping for "${client.name}": ${err.message}`);
    return;
  }
  log(`⏱  Scraping: ${tock('scrape')}`);

  // 2. Mark every scraped job as seen (for expiry tracking), then filter to new
  updateLastSeenBatch(clientId, scrapedJobs.map(j => j.id));
  // A new posting found by two sources is processed once (one detail fetch, one
  // analysis, counted as new for one source). "Gefunden" per source still counts
  // every copy — each source did list it.
  const { unique: newJobs, dropped: newDupes } = uniqueJobsById(
    scrapedJobs.filter(job => isNewJob(clientId, job.id)), sources.map(s => s.name));
  if (newDupes.length > 0) log(`${newDupes.length} neue Stelle(n) über mehrere Quellen doppelt gefunden — jeweils nur einmal übernommen`);
  log(`${scrapedJobs.length} scraped, ${newJobs.length} new`);

  // 3. Pre-filters (title + location) — skip irrelevant jobs before touching Claude.
  // rejectJob says why: 'blocked' | 'not-allowed' | 'wrong-location' | null.
  const rejectJob = (job) => titleFilter.reject(job.title) ?? locationFilter.reject(job);
  const isFiltered = (job) => rejectJob(job) !== null;
  // Blocklist drops are final; allowlist and location drops carry a marker
  // summary so a loosened list can bring them back (see below).
  const FILTER_SUMMARY = { 'not-allowed': NOT_ALLOWED_SUMMARY, 'wrong-location': WRONG_LOCATION_SUMMARY };
  const markFiltered = (job) => {
    markAnalyzed(clientId, job.id, false, null, FILTER_SUMMARY[rejectJob(job)] ?? null);
  };
  const countBy = (jobs, reason) => jobs.filter(job => rejectJob(job) === reason).length;

  const blockedJobs = newJobs.filter(job => isFiltered(job));
  const jobsToProcess = newJobs.filter(job => !isFiltered(job));
  const listed = blockedJobs.filter(job => rejectJob(job) === 'blocked');

  if (listed.length > 0) {
    // Blocklist hits are listed one by one; an allowlist typically drops most
    // titles, so those only show up in the count below.
    log(`Title-filtered ${listed.length} job(s) by the blocklist (saving as irrelevant to skip on future runs):`);
    for (const job of listed) log(`  ✗ ${job.title}`);
  }
  if (titleFilter.hasAllowlist) {
    log(`Positivliste: ${newJobs.length - blockedJobs.length} neue Stelle(n) behalten, ${countBy(blockedJobs, 'not-allowed')} aussortiert`);
  }
  if (locationFilter.hasList) {
    log(`Ortsfilter: ${countBy(blockedJobs, 'wrong-location')} neue Stelle(n) außerhalb der eingetragenen Orte aussortiert`);
  }
  for (const job of blockedJobs) {
    try {
      saveJob(clientId, job);
      markFiltered(job);
    } catch (err) { log(`ERROR saving blocked job "${job.title}": ${err.message}`); }
  }

  // Jobs an earlier allowlist / location list dropped, which the current lists
  // let through (a typo fixed, a term added): back into the analysis queue.
  // Only while that list is set — clearing it would release every job it ever
  // dropped — only postings still seen within the expiry window, capped per run.
  const seenSince = new Date(Date.now() - EXPIRY_THRESHOLD_HOURS * 3600 * 1000).toISOString();
  const reopenable = [
    titleFilter.hasAllowlist ? NOT_ALLOWED_SUMMARY : null,
    locationFilter.hasList ? WRONG_LOCATION_SUMMARY : null,
  ].filter(Boolean)
    .flatMap(summary => getJobsWithSummary(clientId, summary, seenSince))
    .filter(job => !isFiltered(job));
  const reopen = reopenable.slice(0, MAX_REOPEN_PER_RUN);
  if (reopen.length > 0) {
    try {
      reopenForAnalysis(clientId, reopen.map(job => job.id));
      const later = reopenable.length - reopen.length;
      log(`Vorfilter geändert: ${reopen.length} früher aussortierte Stelle(n) werden jetzt bewertet` +
          (later > 0 ? `, ${later} weitere in den nächsten Läufen` : ''));
    } catch (err) { log(`ERROR reopening pre-filtered jobs: ${err.message}`); }
  }

  const newJobIds = new Set(jobsToProcess.map(j => j.id));

  // 4./5. Fetch full descriptions and save each job the moment its description is
  // in — not in one batch afterwards. The ordering is what makes a stop cheap:
  // every job whose detail page we already paid for is in the DB, so the next run
  // goes straight to analysing it instead of scraping and fetching it all again.
  const savedIds = new Set();
  const persist = (job) => {
    if (savedIds.has(job.id)) return;
    // While winding down, only jobs that actually got their description: saving
    // an empty one would let the next run score a blank posting and mark it
    // analysed for good. Unsaved simply means "not seen yet" — it comes back.
    if (isAborted() && !job.description) return;
    try { saveJob(clientId, job); savedIds.add(job.id); }
    catch (err) { log(`ERROR saving "${job.title}": ${err.message}`); }
  };

  // Platform scrapers may already carry the description — no detail visit needed.
  for (const job of jobsToProcess) if (job.description) persist(job);

  const needsDescription = jobsToProcess.filter(j => !j.description);
  tick('descriptions');
  if (needsDescription.length > 0) {
    try {
      await fetchDescriptions(needsDescription, { onJob: persist });
    } catch (err) {
      log(`ERROR fetching descriptions: ${err.message}`);
    }
  }
  log(`⏱  Descriptions (${needsDescription.length} jobs): ${tock('descriptions')}`);

  if (isAborted()) {
    const skipped = jobsToProcess.length - savedIds.size;
    log(`⏹  ${savedIds.size} Job(s) mit Beschreibung gespeichert${skipped > 0 ? `, ${skipped} noch nicht abgerufene werden im nächsten Lauf geholt` : ''}.`);
  } else {
    // Regular run: anything the fetch loop didn't reach (e.g. an early throw) is
    // still saved, exactly as before — an empty description stays recoverable
    // via `npm run refetch-descriptions`.
    for (const job of jobsToProcess) persist(job);
  }

  // 6. Build per-source counters
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
  const allUnanalyzed = getUnanalyzedJobs(clientId);

  // Apply the pre-filters retroactively to jobs saved before they were updated
  const retroBlocked = allUnanalyzed.filter(job => isFiltered(job));
  if (retroBlocked.length > 0) {
    const retroNotAllowed = countBy(retroBlocked, 'not-allowed');
    const retroLocation = countBy(retroBlocked, 'wrong-location');
    const parts = [
      retroNotAllowed > 0 ? `${retroNotAllowed} nicht in der Positivliste` : '',
      retroLocation > 0 ? `${retroLocation} außerhalb der Orte` : '',
    ].filter(Boolean);
    log(`Retroactively filtering ${retroBlocked.length} already-saved job(s) matching a pre-filter` +
        (parts.length ? ` (davon ${parts.join(', ')})` : ''));
    for (const job of retroBlocked) {
      try { markFiltered(job); }
      catch (err) { log(`ERROR marking "${job.title}": ${err.message}`); }
    }
  }
  const thin = await settleThinDescriptions(clientId, allUnanalyzed.filter(job => !isFiltered(job)), savedIds);
  const toAnalyze = thin.ready;
  // "Analysiert" in the overview counts new jobs that went to Claude — not the
  // ones held back for a missing description.
  for (const job of thin.held) {
    if (newJobIds.has(job.id) && sourceStats[job.source]) sourceStats[job.source].newCount--;
  }
  log(`Analyzing ${toAnalyze.length} unanalyzed job(s)...`);

  const isPriority = titleFilter.isPriority;

  const analysisCache = new Map(); // id → analysis (reused for notifications)
  let analysisIdx = 0;

  tick('analysis');
  async function analysisWorker() {
    while (analysisIdx < toAnalyze.length) {
      if (isAborted()) return;
      const i = analysisIdx++;
      const job = toAnalyze[i];
      const progress = `[${i + 1}/${toAnalyze.length}]`;
      try {
        const analysis = await analyzeJob(job, cfg);
        if (!analysis) { log(`  ${progress} No result for "${job.title}"`); continue; }

        if (isPriority(job.title)) {
          // Floor priority jobs at 7 — `!(score >= 7)` also covers a missing/NaN score.
          if (!(analysis.score >= 7)) analysis.score = 7;
          // Relevance still honors the client's own threshold: a client with
          // minRelevanceScore 8+ must not be notified about a floored 7.
          analysis.relevant = analysis.relevant || analysis.score >= cfg.minRelevanceScore;
        }

        markAnalyzed(clientId, job.id, analysis.relevant, analysis.score ?? null, analysis.summary ?? null);
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

  // Abort cut-off. Everything scraped and analyzed so far is already committed to
  // the DB, but the remaining stages must NOT run on a partial pass:
  //   • expiry detection compares last_seen against sources we never visited, so
  //     it would declare live jobs expired;
  //   • the run snapshot would record 0 for every unscraped source and skew the
  //     stats charts;
  //   • notifications and auto-apply are side effects the user just asked to stop.
  // Relevant-but-unnotified jobs stay queued and go out with the next run.
  if (isAborted()) {
    log(`⏹  Lauf abgebrochen für "${client.name}" — Benachrichtigungen, Ablauf-Prüfung, Statistik und Export übersprungen. Bereits gefundene Jobs sind gespeichert.`);
    return;
  }

  // 8. Send notifications — use cached analysis, only re-call Claude if truly missing.
  tick('notifications');
  const toNotify = getRelevantUnnotifiedJobs(clientId);

  if (!isTelegramEnabled(client)) {
    if (toNotify.length > 0)
      log(`Telegram nicht aktiv für "${client.name}" — ${toNotify.length} relevante(r) Job(s) nur in der GUI sichtbar.`);
  } else {
    log(`Sending notifications for ${toNotify.length} job(s)...`);
    if (toNotify.length > 0) {
      const pairs = [];
      for (const job of toNotify) {
        const analysis = analysisCache.get(job.id) ?? await analyzeJob(job, cfg).catch(() => null);
        if (analysis) pairs.push({ job, analysis });
      }

      const sentJobs = await notifyBatch(pairs, client);

      for (const job of sentJobs) {
        try {
          markNotified(clientId, job.id);
          if (sourceStats[job.source]) sourceStats[job.source].notified++;
        } catch (err) { log(`ERROR marking notified "${job.title}": ${err.message}`); }
      }
    }
  }
  log(`⏱  Notifications (${toNotify.length} jobs): ${tock('notifications')}`);

  // 8b. Auto-enqueue applications: new relevant platform jobs with
  // "Einfach bewerben" (or unknown for LinkedIn — prepare verifies it) land in
  // the approval queue when the client opted in AND the global switch is on.
  // Enqueued means "prepare it", never "send it" — submission always requires
  // an explicit approval.
  if (client.auto_apply === 'queue' && isTruthy(process.env.AUTO_APPLY_ENABLED)) {
    const MAX_ENQUEUE_PER_RUN = 15;
    let enqueued = 0;
    for (const job of jobsToProcess) {
      if (enqueued >= MAX_ENQUEUE_PER_RUN) break;
      if (!job.platform) continue;
      if (job.easyApply === 0) continue; // known external-apply
      const row = getJobById(clientId, job.id);
      if (!row || !row.relevant) continue;
      if ((row.score ?? 0) < cfg.minRelevanceScore) continue;
      try {
        createApplication(clientId, job.id, job.platform);
        enqueued++;
      } catch (err) {
        log(`ERROR enqueuing application for "${job.title}": ${err.message}`);
      }
    }
    if (enqueued > 0) log(`Auto-Apply: ${enqueued} Bewerbung(en) in die Warteschlange gestellt.`);
  }

  // 9. Detect and notify expired jobs (notified but not seen for 3+ days).
  // Skipped entirely when any source was blocked or crashed this run: an
  // incomplete scrape makes "not seen" meaningless and would mass-expire jobs.
  if (scrapeIncomplete) {
    log('Mindestens eine Quelle blockiert/unvollständig — Ablauf-Prüfung wird für diesen Lauf übersprungen.');
  }
  const expiryOn = !scrapeIncomplete
    && isTelegramEnabled(client)
    && EXPIRY_NOTIFICATIONS_GLOBAL
    && String(client.expiry_notifications || 'on').trim().toLowerCase() !== 'off';
  const expiredJobs = expiryOn ? getJobsToExpire(clientId, EXPIRY_THRESHOLD_HOURS) : [];
  let expiredCount = 0;
  if (expiredJobs.length > 0) {
    log(`${expiredJobs.length} job(s) no longer listed — sending expiry notifications...`);
    for (const job of expiredJobs) {
      try {
        await notifyExpired(job, client);
        markExpired(clientId, job.id);
        expiredCount++;
      } catch (err) {
        log(`ERROR sending expiry notification for "${job.title}": ${err.message}`);
      }
    }
  }

  // 10. Print overview + persist a snapshot for the GUI stats page
  const relevantBySource = getRelevantCountBySource(clientId);
  printOverview(client.name, sources, sourceStats, relevantBySource, expiredCount, thin);

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
        // Why this source looks broken this run (null = fine) — the Run tab
        // offers a GitHub problem report for every row that has one.
        problem:       classifySourceProblem({
          found: s.total || 0,
          blocked: scrapeStats[source.name]?.blocked,
          error: scrapeStats[source.name]?.error,
        }),
        error:         scrapeStats[source.name]?.error ?? null,
      };
    });
    saveRunSnapshot(clientId, snapshotRows);
  } catch (err) {
    log(`ERROR saving run snapshot: ${err.message}`);
  }

  // 11. Export this client's relevant jobs to Excel
  tick('export');
  await exportToExcel(clientId);
  log(`⏱  Export: ${tock('export')}`);
}

// Orchestrate a run across all enabled clients (or a single client when given).
// Sets up one shared log file + console redirect so the GUI "Lauf" tab sees it all.
let runInProgress = false;

export async function runAll({ onlyClientId } = {}) {
  // Overlap guard: a cron tick during a still-running pass would double-notify,
  // double-pay for analysis, and corrupt the console.log redirect chain below.
  if (runInProgress) {
    console.log(`[${new Date().toISOString()}] [scheduler] Lauf läuft bereits — dieser Trigger wird übersprungen.`);
    return;
  }
  runInProgress = true;
  const startTime = Date.now();
  const logsDir = LOGS_DIR;
  mkdirSync(logsDir, { recursive: true });
  // Millisecond precision: two runs starting in the same second must not
  // truncate each other's log file.
  const ts = new Date().toISOString().replace(/T/, '_').replace(/:/g, '-').replace(/\./g, '-').slice(0, 23);
  const logFile = path.join(logsDir, `${ts}.log`);
  const logStream = createWriteStream(logFile);
  const _origLog = console.log;
  console.log = (...args) => {
    const line = args.map(a => (typeof a === 'string' ? a : String(a))).join(' ');
    _origLog(line);
    logStream.write(line + '\n');
  };

  // From here on a termination signal means "abort and save" instead of "die
  // now" — see installAbortSignals(). Cleared again in the finally below, so the
  // idle scheduler keeps exiting instantly between runs.
  beginRun();
  try {
    let clients = onlyClientId ? [getClient(onlyClientId)].filter(Boolean) : getEnabledClients();
    if (onlyClientId && !clients.length) {
      log(`Klient "${onlyClientId}" nicht gefunden.`);
      return;
    }
    if (onlyClientId && clients[0] && !clients[0].enabled) {
      log(`Hinweis: Klient "${clients[0].name}" ist deaktiviert — wird wegen expliziter Auswahl trotzdem ausgeführt.`);
    }
    log(`Run startet für ${clients.length} Klient(en)…`);
    for (const client of clients) {
      if (isAborted()) {
        log(`Abbruch — verbleibende Klienten werden nicht mehr ausgeführt.`);
        break;
      }
      try {
        await runClientPipeline(client);
      } catch (err) {
        log(`Unhandled error in pipeline for client "${client.name}": ${err.message}`);
      }
    }
  } finally {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`Run ${isAborted() ? 'abgebrochen' : 'finished'} in ${elapsed}s — log: ${logFile}`);
    // Fold this run's writes out of the WAL so it can't grow without bound and the
    // next backup snapshots a fully checkpointed file. Runs in the scheduler process
    // and in the spawned `index.js --once` child alike, so both keep the WAL small.
    checkpointWal();
    console.log = _origLog;
    await new Promise(resolve => logStream.end(resolve));
    runInProgress = false;
    endRun();
  }
}

// Take the daily backup BEFORE the run and wait for it to finish: the snapshot must
// be made against a quiescent DB, never while runAll is writing. (A backup fired
// concurrently with the run captured a stale, mid-run snapshot that then repeated
// unchanged day after day.) The backup is idempotent + cross-process locked, so this
// is a no-op once today's backup already exists.
async function backupThenRun(label) {
  await maybeRunDailyBackup().catch(err => log(`Daily backup check failed: ${err.message}`));
  await runAll().catch(err => log(`Unhandled error in ${label} run: ${err.message}`));
  // A signal-triggered abort means the operator (or Docker/systemd) asked this
  // process to stop. The run has saved its work by now, so honour that instead of
  // waiting around for the next cron tick. Exit 0: the shutdown itself succeeded.
  if (exitRequested()) {
    log('Beendigungs-Signal — Scheduler fährt herunter.');
    process.exit(0);
  }
}

export function startScheduler() {
  log(`Scheduler starting — schedule: ${CRON_SCHEDULE}`);
  // Interactive Telegram bot (Q&A, Freigabe-Buttons, Status per Reaktion) and
  // the auto-apply worker live in THIS process only — exactly one Telegram
  // poller per token, and exactly one process touching Playwright sessions.
  startTelegramBot();
  startApplyWorker();
  // The scheduler is long-lived, so it also ensures today's backup exists (idempotent
  // + cross-process lock → never a duplicate of the GUI's), then runs.
  backupThenRun('initial');
  cron.schedule(CRON_SCHEDULE, () => {
    log('Cron triggered');
    backupThenRun('scheduled');
  });
}
