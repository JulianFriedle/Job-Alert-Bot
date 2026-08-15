// LinkedIn scraper — uses the PUBLIC guest job search (no login, no account
// risk). Page 1 is the normal guest search page; further pages come from the
// guest pagination endpoint (jobs-guest/jobs/api/seeMoreJobPostings), which
// returns HTML fragments of 25 result cards each.
//
// The guest search does NOT expose whether a job is Easy Apply, so easyApply
// stays null (unknown) — the apply worker verifies it during prepare.
import { generateId } from '../scraper.js';
import { launchPlatformBrowser, newHardenedContext, humanDelay, isChallengePage } from './browser.js';
import { isAborted } from '../run-control.js';

const PAGE_SIZE = 25;
const MAX_RESULTS_DEFAULT = 100;
const MAX_RESULTS_CAP = 200; // stay well under LinkedIn's guest rate limits

function log(msg) {
  console.log(`[${new Date().toISOString()}] [linkedin] ${msg}`);
}

function buildSearchParams(search) {
  const params = new URLSearchParams();
  params.set('keywords', search.keywords || '');
  if (search.location) params.set('location', search.location);
  // LinkedIn's `distance` parameter is in MILES.
  if (search.radiusKm) params.set('distance', String(Math.max(1, Math.round(search.radiusKm / 1.609))));
  if (search.postedWithinDays) params.set('f_TPR', `r${search.postedWithinDays * 24 * 3600}`);
  return params;
}

// Extract the numeric posting id and build a canonical URL — guest hrefs carry
// slug + tracking params that would break dedup across runs.
export function canonicalJobUrl(href) {
  try {
    const u = new URL(href);
    const m = u.pathname.match(/\/jobs\/view\/(?:[^/]*?-)?(\d{6,})\/?$/) || u.pathname.match(/(\d{6,})/);
    if (m) return `https://www.linkedin.com/jobs/view/${m[1]}`;
  } catch { /* fall through */ }
  return href.split('?')[0];
}

// Runs inside the browser: parse guest result cards from the current document
// (works for both the full search page and the seeMoreJobPostings fragments).
function parseCardsInPage() {
  const cards = document.querySelectorAll('.base-card, .job-search-card, li');
  const out = [];
  const seen = new Set();
  for (const card of cards) {
    const link = card.querySelector('a.base-card__full-link, a[href*="/jobs/view/"]');
    if (!link || !link.href || seen.has(link.href)) continue;
    const title = (card.querySelector('.base-search-card__title, h3')?.textContent || '')
      .replace(/\s+/g, ' ').trim();
    if (!title) continue;
    const company = (card.querySelector('.base-search-card__subtitle a, .base-search-card__subtitle, h4')?.textContent || '')
      .replace(/\s+/g, ' ').trim();
    const location = (card.querySelector('.job-search-card__location')?.textContent || '')
      .replace(/\s+/g, ' ').trim();
    seen.add(link.href);
    out.push({ href: link.href, title, company, location });
  }
  return out;
}

export async function scrape(source) {
  const search = source.search || {};
  if (!search.keywords) {
    log(`${source.name}: search.keywords fehlt — übersprungen.`);
    return { jobs: [], duplicates: 0, siteTotal: null };
  }
  const maxResults = Math.min(search.maxResults || MAX_RESULTS_DEFAULT, MAX_RESULTS_CAP);
  const params = buildSearchParams(search);

  const jobs = [];
  const seenUrls = new Set();
  let duplicates = 0;
  let siteTotal = null;

  const addCards = (cards) => {
    let added = 0;
    for (const c of cards) {
      const url = canonicalJobUrl(c.href);
      if (seenUrls.has(url)) { duplicates++; continue; }
      seenUrls.add(url);
      jobs.push({
        id: generateId(url, c.title, c.company),
        title: c.title,
        url,
        location: c.location,
        company: c.company,
        description: '',
        source: source.name,
        platform: 'linkedin',
        easyApply: null, // guest search doesn't expose it; verified at prepare time
      });
      added++;
    }
    return added;
  };

  const browser = await launchPlatformBrowser({ headless: true });
  try {
    const context = await newHardenedContext(browser);
    const page = await context.newPage();

    // Page 1: the regular guest search page (also yields the announced total).
    const searchUrl = `https://www.linkedin.com/jobs/search?${params.toString()}`;
    log(`${source.name}: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    const authwalled = /authwall|\/login|checkpoint/.test(page.url());
    if (!authwalled) {
      if (await isChallengePage(page)) {
        log(`${source.name}: BLOCKED (challenge page) — 0 Jobs.`);
        return { jobs: [], duplicates: 0, siteTotal: null };
      }
      siteTotal = await page.evaluate(() => {
        const el = document.querySelector('.results-context-header__job-count');
        const n = parseInt((el?.textContent || '').replace(/[^\d]/g, ''), 10);
        return Number.isFinite(n) ? n : null;
      }).catch(() => null);
      const first = await page.evaluate(parseCardsInPage);
      const added = addCards(first);
      log(`  Seite 1: ${added} Job(s)${siteTotal ? `, ${siteTotal} laut Website` : ''}`);
    } else {
      log(`  Suchseite hinter Authwall — weiche auf Guest-API aus.`);
    }

    // Remaining pages via the guest pagination endpoint. Navigating to it
    // directly renders the returned <li> fragment as a document we can parse
    // with the same card logic.
    const startFrom = authwalled ? 0 : PAGE_SIZE;
    for (let start = startFrom; jobs.length < maxResults; start += PAGE_SIZE) {
      if (isAborted()) { log('  Abbruch angefordert — stoppe Paginierung.'); break; }
      await humanDelay(2000, 5000);
      const apiUrl = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${params.toString()}&start=${start}`;
      try {
        const res = await page.goto(apiUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (res && res.status() === 429) { log(`  Guest-API rate-limited (429) — stoppe.`); break; }
        if (await isChallengePage(page)) { log(`  BLOCKED (challenge) — stoppe.`); break; }
        const cards = await page.evaluate(parseCardsInPage);
        if (cards.length === 0) { log(`  start=${start}: leer — Ende der Ergebnisse.`); break; }
        const added = addCards(cards);
        log(`  start=${start}: +${added} neu (${jobs.length} gesamt)`);
        if (added === 0) break; // only repeats → done
      } catch (err) {
        // On abort the browser is already gone — expected, not a scrape failure.
        log(isAborted() ? `  start=${start}: abgebrochen` : `  start=${start}: ERROR — ${err.message}`);
        break;
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  log(`Fertig ${source.name}: ${jobs.length} Job(s)${siteTotal ? ` (Website: ${siteTotal})` : ''}`);
  return { jobs: jobs.slice(0, maxResults), duplicates, siteTotal };
}
