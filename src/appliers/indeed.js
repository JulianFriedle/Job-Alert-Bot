// Indeed-Apply applier ("Einfach bewerben" on de.indeed.com). The flow runs on
// smartapply.indeed.com as a multi-step wizard, sometimes in a new tab.
// Cloudflare protects both sides — challenges abort the attempt cleanly.
import { existsSync } from 'fs';
import { humanDelay, isChallengePage } from '../scrapers/browser.js';
import { harvestFieldsInPage, fieldsToQuestions, fillAnswers, clickButtonByText } from './common.js';

const MAX_STEPS = 8;
const NEXT_BUTTON   = ['weiter', 'continue', 'überprüfen', 'review your application'];
const SUBMIT_BUTTON = ['bewerbung absenden', 'submit your application', 'bewerbung senden'];

function log(msg) {
  console.log(`[${new Date().toISOString()}] [applier:indeed] ${msg}`);
}

// Open the job page and click the Indeed-Apply button; resolves with the page
// the wizard lives on (same tab or popup).
async function openApplyFlow(page, job) {
  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
  if (await isChallengePage(page)) return { status: 'challenge' };
  await humanDelay(1500, 3000);

  const hasIndeedApply = await page.evaluate(() => {
    const btn = document.querySelector('#indeedApplyButton, [id*="indeedApplyButton"], button[data-testid="indeedApplyButton"]');
    if (btn && btn.offsetParent !== null) { btn.click(); return true; }
    return false;
  }).catch(() => false);
  if (!hasIndeedApply) return { status: 'external' };

  // The wizard may open as a popup — adopt it when it does.
  const popup = await page.context().waitForEvent('page', { timeout: 8000 }).catch(() => null);
  const wizardPage = popup || page;
  await wizardPage.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
  await wizardPage.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
  if (await isChallengePage(wizardPage)) return { status: 'challenge' };
  await humanDelay(1500, 2500);
  return { status: 'form', wizardPage };
}

async function hasSubmit(page) {
  return page.evaluate(() => {
    return [...document.querySelectorAll('button')].some(b =>
      b.offsetParent !== null &&
      /bewerbung (ab)?senden|submit your application/i.test((b.textContent || '')));
  }).catch(() => false);
}

async function walkSteps(page, onStep) {
  for (let step = 0; step < MAX_STEPS; step++) {
    await humanDelay(1000, 2000);
    if (await isChallengePage(page)) return 'challenge';
    await onStep(step);
    if (await hasSubmit(page)) return 'submit-step';
    const clicked = await clickButtonByText(page, NEXT_BUTTON);
    if (!clicked) return 'stuck';
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
  }
  return 'too-many-steps';
}

export async function prepare(page, job) {
  const flow = await openApplyFlow(page, job);
  if (flow.status === 'external') return { external: true };
  if (flow.status === 'challenge') return { unsupported: 'Cloudflare-Challenge' };
  const wizard = flow.wizardPage;

  const allFields = [];
  const outcome = await walkSteps(wizard, async () => {
    const fields = await wizard.evaluate(harvestFieldsInPage, null).catch(() => []);
    allFields.push(...fields);
  });

  // Nothing was submitted — closing the wizard abandons the draft.
  if (wizard !== page) await wizard.close().catch(() => {});

  if (outcome === 'challenge') return { unsupported: 'Cloudflare-Challenge im Bewerbungs-Wizard' };
  if (outcome === 'too-many-steps') return { unsupported: `Mehr als ${MAX_STEPS} Schritte` };

  const seen = new Set();
  const questions = fieldsToQuestions(allFields.filter(f => !seen.has(f.label) && seen.add(f.label)));
  log(`prepare "${job.title}": ${questions.length} offene Frage(n).`);
  return { questions };
}

export async function submit(page, application, job, { questions, cvPath, dryRun, screenshot }) {
  const flow = await openApplyFlow(page, job);
  if (flow.status !== 'form') return { ok: false, error: `Bewerbungs-Wizard nicht erreichbar (${flow.status})` };
  const wizard = flow.wizardPage;

  const outcome = await walkSteps(wizard, async () => {
    await fillAnswers(wizard, questions);
    // CV step: upload only when an empty file input blocks progress.
    if (cvPath && existsSync(cvPath)) {
      const needsUpload = await wizard.evaluate(() =>
        Boolean([...document.querySelectorAll('input[type="file"]')].find(i => !i.files?.length && i.offsetParent !== null))
      ).catch(() => false);
      if (needsUpload) {
        await wizard.setInputFiles('input[type="file"]', cvPath).catch(err => log(`CV-Upload: ${err.message}`));
        await humanDelay(1500, 3000);
      }
    }
  });

  if (outcome !== 'submit-step') {
    if (screenshot) await screenshot(`submit-blocked-${outcome}`, wizard);
    if (wizard !== page) await wizard.close().catch(() => {});
    return { ok: false, error: `Wizard nicht bis zum Absenden durchlaufen (${outcome})` };
  }

  await humanDelay(1000, 2000);
  if (dryRun) {
    if (screenshot) await screenshot('dry-run-review', wizard);
    if (wizard !== page) await wizard.close().catch(() => {});
    return { ok: true, dryRun: true };
  }

  const clicked = await clickButtonByText(wizard, SUBMIT_BUTTON);
  if (!clicked) {
    if (wizard !== page) await wizard.close().catch(() => {});
    return { ok: false, error: 'Absenden-Button nicht gefunden' };
  }
  await wizard.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await humanDelay(2000, 3000);

  const confirmation = await wizard.evaluate(() => {
    const t = document.body.innerText || '';
    const m = t.match(/(bewerbung (wurde )?(erfolgreich )?(ab)?ge?sende?t|application submitted|deine bewerbung wurde übermittelt)[^\n]*/i);
    return m ? m[0].trim() : null;
  }).catch(() => null);
  if (screenshot) await screenshot(confirmation ? 'submitted' : 'submit-unconfirmed', wizard);
  if (wizard !== page) await wizard.close().catch(() => {});

  if (!confirmation) return { ok: false, error: 'Keine Sende-Bestätigung gefunden' };
  return { ok: true, confirmation };
}
