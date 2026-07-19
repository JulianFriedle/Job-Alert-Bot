// Authenticated Playwright contexts for the job-board platforms.
//
// Strategy: a persisted storageState per (client, platform) is tried first —
// LinkedIn/Indeed challenge fresh logins aggressively, so a real login should
// be a rare event. Only when the saved session is missing/expired does the
// auto-login with the stored (encrypted) credentials run. Challenges (2FA,
// CAPTCHA, checkpoint pages) are never solved automatically: the login state
// flips to 'challenge' and the caller alerts the user instead.
//
// Only the scheduler process calls this module, so session files never race.
import { mkdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { newHardenedContext, humanType, humanDelay } from './scrapers/browser.js';
import { getPlatformCredentials } from './credentials.js';
import { setLoginState } from './database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(__dirname, '..', 'data', 'sessions');

function log(msg) {
  console.log(`[${new Date().toISOString()}] [platform-login] ${msg}`);
}

export class MissingCredentialsError extends Error {
  constructor(platform) {
    super(`Keine Zugangsdaten für ${platform} hinterlegt.`);
    this.code = 'missing_credentials';
  }
}

export class LoginChallengeError extends Error {
  constructor(platform, detail) {
    super(`Login bei ${platform} erfordert manuelle Bestätigung (${detail}). ` +
          `Tipp: einmalig mit APPLY_HEADFUL=true starten und den Login im Fenster abschließen.`);
    this.code = 'login_challenge';
  }
}

export class InvalidCredentialsError extends Error {
  constructor(platform, detail) {
    super(`Login bei ${platform} abgelehnt: ${detail}. Bitte E-Mail und Passwort prüfen.`);
    this.code = 'invalid_credentials';
  }
}

export function sessionPath(clientId, platform) {
  return path.join(SESSIONS_DIR, clientId, `${platform}.json`);
}

// ── Per-platform flows ───────────────────────────────────────────────────────
// probe(page)  → true when the saved session is still logged in
// login(page, creds) → 'ok' | 'challenge:<detail>'

const FLOWS = {
  linkedin: {
    async probe(page) {
      await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      return !/\/(login|authwall|checkpoint|uas\/login)/.test(page.url());
    },
    async login(page, creds) {
      await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await humanDelay(1000, 2000);
      await humanType(page.locator('#username'), creds.email);
      await humanDelay(400, 900);
      await humanType(page.locator('#password'), creds.password);
      await humanDelay(400, 900);
      await page.click('button[type="submit"]');
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      const url = page.url();
      if (/\/checkpoint\/|\/challenge/.test(url)) return 'challenge:LinkedIn Checkpoint (PIN/2FA)';
      if (/\/login/.test(url)) return 'challenge:Login abgelehnt (Passwort prüfen)';
      return 'ok';
    },
  },

  stepstone: {
    async probe(page) {
      await page.goto('https://www.stepstone.de/candidate/profile', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      return !/login|auth/.test(page.url());
    },
    async login(page, creds) {
      await page.goto('https://www.stepstone.de/candidate/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await humanDelay(1000, 2000);
      // Cookie banner first — it overlays the form (Usercentrics / one-trust).
      await page.evaluate(() => {
        document.querySelector('#ccmgt_explicit_accept')?.click();
        document.querySelector('[data-testid="uc-accept-all-button"]')?.click();
      }).catch(() => {});
      await humanDelay(500, 1000);
      // type="email"/type="password" uniquely target the login form; the page's
      // job-search bar only has type="text" inputs.
      const email = page.locator('input[type="email"], input[name="email"]').first();
      await humanType(email, creds.email);
      await humanDelay(400, 900);
      const pw = page.locator('input[type="password"], input[name="password"]').first();
      await humanType(pw, creds.password);
      await humanDelay(400, 900);
      // IMPORTANT: the page has multiple submit buttons (the job-search bar's
      // "Jobs finden" comes first) — click the login button by its label, not
      // the first submit. Fall back to pressing Enter in the password field.
      const loginBtn = page.getByRole('button', { name: 'Einloggen', exact: true });
      if (await loginBtn.count().catch(() => 0)) await loginBtn.first().click();
      else await pw.press('Enter');
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      await humanDelay(1500, 2500);
      const hasCaptcha = await page.locator('iframe[src*="geetest"], iframe[src*="captcha"], .geetest_holder').count().catch(() => 0);
      if (hasCaptcha > 0) return 'challenge:StepStone CAPTCHA';
      // Still on the login page → look for an inline credential error to
      // distinguish a wrong password from other blockers.
      if (/\/(candidate\/)?login/.test(page.url())) {
        const err = await page.evaluate(() => {
          const t = document.body.innerText || '';
          return /(falsch|ungültig|incorrect|nicht korrekt|stimmen nicht|passwort|e-?mail)[^\n]{0,80}(falsch|ungültig|incorrect|erneut|not match|wrong)/i.test(t);
        }).catch(() => false);
        return err ? 'invalid:E-Mail oder Passwort falsch' : 'challenge:Login nicht abgeschlossen (evtl. Bestätigung/Bot-Check)';
      }
      return 'ok';
    },
  },

  indeed: {
    async probe(page) {
      await page.goto('https://myaccount.indeed.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      return !/secure\.indeed\.com\/auth|\/account\/login/.test(page.url());
    },
    async login(page, creds) {
      // Indeed is two-step (email → password) and frequently forces an email
      // OTP for new devices — that is reported as a challenge, not retried.
      await page.goto('https://secure.indeed.com/auth?hl=de_DE', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await humanDelay(1000, 2000);
      const email = page.locator('input[type="email"], #ifl-InputFormField-3, input[name="__email"]').first();
      await humanType(email, creds.email);
      await humanDelay(400, 900);
      await page.locator('button[type="submit"]').first().click();
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      const pw = page.locator('input[type="password"], input[name="__password"]').first();
      if (await pw.count() === 0) return 'challenge:Indeed verlangt E-Mail-Code/2FA';
      await humanType(pw, creds.password);
      await humanDelay(400, 900);
      await page.locator('button[type="submit"]').first().click();
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      const url = page.url();
      const otp = await page.locator('input[name*="otp" i], input[autocomplete="one-time-code"]').count().catch(() => 0);
      if (otp > 0) return 'challenge:Indeed E-Mail-Code (OTP)';
      if (/secure\.indeed\.com\/auth/.test(url)) return 'challenge:Login abgelehnt (Passwort prüfen)';
      return 'ok';
    },
  },
};

// Resolve a logged-in context for (client, platform). Reuses the persisted
// session when still valid, otherwise runs the auto-login and persists the
// fresh session. Throws MissingCredentialsError / LoginChallengeError.
export async function getAuthenticatedContext(browser, clientId, platform) {
  const flow = FLOWS[platform];
  if (!flow) throw new Error(`Unbekannte Plattform: ${platform}`);

  const statePath = sessionPath(clientId, platform);

  // 1. Saved session
  if (existsSync(statePath)) {
    const context = await newHardenedContext(browser, { storageState: statePath });
    const page = await context.newPage();
    try {
      if (await flow.probe(page)) {
        log(`${platform}/${clientId}: gespeicherte Session gültig.`);
        await page.close();
        return context;
      }
      log(`${platform}/${clientId}: Session abgelaufen — neuer Login nötig.`);
    } catch (err) {
      log(`${platform}/${clientId}: Session-Probe fehlgeschlagen (${err.message}) — neuer Login.`);
    }
    await context.close();
  }

  // 2. Auto-login with stored credentials
  const creds = getPlatformCredentials(clientId, platform);
  if (!creds) throw new MissingCredentialsError(platform);

  const context = await newHardenedContext(browser);
  const page = await context.newPage();
  try {
    const result = await flow.login(page, creds);
    if (result !== 'ok') {
      const sep = result.indexOf(':');
      const kind = sep === -1 ? 'challenge' : result.slice(0, sep);
      const detail = sep === -1 ? result : result.slice(sep + 1);
      if (kind === 'invalid') {
        setLoginState(clientId, platform, 'invalid');
        throw new InvalidCredentialsError(platform, detail);
      }
      setLoginState(clientId, platform, 'challenge');
      throw new LoginChallengeError(platform, detail);
    }
    mkdirSync(path.dirname(statePath), { recursive: true });
    await context.storageState({ path: statePath });
    setLoginState(clientId, platform, 'ok', { touchLogin: true });
    log(`${platform}/${clientId}: Login erfolgreich, Session gespeichert.`);
    await page.close();
    return context;
  } catch (err) {
    await context.close();
    if (!(err instanceof LoginChallengeError)) setLoginState(clientId, platform, 'invalid');
    throw err;
  }
}
