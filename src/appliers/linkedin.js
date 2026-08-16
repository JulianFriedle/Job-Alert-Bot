// LinkedIn Easy-Apply applier. The flow is a modal wizard with 1–n steps;
// prepare() walks forward harvesting fields and then DISCARDS the draft (the
// modal's own discard dialog), so nothing is ever sent during preparation.
// Flows with more than MAX_STEPS steps or extra file uploads are reported as
// unsupported instead of guessed through.
import { humanDelay } from '../scrapers/browser.js';
import { harvestFieldsInPage, fieldsToQuestions, fillAnswers, clickButtonByText } from './common.js';

const MODAL = '.jobs-easy-apply-modal, [data-test-modal], .artdeco-modal';
const MAX_STEPS = 7;

const NEXT_BUTTON   = ['weiter', 'continue to next step', 'next', 'überprüfen', 'review'];
const SUBMIT_BUTTON = ['bewerbung senden', 'submit application'];

function log(msg) {
  console.log(`[${new Date().toISOString()}] [applier:linkedin] ${msg}`);
}

async function openJob(page, job) {
  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
  await humanDelay(1500, 3000);
}

// Click the Easy-Apply button. 'external' when the job only offers off-site apply.
async function openEasyApply(page) {
  const kind = await page.evaluate(() => {
    const btn = document.querySelector('.jobs-apply-button, button[data-live-test-job-apply-button]');
    if (!btn || btn.offsetParent === null) return 'none';
    const label = ((btn.textContent || '') + ' ' + (btn.getAttribute('aria-label') || '')).toLowerCase();
    // Easy Apply keeps you on LinkedIn; plain "Bewerben/Apply" navigates off-site.
    const easy = /easy apply|einfach bewerben/.test(label);
    btn.click();
    return easy ? 'easy' : 'maybe-external';
  }).catch(() => 'none');
  if (kind === 'none') return 'external';
  await humanDelay(1500, 3000);
  const hasModal = await page.locator(MODAL).count().catch(() => 0);
  if (hasModal === 0) return 'external'; // click navigated away instead of opening the wizard
  return 'form';
}

async function currentStepHasSubmit(page) {
  return page.evaluate((sel) => {
    const modal = document.querySelector(sel);
    if (!modal) return false;
    return [...modal.querySelectorAll('button')].some(b =>
      /bewerbung senden|submit application/i.test(((b.textContent || '') + (b.getAttribute('aria-label') || ''))));
  }, MODAL).catch(() => false);
}

async function discardDraft(page) {
  await page.evaluate((sel) => {
    document.querySelector(`${sel} .artdeco-modal__dismiss, ${sel} button[aria-label*="verwerfen" i], ${sel} button[aria-label*="dismiss" i]`)?.click();
  }, MODAL).catch(() => {});
  await humanDelay(800, 1500);
  // Confirm dialog: "Entwurf verwerfen" / "Discard"
  await clickButtonByText(page, ['verwerfen', 'discard']);
  await humanDelay(500, 1000);
}

// Walk the wizard. `onStep(stepIndex)` runs per step BEFORE advancing. Stops on
// the step that carries the submit button. Returns 'submit-step' | 'stuck' | 'too-many-steps'.
async function walkSteps(page, onStep) {
  for (let step = 0; step < MAX_STEPS; step++) {
    await humanDelay(800, 1600);
    await onStep(step);
    if (await currentStepHasSubmit(page)) return 'submit-step';
    const clicked = await clickButtonByText(page, NEXT_BUTTON, MODAL);
    if (!clicked) return 'stuck';
    await page.waitForTimeout(1200);
    // A validation error keeps the wizard on the same step (required field empty).
    const hasError = await page.evaluate((sel) => {
      const modal = document.querySelector(sel);
      return Boolean(modal?.querySelector('.artdeco-inline-feedback--error, [role="alert"]'));
    }, MODAL).catch(() => false);
    if (hasError) return 'validation-error';
  }
  return 'too-many-steps';
}

export async function prepare(page, job) {
  await openJob(page, job);
  const flow = await openEasyApply(page);
  if (flow !== 'form') return { external: true };

  const allFields = [];
  const outcome = await walkSteps(page, async () => {
    const fields = await page.evaluate(harvestFieldsInPage, MODAL).catch(() => []);
    allFields.push(...fields);
  });

  // Whatever happened, the draft must be discarded — prepare never submits.
  await discardDraft(page);

  if (outcome === 'too-many-steps') return { unsupported: `Mehr als ${MAX_STEPS} Schritte` };
  if (outcome === 'stuck' && allFields.length === 0) return { unsupported: 'Wizard-Navigation nicht gefunden' };
  if (allFields.some(f => f.kind === 'file' && f.required && !f.answered)) {
    return { unsupported: 'Zusätzlicher Datei-Upload erforderlich' };
  }

  // validation-error during prepare is fine — it just means required fields
  // exist on a later step we couldn't reach; the harvested ones are what count.
  const questions = fieldsToQuestions(dedupeFields(allFields));
  log(`prepare "${job.title}": ${questions.length} offene Frage(n) im Easy-Apply-Wizard.`);
  return { questions };
}

function dedupeFields(fields) {
  const seen = new Set();
  return fields.filter(f => {
    if (seen.has(f.label)) return false;
    seen.add(f.label);
    return true;
  });
}

export async function submit(page, application, job, { questions, dryRun, screenshot }) {
  await openJob(page, job);
  const flow = await openEasyApply(page);
  if (flow !== 'form') return { ok: false, error: 'Easy-Apply-Dialog nicht erreichbar' };

  const outcome = await walkSteps(page, async () => {
    await fillAnswers(page, questions, MODAL);
  });

  if (outcome !== 'submit-step') {
    if (screenshot) await screenshot(`submit-blocked-${outcome}`);
    await discardDraft(page);
    return { ok: false, error: `Wizard nicht bis zum Absenden durchlaufen (${outcome})` };
  }

  // Some review steps still allow filling (e.g. follow-company checkbox stays as is).
  await humanDelay(1000, 2000);
  if (dryRun) {
    if (screenshot) await screenshot('dry-run-review');
    await discardDraft(page);
    return { ok: true, dryRun: true };
  }

  const clicked = await clickButtonByText(page, SUBMIT_BUTTON, MODAL);
  if (!clicked) {
    await discardDraft(page);
    return { ok: false, error: 'Senden-Button nicht gefunden' };
  }
  await humanDelay(2000, 3500);

  const confirmation = await page.evaluate(() => {
    const t = document.body.innerText || '';
    const m = t.match(/(bewerbung (wurde )?ge?sende?t|application (was )?sent|deine bewerbung wurde .*? gesendet)[^\n]*/i);
    return m ? m[0].trim() : null;
  }).catch(() => null);
  if (screenshot) await screenshot(confirmation ? 'submitted' : 'submit-unconfirmed');

  // clicked:true = the real send button WAS pressed; the worker must block retries.
  if (!confirmation) return { ok: false, clicked: true, error: 'Keine Sende-Bestätigung gefunden — Bewerbung wurde evtl. trotzdem gesendet, bitte auf der Plattform prüfen.' };
  return { ok: true, confirmation };
}
