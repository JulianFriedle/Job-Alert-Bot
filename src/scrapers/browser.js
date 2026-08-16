// Shared hardened Playwright setup for the job-board platforms (LinkedIn,
// StepStone, Indeed) — used by both the read-only scrapers and the appliers.
// These sites fingerprint headless browsers far more aggressively than the
// company career pages the generic scraper visits, so the context here hides
// the obvious automation signals and every interaction is paced human-like.
import { chromium } from 'playwright';

function log(msg) {
  console.log(`[${new Date().toISOString()}] [platform-browser] ${msg}`);
}

// Single constant to bump when the UA grows stale.
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const LAUNCH_ARGS = ['--disable-blink-features=AutomationControlled'];

// Prefer the real Chrome channel when installed — Cloudflare (Indeed) scores
// stock headless Chromium much worse. Falls back to bundled Chromium.
export async function launchPlatformBrowser({ headless } = {}) {
  const wantHeadless = headless ?? !isTruthy(process.env.APPLY_HEADFUL);
  try {
    return await chromium.launch({ channel: 'chrome', headless: wantHeadless, args: LAUNCH_ARGS });
  } catch {
    log('Chrome channel not available — using bundled Chromium.');
    return chromium.launch({ headless: wantHeadless, args: LAUNCH_ARGS });
  }
}

export function isTruthy(v) {
  return ['true', '1', 'on', 'yes'].includes(String(v || '').trim().toLowerCase());
}

// Context with a plausible desktop fingerprint. `storageState` (path or object)
// restores a persisted login session when given.
export async function newHardenedContext(browser, { storageState } = {}) {
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1440, height: 900 },
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    ...(storageState ? { storageState } : {}),
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['de-DE', 'de', 'en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  });
  return context;
}

export function jitter(min, max) {
  return Math.floor(min + Math.random() * (max - min));
}

export function humanDelay(min = 800, max = 2500) {
  return new Promise(resolve => setTimeout(resolve, jitter(min, max)));
}

// Type character-by-character with a variable per-key delay — a paste-speed
// fill into a login form is an instant bot signal. The delay must vary PER
// KEY: pressSequentially's `delay` option is one constant for the whole
// string, and a metronome-steady 73 ms is itself a fingerprint.
export async function humanType(locator, text) {
  await locator.click();
  await locator.fill('');
  for (const ch of String(text)) {
    await locator.pressSequentially(ch);
    await new Promise(resolve => setTimeout(resolve, jitter(40, 120)));
  }
}

// Heuristic Cloudflare/anti-bot challenge detection (Indeed, StepStone bursts).
export async function isChallengePage(page) {
  try {
    const title = await page.title();
    if (/just a moment|einen moment|verify you are|checking your browser|attention required/i.test(title)) return true;
    return await page.evaluate(() =>
      Boolean(document.querySelector('#challenge-running, #challenge-form, iframe[src*="turnstile"], iframe[src*="captcha"]'))
    );
  } catch {
    return false;
  }
}
