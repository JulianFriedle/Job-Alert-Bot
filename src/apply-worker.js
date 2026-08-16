// Auto-apply worker — runs ONLY in the scheduler process, strictly one
// Playwright job at a time. Each tick it advances the application queue:
//
//   prepare: queued → preparing → (awaiting_answers | ready_for_review)
//   submit:  approved → submitting → (submitted | failed)
//   dry-run: approved → submitting → ready_for_review (form filled, NOT sent;
//            re-approving runs another rehearsal until APPLY_DRY_RUN=false)
//
// Every state change goes through claimApplication (atomic compare-and-set),
// so the GUI or Telegram acting on the same row at the same moment can never
// race the worker. Nothing is EVER submitted from any state but `approved`,
// and even then the kill switch, daily cap and cooldown are checked first.
import 'dotenv/config';
import { mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  getNextApplicationByState, getApplicationsByState, getApplicationById, claimApplication,
  updateApplication, logApplicationEvent, getJobById, getClient, setJobEasyApply,
  setApplicationStatus, countSubmittedToday, getLastSubmittedAt, getLibraryAnswers,
  upsertLibraryAnswer,
} from './database.js';
import { generateCoverLetter } from './cover-letter.js';
import { getAuthenticatedContext, LoginChallengeError, MissingCredentialsError, InvalidCredentialsError } from './platform-login.js';
import { launchPlatformBrowser, isTruthy, jitter } from './scrapers/browser.js';
import { parseQuestions, prefillFromLibrary, unansweredRequired, libraryRowsFromQuestions } from './questions.js';
import { sendNextQuestion, sendReviewSummary, sendInfoToClient } from './telegram-bot.js';
import * as stepstoneApplier from './appliers/stepstone.js';
import * as linkedinApplier from './appliers/linkedin.js';
import * as indeedApplier from './appliers/indeed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = path.join(__dirname, '..', 'data', 'apply-artifacts');
const CV_DIR = path.join(__dirname, '..', 'data', 'cv');

const APPLIERS = { stepstone: stepstoneApplier, linkedin: linkedinApplier, indeed: indeedApplier };

// Hard per-platform caps — the env/client cap can only lower these. LinkedIn
// and Indeed suspend accounts over automation far quicker than StepStone.
const PLATFORM_HARD_CAP = { linkedin: 5, indeed: 5, stepstone: 10 };

const TICK_MS = 45_000;
const MAX_ATTEMPTS = 3;

function log(msg) {
  console.log(`[${new Date().toISOString()}] [apply-worker] ${msg}`);
}

const autoApplyEnabled = () => isTruthy(process.env.AUTO_APPLY_ENABLED);
const dryRun = () => process.env.APPLY_DRY_RUN == null ? true : isTruthy(process.env.APPLY_DRY_RUN);
const cooldownMinutes = () => Number(process.env.APPLY_COOLDOWN_MINUTES) || 15;

function effectiveDailyCap(client, platform) {
  const envCap = Number(process.env.APPLY_DAILY_CAP);
  const caps = [
    PLATFORM_HARD_CAP[platform] ?? 10,
    Number.isFinite(envCap) ? envCap : 10,
  ];
  if (client?.max_applies_per_day != null) caps.push(Number(client.max_applies_per_day));
  return Math.min(...caps);
}

