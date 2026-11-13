// ── HTML → PDF via Playwright's Chromium ─────────────────────────────────────
// The CSS templates carry their own `@page` rules (A4, margins), so Chromium is
// told to honour them. One short-lived browser per render keeps the GUI process
// free of a long-running Chromium; a render takes about a second.

import { chromium } from 'playwright';

// CHROME_PATH points at a Chrome/Chromium binary when Playwright's own browser
// download is not available (e.g. a local install without `npx playwright install`).
export async function renderPdf(html) {
  const executablePath = process.env.CHROME_PATH || undefined;
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    // Everything (CSS, images) is inline — no network needed.
    await page.setContent(html, { waitUntil: 'load' });
    return await page.pdf({ preferCSSPageSize: true, printBackground: true });
  } finally {
    await browser.close().catch(() => {});
  }
}
