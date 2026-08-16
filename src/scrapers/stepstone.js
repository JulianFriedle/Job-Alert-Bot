// StepStone scraper — public search result pages, no login needed. Older
// result-card markup carried an "Einfach bewerben" badge (→ easyApply 1);
// current markup doesn't, so easyApply usually stays null (unknown) and the
// apply worker verifies it during prepare. Pagination via ?page=N.
import { generateId } from '../scraper.js';
import { launchPlatformBrowser, newHardenedContext, humanDelay, isChallengePage } from './browser.js';

const MAX_PAGES_DEFAULT = 5;
const MAX_PAGES_CAP = 15;

function log(msg) {
  console.log(`[${new Date().toISOString()}] [stepstone] ${msg}`);
}

function slugify(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function buildSearchUrl(search, pageNo) {
  const kw = slugify(search.keywords);
  const loc = slugify(search.location);
  let url = loc
    ? `https://www.stepstone.de/jobs/${kw}/in-${loc}`
    : `https://www.stepstone.de/jobs/${kw}`;
  const params = new URLSearchParams();
  if (search.radiusKm && loc) params.set('radius', String(search.radiusKm));
  if (pageNo > 1) params.set('page', String(pageNo));
  const q = params.toString();
  return q ? `${url}?${q}` : url;
}

// Listing URLs carry tracking query params; the numeric listing id in the path
// is stable, so stripping the query yields a canonical URL for dedup.
export function canonicalJobUrl(href) {
  try {
    const u = new URL(href);
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(href).split('?')[0];
  }
}

// Runs inside the browser: parse result cards. Selector variants cover the
// data-at / data-testid attribute generations StepStone has shipped.
function parseCardsInPage() {
  const cards = document.querySelectorAll(
    'article[data-at="job-item"], article[data-testid="job-item"], [data-at="job-item"]'
  );
  const out = [];
  for (const card of cards) {
    const link = card.querySelector(
      'a[data-at="job-item-title"], a[data-testid="job-item-title"], h2 a, a[href*="/stellenangebote--"]'
    );
    if (!link || !link.href) continue;
    const title = (link.textContent || '').replace(/\s+/g, ' ').trim();
    if (!title) continue;
    const company = (card.querySelector(
      '[data-at="job-item-company-name"], [data-testid="job-item-company-name"]'
    )?.textContent || '').replace(/\s+/g, ' ').trim();
    const location = (card.querySelector(
      '[data-at="job-item-location"], [data-testid="job-item-location"]'
    )?.textContent || '').replace(/\s+/g, ' ').trim();
    const easyApply = /einfach bewerben|easy apply/i.test(card.textContent || '');
    out.push({ href: link.href, title, company, location, easyApply });
  }
  return out;
}

async function acceptCookies(page) {
  await page.evaluate(() => {
    const byId = document.querySelector('#ccmgt_explicit_accept');
    if (byId) { byId.click(); return; }
    const btns = [...document.querySelectorAll('button')];
    const el = btns.find(b => /alle akzeptieren|accept all|zustimmen/i.test((b.textContent || '').trim()));
    if (el) el.click();
  }).catch(() => {});
  await page.waitForTimeout(800);
}

export async function scrape(source) {
  const search = source.search || {};
  if (!search.keywords) {
    log(`${source.name}: search.keywords fehlt — übersprungen.`);
    return { jobs: [], duplicates: 0, siteTotal: null };
  }
  const maxPages = Math.min(search.maxPages || MAX_PAGES_DEFAULT, MAX_PAGES_CAP);

  const jobs = [];
  const seenUrls = new Set();
  let duplicates = 0;
  let siteTotal = null;
  let blocked = false; // challenge/error → result is incomplete, not "0 jobs exist"

  const browser = await launchPlatformBrowser({ headless: true });
  try {
    const context = await newHardenedContext(browser);
    const page = await context.newPage();

    for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
      const url = buildSearchUrl(search, pageNo);
      if (pageNo > 1) await humanDelay(2000, 5000);
      log(`${source.name}: Seite ${pageNo} — ${url}`);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        if (pageNo === 1) await acceptCookies(page);
        if (await isChallengePage(page)) { log(`  BLOCKED (challenge/DataDome) — stoppe.`); blocked = true; break; }
        await page.waitForSelector('article[data-at="job-item"], [data-at="job-item"]', { timeout: 8000 }).catch(() => {});

        if (pageNo === 1) {
          siteTotal = await page.evaluate(() => {
            // Probe selectors in PRIORITY order — a comma list in querySelector
            // returns the first match in document order, so a generic h1 above
            // the dedicated count element would win and mask it.
            const candidates = ['[data-at="jobs-count"]', '[data-testid="jobs-count"]', 'h1']
              .map(sel => document.querySelector(sel)?.textContent || '');
            candidates.push(document.body.innerText || '');
            for (const text of candidates) {
              const m = text.match(/([\d.]{1,9})\s+(?:Jobs?|Treffer|Stellen)/i);
              if (!m) continue;
              const n = parseInt(m[1].replace(/\./g, ''), 10);
              if (Number.isFinite(n)) return n;
            }
            return null;
          }).catch(() => null);
        }

        const cards = await page.evaluate(parseCardsInPage);
        if (cards.length === 0) { log(`  Seite ${pageNo}: keine Treffer-Karten — Ende.`); break; }

        let added = 0;
        for (const c of cards) {
          const jobUrl = canonicalJobUrl(c.href);
          if (seenUrls.has(jobUrl)) { duplicates++; continue; }
          seenUrls.add(jobUrl);
          jobs.push({
            id: generateId(jobUrl, c.title, c.company),
            title: c.title,
            url: jobUrl,
            location: c.location,
            company: c.company,
            description: '',
            source: source.name,
            platform: 'stepstone',
            // Current StepStone result cards don't render the badge anymore —
            // badge present → certain, absent → unknown (prepare verifies).
            easyApply: c.easyApply ? 1 : null,
          });
          added++;
        }
        log(`  Seite ${pageNo}: ${cards.length} Karten, +${added} neu (${jobs.length} gesamt)`);
        if (added === 0 && pageNo > 1) break;
      } catch (err) {
        log(`  Seite ${pageNo}: ERROR — ${err.message}`);
        blocked = true;
        break;
      }
    }
  } finally {
    await browser.close();
  }

  log(`Fertig ${source.name}: ${jobs.length} Job(s)${siteTotal ? ` (Website: ${siteTotal})` : ''}${blocked ? ' [UNVOLLSTÄNDIG]' : ''}`);
  return { jobs, duplicates, siteTotal, blocked };
}
