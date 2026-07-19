// StepStone "Einfach bewerben" applier. The flow is a single-page form
// (name/email prefilled from the account, CV select/upload, optional message,
// occasional screening questions) — the least hostile of the three platforms,
// which is why it ships first.
//
// Contract (shared by all appliers):
//   prepare(page, job, ctx)  → { questions } | { external: true } | { unsupported: reason }
//   submit(page, application, job, ctx) → { ok, dryRun?, confirmation? }
// prepare NEVER submits anything; submit only clicks the final button when
// ctx.dryRun is false.
import { existsSync } from 'fs';
import { humanDelay } from '../scrapers/browser.js';
import { harvestFieldsInPage, fieldsToQuestions, fillAnswers, clickButtonByText } from './common.js';

const APPLY_BUTTON = [
  'einfach bewerben', 'jetzt bewerben', 'easy apply',
];
const SUBMIT_BUTTON = [
  'bewerbung (jetzt )?(ab)?senden', 'bewerbung abschicken', 'submit application', 'send application',
];

function log(msg) {
  console.log(`[${new Date().toISOString()}] [applier:stepstone] ${msg}`);
}

async function acceptCookies(page) {
  await page.evaluate(() => document.querySelector('#ccmgt_explicit_accept')?.click()).catch(() => {});
  await page.waitForTimeout(600);
}

// Open the job page and enter the apply flow. Resolves with 'form' when the
// application form is on screen, 'external' when the button leads off-site.
async function openApplyFlow(page, job) {
  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await acceptCookies(page);
  await humanDelay(1000, 2200);

  // An apply button that links to a foreign domain is a company-site redirect,
  // not "Einfach bewerben".
  const externalHref = await page.evaluate(() => {
    const btn = document.querySelector('a[data-at="apply-button"], a[data-testid="apply-button"]');
    if (btn && btn.href && !/stepstone\./.test(new URL(btn.href).hostname)) return btn.href;
    return null;
  }).catch(() => null);
  if (externalHref) return 'external';

  const clicked = await clickButtonByText(page, APPLY_BUTTON);
  if (!clicked) return 'no_button';
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await humanDelay(1500, 3000);

  // Landed on a company site instead of a StepStone apply form → external.
  if (!/stepstone\./.test(new URL(page.url()).hostname)) return 'external';
  return 'form';
}

export async function prepare(page, job) {
  const flow = await openApplyFlow(page, job);
  if (flow === 'external') return { external: true };
  if (flow === 'no_button') return { unsupported: 'Kein Bewerben-Button gefunden' };

  const fields = await page.evaluate(harvestFieldsInPage, null).catch(() => []);
  const questions = fieldsToQuestions(fields);
  log(`prepare "${job.title}": ${questions.length} offene Frage(n) im Formular.`);
  return { questions };
}

export async function submit(page, application, job, { questions, coverLetter, cvPath, dryRun, screenshot }) {
  const flow = await openApplyFlow(page, job);
  if (flow !== 'form') return { ok: false, error: `Bewerbungsformular nicht erreichbar (${flow})` };

  // Cover letter into the message/anschreiben textarea when present.
  if (coverLetter) {
    await page.evaluate((text) => {
      const ta = [...document.querySelectorAll('textarea')].find(t => {
        const l = ((t.getAttribute('aria-label') || '') + (t.closest('label')?.textContent || '') +
                   (t.id ? (document.querySelector(`label[for="${CSS.escape(t.id)}"]`)?.textContent || '') : '')).toLowerCase();
        return /anschreiben|nachricht|message|motivation/.test(l);
      }) || document.querySelector('textarea');
      if (!ta) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, text);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, coverLetter).catch(() => false);
    await humanDelay(500, 1200);
  }

  // CV: prefer the account's stored CV (usually preselected); upload the file
  // only when an empty file input demands one.
  if (cvPath && existsSync(cvPath)) {
    const needsUpload = await page.evaluate(() =>
      Boolean([...document.querySelectorAll('input[type="file"]')].find(i => !i.files?.length && i.offsetParent !== null))
    ).catch(() => false);
    if (needsUpload) {
      await page.setInputFiles('input[type="file"]', cvPath).catch(err => log(`CV-Upload fehlgeschlagen: ${err.message}`));
      await humanDelay(1500, 3000);
    }
  }

  const misses = await fillAnswers(page, questions);
  if (misses.length) log(`Nicht zuordenbare Felder: ${misses.join(' | ')}`);

  await humanDelay(800, 1500);
  if (dryRun) {
    if (screenshot) await screenshot('dry-run-review');
    return { ok: true, dryRun: true };
  }

  const clicked = await clickButtonByText(page, SUBMIT_BUTTON);
  if (!clicked) return { ok: false, error: 'Absenden-Button nicht gefunden' };
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await humanDelay(1500, 2500);

  const confirmation = await page.evaluate(() => {
    const t = document.body.innerText || '';
    const m = t.match(/(bewerbung (wurde |ist )?(erfolgreich )?(ab)?ge?sende?t|vielen dank für (deine|ihre) bewerbung)[^\n]*/i);
    return m ? m[0].trim() : null;
  }).catch(() => null);
  if (screenshot) await screenshot(confirmation ? 'submitted' : 'submit-unconfirmed');

  if (!confirmation) return { ok: false, error: 'Keine Bestätigung nach dem Absenden gefunden' };
  return { ok: true, confirmation };
}
