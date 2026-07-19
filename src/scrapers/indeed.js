// Indeed scraper — public search pages on de.indeed.com. Job data comes from
// the embedded mosaic-provider-jobcards JSON (far more robust than the DOM),
// including the `indeedApplyEnabled` flag → easyApply is known at scrape time.
// Indeed sits behind Cloudflare: challenges are detected and reported as a
// blocked (empty) result instead of throwing, so the run continues.
import { generateId } from '../scraper.js';
import { launchPlatformBrowser, newHardenedContext, humanDelay, isChallengePage } from './browser.js';

const PAGE_SIZE = 10; // Indeed's `start` param steps in 10s
const MAX_PAGES_DEFAULT = 5;
const MAX_PAGES_CAP = 10;

function log(msg) {
  console.log(`[${new Date().toISOString()}] [indeed] ${msg}`);
}

function buildSearchUrl(search, start) {
  const params = new URLSearchParams();
  params.set('q', search.keywords || '');
  if (search.location) params.set('l', search.location);
  if (search.radiusKm) params.set('radius', String(search.radiusKm));
  if (start > 0) params.set('start', String(start));
  return `https://de.indeed.com/jobs?${params.toString()}`;
}

export function canonicalJobUrl(jobkey) {
  return `https://de.indeed.com/viewjob?jk=${jobkey}`;
}

// Pull the result list out of the embedded mosaic provider data. Exported for
// unit tests (takes the raw window.mosaic-like object).
export function extractJobcards(mosaic) {
  const results =
    mosaic?.providerData?.['mosaic-provider-jobcards']?.metaData?.mosaicProviderJobCardsModel?.results;
  if (!Array.isArray(results)) return [];
  return results
    .filter(r => r && r.jobkey && (r.title || r.displayTitle))
    .map(r => ({
      jobkey: r.jobkey,
      title: String(r.displayTitle || r.title).replace(/\s+/g, ' ').trim(),
      company: String(r.company || r.truncatedCompany || '').replace(/\s+/g, ' ').trim(),
      location: String(r.formattedLocation || '').replace(/\s+/g, ' ').trim(),
      easyApply: Boolean(r.indeedApplyEnabled ?? r.indeedApplyable),
      snippet: String(r.snippet || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
    }));
}

// DOM fallback when the mosaic JSON shape changes.
function parseCardsInDom() {
  const out = [];
  for (const link of document.querySelectorAll('a.jcs-JobTitle, a[data-jk]')) {
    const jk = link.getAttribute('data-jk') || (link.href.match(/jk=([0-9a-f]+)/) || [])[1];
    if (!jk) continue;
    const card = link.closest('li, .job_seen_beacon, td') || link;
    const title = (link.textContent || '').replace(/\s+/g, ' ').trim();
    if (!title) continue;
    const company = (card.querySelector('[data-testid="company-name"]')?.textContent || '').trim();
    const location = (card.querySelector('[data-testid="text-location"]')?.textContent || '').trim();
    const easyApply = /einfach bewerben|easily apply/i.test(card.textContent || '');
    out.push({ jobkey: jk, title, company, location, easyApply, snippet: '' });
  }
  return out;
}

export async function scrape(source) {
  const search = source.search || {};
  if (!search.keywords) {
    log(`${source.name}: search.keywords fehlt — übersprungen.`);
    return { jobs: [], duplicates: 0, siteTotal: null };
  }
  const maxPages = Math.min(search.maxPages || MAX_PAGES_DEFAULT, MAX_PAGES_CAP);

  const jobs = [];
  const seenKeys = new Set();
  let duplicates = 0;
  let siteTotal = null;

  const browser = await launchPlatformBrowser({ headless: true });
  try {
    const context = await newHardenedContext(browser);
    const page = await context.newPage();

    for (let pageNo = 0; pageNo < maxPages; pageNo++) {
      const url = buildSearchUrl(search, pageNo * PAGE_SIZE);
      if (pageNo > 0) await humanDelay(2500, 6000);
      log(`${source.name}: Seite ${pageNo + 1} — ${url}`);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

        if (await isChallengePage(page)) {
          log(`  BLOCKED — Cloudflare-Challenge erkannt. Lauf wird übersprungen (kein CAPTCHA-Lösen).`);
          break;
        }

        let cards = await page.evaluate(() => {
          // eslint-disable-next-line no-undef
          return typeof window.mosaic === 'object' ? window.mosaic : null;
        }).then(m => extractJobcards(m)).catch(() => []);
        if (cards.length === 0) cards = await page.evaluate(parseCardsInDom).catch(() => []);
        if (cards.length === 0) { log(`  Seite ${pageNo + 1}: keine Jobcards — Ende.`); break; }

        if (pageNo === 0) {
          siteTotal = await page.evaluate(() => {
            const el = document.querySelector('.jobsearch-JobCountAndSortPane-jobCount, [data-testid="searchCount"]');
            const m = (el?.textContent || '').match(/([\d.]{1,9})/);
            return m ? parseInt(m[1].replace(/\./g, ''), 10) : null;
          }).catch(() => null);
        }

        let added = 0;
        for (const c of cards) {
          if (seenKeys.has(c.jobkey)) { duplicates++; continue; }
          seenKeys.add(c.jobkey);
          const jobUrl = canonicalJobUrl(c.jobkey);
          jobs.push({
            id: generateId(jobUrl, c.title, c.company),
            title: c.title,
            url: jobUrl,
            location: c.location,
            company: c.company,
            description: '', // detail page text is fetched later (fetchDescriptions)
            source: source.name,
            platform: 'indeed',
            easyApply: c.easyApply ? 1 : 0,
          });
          added++;
        }
        log(`  Seite ${pageNo + 1}: ${cards.length} Karten, +${added} neu (${jobs.length} gesamt)`);
        if (added === 0 && pageNo > 0) break;
      } catch (err) {
        log(`  Seite ${pageNo + 1}: ERROR — ${err.message}`);
        break;
      }
    }
  } finally {
    await browser.close();
  }

  log(`Fertig ${source.name}: ${jobs.length} Job(s)${siteTotal ? ` (Website: ${siteTotal})` : ''}`);
  return { jobs, duplicates, siteTotal };
}