function screenshotFn(appId, page) {
  const dir = path.join(ARTIFACTS_DIR, appId);
  mkdirSync(dir, { recursive: true });
  return async (name, altPage) => {
    const p = altPage || page;
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${name}.png`);
    await p.screenshot({ path: file }).catch(() => {});
    return file;
  };
}

function cvPathFor(clientId) {
  return path.join(CV_DIR, `${clientId}.pdf`);
}

// ── Prepare pass ─────────────────────────────────────────────────────────────

async function preparePass() {
  const app = getNextApplicationByState('queued');
  if (!app) return false;
  const job = getJobById(app.client_id, app.job_id);
  const client = getClient(app.client_id);
  if (!job || !client) {
    claimApplication(app.id, 'queued', 'failed');
    updateApplication(app.id, { error: 'Job oder Klient nicht mehr vorhanden' });
    return true;
  }
  if (!claimApplication(app.id, 'queued', 'preparing')) return false;
  log(`Prepare: "${job.title}" (${app.platform}) für ${client.name}`);
  logApplicationEvent(app.id, 'prepare_start');

  // Cover letter first — no browser needed, and reused on retries.
  let coverLetter = app.cover_letter;
  if (!coverLetter) {
    try {
      coverLetter = await generateCoverLetter(job);
      updateApplication(app.id, { cover_letter: coverLetter });
    } catch (err) {
      log(`Anschreiben fehlgeschlagen (weiter ohne): ${err.message}`);
    }
  }

  // The browser launch lives INSIDE the try: a launch failure must run the
  // same claim-based error handling below, or the row is stranded in `preparing`.
  let browser = null;
  try {
    browser = await launchPlatformBrowser();
    const context = await getAuthenticatedContext(browser, app.client_id, app.platform);
    const page = await context.newPage();
    const screenshot = screenshotFn(app.id, page);

    const result = await APPLIERS[app.platform].prepare(page, job, { cvPath: cvPathFor(app.client_id) });

    if (result.external) {
      // Turned out to be an off-site application after all.
      setJobEasyApply(app.client_id, app.job_id, 0);
      claimApplication(app.id, 'preparing', 'discarded');
      logApplicationEvent(app.id, 'external_apply', 'Kein Einfach-bewerben — externes Formular');
      log(`  → extern (kein Einfach bewerben), verworfen.`);
      return true;
    }
    if (result.unsupported) {
      await screenshot('prepare-unsupported');
      claimApplication(app.id, 'preparing', 'failed');
      updateApplication(app.id, { error: `Nicht unterstützt: ${result.unsupported}`, attempts: (app.attempts || 0) + 1 });
      logApplicationEvent(app.id, 'failed', `unsupported: ${result.unsupported}`);
      return true;
    }

    // Pre-fill from the answer library, then decide the next state.
    const questions = result.questions || [];
    const filled = prefillFromLibrary(questions, getLibraryAnswers(app.client_id));
    updateApplication(app.id, {
      questions_json: JSON.stringify(questions),
      prepared_at: new Date().toISOString(),
    });
    logApplicationEvent(app.id, 'questions_found', `${questions.length} Frage(n), ${filled} aus Bibliothek vorbefüllt`);

    if (unansweredRequired(questions).length > 0) {
      claimApplication(app.id, 'preparing', 'awaiting_answers');
      log(`  → ${unansweredRequired(questions).length} offene Pflichtfrage(n) — frage per Telegram.`);
      await sendNextQuestion(app.id).catch(err => log(`Telegram-Frage fehlgeschlagen: ${err.message}`));
    } else {
      claimApplication(app.id, 'preparing', 'ready_for_review');
      log(`  → bereit zur Freigabe.`);
      await sendReviewSummary(app.id).catch(err => log(`Telegram-Review fehlgeschlagen: ${err.message}`));
    }
    return true;
  } catch (err) {
    if (err instanceof LoginChallengeError) {
      // Not the application's fault — back to queued, retried next cycle.
      claimApplication(app.id, 'preparing', 'queued');
      logApplicationEvent(app.id, 'login_challenge', err.message);
      await sendInfoToClient(client, `⚠️ ${err.message}`).catch(() => {});
      log(`  Login-Challenge: ${err.message}`);
    } else if (err instanceof MissingCredentialsError || err instanceof InvalidCredentialsError) {
      // Terminal: retrying with the same missing/wrong credentials would only
      // hammer the platform's login. attempts is pinned so Retry stays blocked.
      claimApplication(app.id, 'preparing', 'failed');
      updateApplication(app.id, { error: err.message, attempts: MAX_ATTEMPTS });
      logApplicationEvent(app.id, 'failed', err.message);
      log(`  ${err.message}`);
    } else {
      claimApplication(app.id, 'preparing', 'failed');
      updateApplication(app.id, { error: err.message, attempts: (app.attempts || 0) + 1 });
      logApplicationEvent(app.id, 'failed', `prepare: ${err.message}`);
      log(`  Prepare-Fehler: ${err.message}`);
    }
    return true;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ── Submit pass ──────────────────────────────────────────────────────────────

async function submitPass() {
  // Walk ALL approved rows (oldest first) and take the first whose platform is
  // neither capped nor cooling down — a blocked LinkedIn row must not
  // head-of-line-block StepStone/Indeed submissions. A skipped row stays in
  // `approved` and is reconsidered on a later tick.
  const blockedKeys = new Set(); // avoids duplicate log lines per platform
  let app = null, job = null, client = null;
  for (const cand of getApplicationsByState('approved')) {
    const candJob = getJobById(cand.client_id, cand.job_id);
    const candClient = getClient(cand.client_id);
    if (!candJob || !candClient) {
      claimApplication(cand.id, 'approved', 'failed');
      updateApplication(cand.id, { error: 'Job oder Klient nicht mehr vorhanden' });
      return true;
    }

    // Safety rails BEFORE any browser work.
    const cap = effectiveDailyCap(candClient, cand.platform);
    if (countSubmittedToday(cand.client_id, cand.platform) >= cap) {
      if (!blockedKeys.has(`cap:${cand.client_id}:${cand.platform}`)) {
        blockedKeys.add(`cap:${cand.client_id}:${cand.platform}`);
        log(`Cap erreicht (${cap}/Tag, ${cand.platform}) — "${candJob.title}" wartet bis morgen.`);
      }
      continue;
    }
    const last = getLastSubmittedAt(cand.platform);
    if (last) {
      const ageMin = (Date.now() - Date.parse(last)) / 60000;
      const needed = cooldownMinutes() + jitter(0, 5);
      if (ageMin < needed) {
        if (!blockedKeys.has(`cooldown:${cand.platform}`)) {
          blockedKeys.add(`cooldown:${cand.platform}`);
          log(`Cooldown (${ageMin.toFixed(1)} < ${needed} Min, ${cand.platform}) — später.`);
        }
        continue;
      }
    }
    app = cand; job = candJob; client = candClient;
    break;
  }
  if (!app) return false;

  if (!claimApplication(app.id, 'approved', 'submitting')) return false;
  log(`Submit: "${job.title}" (${app.platform}) für ${client.name}${dryRun() ? ' [DRY-RUN]' : ''}`);
  logApplicationEvent(app.id, 'submit_start', dryRun() ? 'dry-run' : null);

  // Browser launch INSIDE the try — a launch failure must hit the claim-based
  // error handling below, or the row is stranded in `submitting`, the one
  // state no GUI/Telegram path can leave.
  let browser = null;
  try {
    browser = await launchPlatformBrowser();
    const context = await getAuthenticatedContext(browser, app.client_id, app.platform);
    const page = await context.newPage();
    const screenshot = screenshotFn(app.id, page);
    const questions = parseQuestions(app.questions_json);

    const result = await APPLIERS[app.platform].submit(page, app, job, {
      questions,
      coverLetter: app.cover_letter || '',
      cvPath: cvPathFor(app.client_id),
      dryRun: dryRun(),
      screenshot,
    });

    if (result.ok && result.dryRun) {
      claimApplication(app.id, 'submitting', 'ready_for_review');
      logApplicationEvent(app.id, 'dry_run_complete', 'Formular ausgefüllt, NICHT gesendet (APPLY_DRY_RUN)');
      await sendInfoToClient(client, `🧪 Probelauf abgeschlossen für "${job.title}" — nichts wurde gesendet. Zum echten Versand APPLY_DRY_RUN=false setzen.`).catch(() => {});
      log(`  Dry-Run fertig — Screenshot unter data/apply-artifacts/${app.id}/`);
      return true;
    }
    if (result.ok) {
      claimApplication(app.id, 'submitting', 'submitted');
      updateApplication(app.id, { submitted_at: new Date().toISOString(), error: null });
      logApplicationEvent(app.id, 'submitted', result.confirmation || null);
      // Job status → applied (writes the status_history entry too), and every
      // final answer is remembered for the next application.
      setApplicationStatus(app.client_id, app.job_id, 'applied');
      for (const row of libraryRowsFromQuestions(parseQuestions(getApplicationById(app.id).questions_json))) {
        upsertLibraryAnswer(app.client_id, row);
      }
      await sendInfoToClient(client, `🚀 Bewerbung gesendet: "${job.title}" (${app.platform}). Bestätigung: ${result.confirmation || 'siehe Plattform'}`).catch(() => {});
      log(`  ✔ gesendet.`);
      return true;
    }

    claimApplication(app.id, 'submitting', 'failed');
    updateApplication(app.id, {
      error: result.error || 'Unbekannter Fehler',
      // clicked = the send button was pressed but no confirmation was found;
      // the outcome is unknown, so attempts is pinned — a blind retry could
      // submit the same application to the employer a second time.
      attempts: result.clicked ? MAX_ATTEMPTS : (app.attempts || 0) + 1,
    });
    logApplicationEvent(app.id, 'failed', `submit: ${result.error}${result.clicked ? ' (nach Klick — Ergebnis unbekannt, Retry gesperrt)' : ''}`);
    log(`  ✗ ${result.error}`);
    return true;
  } catch (err) {
    if (err instanceof LoginChallengeError) {
      claimApplication(app.id, 'submitting', 'approved'); // retry after manual login
      logApplicationEvent(app.id, 'login_challenge', err.message);
      await sendInfoToClient(client, `⚠️ ${err.message}`).catch(() => {});
    } else if (err instanceof MissingCredentialsError || err instanceof InvalidCredentialsError) {
      claimApplication(app.id, 'submitting', 'failed');
      updateApplication(app.id, { error: err.message, attempts: MAX_ATTEMPTS });
      logApplicationEvent(app.id, 'failed', err.message);
    } else {
      claimApplication(app.id, 'submitting', 'failed');
      updateApplication(app.id, { error: err.message, attempts: (app.attempts || 0) + 1 });
      logApplicationEvent(app.id, 'failed', `submit: ${err.message}`);
    }
    log(`  Submit-Fehler: ${err.message}`);
    return true;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ── Loop ─────────────────────────────────────────────────────────────────────

let ticking = false;

async function tick() {
  if (ticking) return;
  if (!autoApplyEnabled()) return;
  ticking = true;
  try {
    await preparePass();
    await submitPass();
  } catch (err) {
    log(`Tick-Fehler: ${err.message}`);
  } finally {
    ticking = false;
  }
}

// Crash recovery: `preparing`/`submitting` are transient worker states; rows
// still in them at startup were stranded by a previous process death. Prepare
// is idempotent → back to `queued`. A submit may or may not have gone through,
// so those rows become `failed` with attempts pinned — never blindly resent.
function reapStrandedApplications() {
  for (const app of getApplicationsByState('preparing')) {
    if (claimApplication(app.id, 'preparing', 'queued')) {
      logApplicationEvent(app.id, 'requeued', 'Prozessneustart während prepare');
      log(`Requeued (Neustart während prepare): App ${app.id.slice(0, 8)}`);
    }
  }
  for (const app of getApplicationsByState('submitting')) {
    if (claimApplication(app.id, 'submitting', 'failed')) {
      updateApplication(app.id, {
        error: 'Prozess wurde während des Versands beendet — Ergebnis unbekannt, bitte auf der Plattform prüfen.',
        attempts: MAX_ATTEMPTS,
      });
      logApplicationEvent(app.id, 'failed', 'Prozessneustart während submit — Ergebnis unbekannt');
      log(`Als fehlgeschlagen markiert (Neustart während submit): App ${app.id.slice(0, 8)}`);
    }
  }
}

export function startApplyWorker() {
  reapStrandedApplications();
  if (!autoApplyEnabled()) {
    log('AUTO_APPLY_ENABLED ist aus — Worker bleibt inaktiv (Schalter wird pro Tick geprüft).');
  } else {
    log(`Worker gestartet — Tick alle ${TICK_MS / 1000}s${dryRun() ? ', DRY-RUN aktiv' : ''}.`);
  }
  setInterval(tick, TICK_MS).unref();
  tick();
}
