// ── HTML → PDF via Playwright's Chromium ─────────────────────────────────────
// The CSS templates carry their own `@page` rules (A4, margins), so Chromium is
// told to honour them. One short-lived browser per render keeps the GUI process
// free of a long-running Chromium; a render takes about a second.
//
// The HTML is model-written (and the model reads scraped job ads), so it is
// treated as hostile: JavaScript is off and every request except inline data:
// URLs is blocked. Otherwise an injected <img src> could carry CV contents to
// any host, and a <script> could call this app's own API on localhost.

import { chromium } from 'playwright';

// CHROME_PATH points at a Chrome/Chromium binary when Playwright's own browser
// download is not available (e.g. a local install without `npx playwright install`).
export async function renderPdf(html) {
  const executablePath = process.env.CHROME_PATH || undefined;
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false });
    // Everything (CSS, images) is inline, so nothing needs the network.
    await context.route('**/*', (route) => (
      route.request().url().startsWith('data:') ? route.continue() : route.abort()
    ));
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    return await page.pdf({ preferCSSPageSize: true, printBackground: true });
  } finally {
    await browser.close().catch(() => {});
  }
}
