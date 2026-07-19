// Auto-apply worker — runs ONLY in the scheduler process, strictly one
// Playwright job at a time. Each tick it advances the application queue:
//
//   prepare: queued → preparing → (awaiting_answers | ready_for_review)
//   submit:  approved → submitting → (submitted | failed)
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
  getNextApplicationByState, getApplicationById, claimApplication, updateApplication,
  logApplicationEvent, getJobById, getClient, setJobEasyApply, setApplicationStatus,
  countSubmittedToday, getLastSubmittedAt, getLibraryAnswers, upsertLibraryAnswer,
} from './database.js';
import { generateCoverLetter } from './cover-letter.js';
import { getAuthenticatedContext, LoginChallengeError, MissingCredentialsError } from './platform-login.js';
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

  const browser = await launchPlatformBrowser();
  let context = null;
  try {
    context = await getAuthenticatedContext(browser, app.client_id, app.platform);
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
    } else if (err instanceof MissingCredentialsError) {
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
    await browser.close().catch(() => {});
  }
}

// ── Submit pass ──────────────────────────────────────────────────────────────

async function submitPass() {
  const app = getNextApplicationByState('approved');
  if (!app) return false;
  const job = getJobById(app.client_id, app.job_id);
  const client = getClient(app.client_id);
  if (!job || !client) {
    claimApplication(app.id, 'approved', 'failed');
    updateApplication(app.id, { error: 'Job oder Klient nicht mehr vorhanden' });
    return true;
  }

  // Safety rails BEFORE any browser work. A blocked rail leaves the row in
  // `approved` — it is picked up again on a later tick.
  const cap = effectiveDailyCap(client, app.platform);
  if (countSubmittedToday(app.client_id, app.platform) >= cap) {
    log(`Cap erreicht (${cap}/Tag, ${app.platform}) — "${job.title}" wartet bis morgen.`);
    return false;
  }
  const last = getLastSubmittedAt(app.platform);
  if (last) {
    const ageMin = (Date.now() - Date.parse(last)) / 60000;
    const needed = cooldownMinutes() + jitter(0, 5);
    if (ageMin < needed) {
      log(`Cooldown (${ageMin.toFixed(1)} < ${needed} Min, ${app.platform}) — später.`);
      return false;
    }
  }

  if (!claimApplication(app.id, 'approved', 'submitting')) return false;
  log(`Submit: "${job.title}" (${app.platform}) für ${client.name}${dryRun() ? ' [DRY-RUN]' : ''}`);
  logApplicationEvent(app.id, 'submit_start', dryRun() ? 'dry-run' : null);

  const browser = await launchPlatformBrowser();
  try {
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
    updateApplication(app.id, { error: result.error || 'Unbekannter Fehler', attempts: (app.attempts || 0) + 1 });
    logApplicationEvent(app.id, 'failed', `submit: ${result.error}`);
    log(`  ✗ ${result.error}`);
    return true;
  } catch (err) {
    if (err instanceof LoginChallengeError) {
      claimApplication(app.id, 'submitting', 'approved'); // retry after manual login
      logApplicationEvent(app.id, 'login_challenge', err.message);
      await sendInfoToClient(client, `⚠️ ${err.message}`).catch(() => {});
    } else {
      claimApplication(app.id, 'submitting', 'failed');
      updateApplication(app.id, { error: err.message, attempts: (app.attempts || 0) + 1 });
      logApplicationEvent(app.id, 'failed', `submit: ${err.message}`);
    }
    log(`  Submit-Fehler: ${err.message}`);
    return true;
  } finally {
    await browser.close().catch(() => {});
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

export function startApplyWorker() {
  if (!autoApplyEnabled()) {
    log('AUTO_APPLY_ENABLED ist aus — Worker bleibt inaktiv (Schalter wird pro Tick geprüft).');
  } else {
    log(`Worker gestartet — Tick alle ${TICK_MS / 1000}s${dryRun() ? ', DRY-RUN aktiv' : ''}.`);
  }
  setInterval(tick, TICK_MS).unref();
  tick();
}
