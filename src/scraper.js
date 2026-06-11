import 'dotenv/config';
import { chromium } from 'playwright';
import crypto from 'crypto';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function log(msg) {
  console.log(`[${new Date().toISOString()}] [scraper] ${msg}`);
}

function generateId(url, title = '', company = '') {
  const raw = url || `${title}-${company}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

const JOB_LINK_SELECTOR =
  'a[href*="/job/"], a[href*="/jobs/"], a[href*="/career/"], ' +
  'a[href*="/careers/"], a[href*="/position/"], a[href*="/vacancy/"], ' +
  'a[href*="/stellenangebote/"], a[href*="/stellen/"]';

async function extractJobsAndPagination(page, source = {}) {
  const currentUrl = page.url();

  const jobs = await page.evaluate(({ currentUrl, allowExternalLinks, jobUrlPattern }) => {
    const results = [];
    const seen = new Set();
    const currentPathname = new URL(currentUrl).pathname;

    const candidateSelectors = [
      'a[href*="/job/"]',
      'a[href*="/jobs/"]',
      'a[href*="/career/"]',
      'a[href*="/careers/"]',
      'a[href*="/position/"]',
      'a[href*="/vacancy/"]',
      'a[href*="/stellenangebote/"]',
      'a[href*="/stellen/"]',
      'a[href*="/stelle/"]',
      'a[href*="/anzeige/"]',
      'a[href*="/jobangebot"]',
      'a[href*="/jobangebote"]',
      'a[href*="/arbeitsangebote"]',
      'a[href*="ac=jobad"]',
      'a[href*="/jobboerse/"]',
      'a[href*="/requisition/"]',
      'a[href*="/opening/"]',
      '[class*="job"] a',
      '[class*="career"] a',
      '[class*="position"] a',
      '[class*="vacancy"] a',
      '[data-job-id] a',
      'li.job a',
      'article a',
      '.job-listing a',
      '.job-item a',
      '.job-card a',
    ];

    // Process a single anchor candidate; pushes a job into `results` if it qualifies.
    const processEl = (el) => {
      const href = el.href;
      if (!href || seen.has(href)) return;
      if (/^(#|javascript:|mailto:|tel:)/i.test(href)) return;

      // Skip fragment links that stay on the same page (sort/filter buttons)
      // Allow cross-domain links if their path looks like a job detail page
      // (e.g. personio.de, greenhouse.io embedded in a company careers page)
      try {
        const u = new URL(href);
        if (u.hash && u.pathname === currentPathname) return;
        if (!allowExternalLinks) {
          const currentRoot = new URL(currentUrl).hostname.split('.').slice(-2).join('.');
          const linkRoot = u.hostname.split('.').slice(-2).join('.');
          const isJobDetailPath =
            /\/jobs?\//i.test(u.pathname) || /\/career\//i.test(u.pathname) ||
            /\/stelle/i.test(u.pathname) || /\/vacanc/i.test(u.pathname) ||
            /\/position/i.test(u.pathname) || /\/requisition/i.test(u.pathname);
          if (linkRoot !== currentRoot && !isJobDetailPath) return;
        }
      } catch (_) {}

      // Skip navigation chrome (language switchers, footers, etc.)
      if (el.closest(
        'nav, header, footer, [role="navigation"], ' +
        '[class*="language"], [class*="lang-switch"], [class*="locale"], select'
      )) return;

      let title = (
        el.textContent?.trim() ||
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        ''
      ).replace(/\s+/g, ' ').trim();

      // Overlay-link pattern: transparent anchor with no text (e.g. Rosswag).
      // The real title is in a heading within the surrounding card.
      if (!title || title.split(/\s+/).length < 2) {
        const card2 = el.closest('li, article, [class*="job"], [class*="career"], [class*="position"]') || el.parentElement;
        const heading = card2?.querySelector('h1, h2, h3, h4, h5, h6, [class*="title"], [class*="heading"]');
        if (heading) title = heading.textContent?.replace(/\s+/g, ' ').trim() || '';
      }

      // Require at least 2 words to filter column headers like "Standort"
      if (!title || title.split(/\s+/).length < 2) return;

      const card = el.closest(
        '[class*="job"], [class*="career"], [class*="position"], li, article'
      ) || el.parentElement;
      const cardText = card?.textContent?.replace(/\s+/g, ' ').trim() || '';

      const locationMatch = cardText.match(/(?:📍|location|standort|ort)[:\s]+([^\n|•·]+)/i);
      const location = locationMatch?.[1]?.trim() || '';

      const companyEl = card?.querySelector('[class*="company"], [class*="employer"], [class*="firm"]');
      const company = companyEl?.textContent?.trim() || '';

      const dateEl = card?.querySelector('time, [class*="date"], [class*="posted"]');
      const postedDate = dateEl?.getAttribute('datetime') || dateEl?.textContent?.trim() || '';

      seen.add(href);
      results.push({ title, url: href, location, company, postedDate, description: '' });
    };

    for (const selector of candidateSelectors) {
      try {
        for (const el of document.querySelectorAll(selector)) processEl(el);
      } catch (_) {}
    }

    // Config-driven fallback: match job links whose href fits a site-specific regex
    // (sites whose detail URLs match none of the default selectors, e.g. Stellenwerk: /stuttgart/<slug>-<date>-<id>)
    if (jobUrlPattern) {
      try {
        const re = new RegExp(jobUrlPattern);
        for (const el of document.querySelectorAll('a[href]')) {
          if (re.test(el.href)) processEl(el);
        }
      } catch (_) {}
    }

    return results;
  }, { currentUrl, allowExternalLinks: !!source.allowExternalLinks, jobUrlPattern: source.jobUrlPattern || null });

  const paginationUrls = await page.evaluate((currentUrl) => {
    const seen = new Set([currentUrl]);
    const links = [];

    // Pass 1: known pagination container selectors
    const containerEls = document.querySelectorAll(
      '[class*="pagination"] a, [class*="pager"] a, ' +
      '[aria-label*="paginat" i] a, [class*="page-nav"] a, ' +
      '[class*="pagenav"] a, ul.pages a, .pages a, ' +
      '[class*="page-link"] a, [class*="pageLink"] a, ' +
      '[class*="page-numbers"] a, [class*="pageNumbers"] a'
    );
    for (const el of containerEls) {
      const href = el.href;
      if (!href || seen.has(href) || /^(#|javascript:)/i.test(href)) continue;
      seen.add(href);
      links.push(href);
    }

    // Pass 2: fallback — any link with a numeric page/offset query param
    if (links.length === 0) {
      for (const el of document.querySelectorAll('a[href]')) {
        const href = el.href;
        if (!href || seen.has(href) || /^(#|javascript:)/i.test(href)) continue;
        if (href.split('#')[0] === currentUrl.split('#')[0]) continue; // same page, different fragment
        if (/[?&](page|pg|p|startrow|start|offset|from|searchpage)=\d+/i.test(href)) {
          seen.add(href);
          links.push(href);
        }
      }
    }

    return links;
  }, currentUrl);

  return { jobs, paginationUrls };
}

// Try to click a "Load more" / "Mehr laden" button. Returns true if a button was found and clicked.
// Uses direct JS element.click() to bypass any overlay that intercepts pointer events.
async function clickLoadMore(page) {
  const cssCandidates = [
    '[class*="load-more"]', '[class*="loadMore"]', '[class*="load_more"]',
    '[class*="show-more"]', '[class*="showMore"]',
    '[class*="more-jobs"]', '[class*="moreJobs"]',
    '[class*="dvinci-pagination"]', // dVinci ATS "Weitere" button (e.g. KIT)
  ];
  const textPatterns = [
    'mehr laden', 'mehr anzeigen', 'weitere stellen', 'weitere jobs',
    'mehr jobs', 'alle anzeigen', 'load more', 'show more', 'more jobs',
    'weitere ergebnisse', 'more results',
  ];

  return await page.evaluate(({ cssCandidates, textPatterns }) => {
    // CSS-class candidates
    for (const sel of cssCandidates) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) { el.click(); return true; }
    }
    // Text-based candidates
    const interactive = [...document.querySelectorAll('button, a, [role="button"]')];
    for (const pattern of textPatterns) {
      const re = new RegExp(pattern, 'i');
      const el = interactive.find(b => re.test((b.textContent || '').trim()));
      if (el && el.offsetParent !== null) { el.click(); return true; }
    }
    return false;
  }, { cssCandidates, textPatterns }).catch(() => false);
}

// Dismiss cookie consent banners / overlays that block clicks.
// Tries a polite "accept all" click first; falls back to removing the element from the DOM.
async function dismissOverlays(page) {
  const originalUrl = page.url();

  // Polite: click the accept button using direct JS click (bypasses shadow DOM / overlay issues)
  const acceptTexts = [
    'alle cookies akzeptieren', 'accept all cookies',
    'alle akzeptieren', 'alles akzeptieren', 'accept all',
    'zustimmen', 'akzeptieren', 'agree', 'accept', 'ok',
  ];
  const clicked = await page.evaluate((texts) => {
    const btns = [...document.querySelectorAll('button, [role="button"]')];
    for (const text of texts) {
      const re = new RegExp(`^${text}$`, 'i');
      const btn = btns.find(b => re.test((b.textContent || '').trim()));
      if (btn) { btn.click(); return text; }
    }
    return null;
  }, acceptTexts).catch(() => null);
  if (clicked) {
    await page.waitForTimeout(800);
    // Some sites (iCIMS, j2w) redirect away from the filtered URL after accepting cookies.
    // The consent is now stored in localStorage, so re-navigating back loads content without the banner.
    if (page.url() !== originalUrl) {
      await page.goto(originalUrl, { waitUntil: 'commit', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }
    return;
  }

  // Nuclear: remove known overlay containers directly from the DOM
  await page.evaluate(() => {
    const targets = [
      '#usercentrics-cmp-ui',
      '#cookiebanner', '#cookie-banner', '#cookie-consent', '#CybotCookiebotDialog',
      '[id*="usercentrics"]', '[id*="cookie-consent"]', '[id*="cookiebot"]',
      '[class*="cookie-banner"]', '[class*="consent-banner"]', '[class*="gdpr-banner"]',
      'dock-privacy-settings', 'uc-layer2', 'uc-layer1', 'uc-banner',
    ];
    for (const sel of targets) {
      document.querySelectorAll(sel).forEach(el => el.remove());
    }
  }).catch(() => {});

  // Permanently neutralise overlays that JS may re-inject after DOM removal
  await page.addStyleTag({
    content:
      'dock-privacy-settings, uc-layer2, uc-layer1, uc-banner ' +
      '{ display: none !important; pointer-events: none !important; }',
  }).catch(() => {});
}

// Click the "→ next page" button in a pagination nav.
// Works for SPAs where pagination uses onClick instead of real hrefs.
// Returns 'clicked' | 'disabled' | 'not_found'
async function clickNextButton(page) {
  await dismissOverlays(page);

  const result = await page.evaluate(() => {
    const isDisabled = e =>
      e.getAttribute('aria-disabled') === 'true' || e.hasAttribute('disabled') ||
      e.classList.contains('disabled') || e.classList.contains('inactive');

    // 1. Explicit rel/aria-label selectors
    for (const sel of [
      'a[rel="next"]',
      '[aria-label*="next page" i]',
      '[aria-label*="nächste seite" i]',
      '[aria-label*="next" i]:not(nav)',
    ]) {
      const el = document.querySelector(sel);
      if (!el || el.offsetParent === null) continue;
      if (isDisabled(el)) return 'disabled';
      el.click(); return 'clicked';
    }

    // 2. Text-based: "Nächste Seite", "Next", "Weiter", etc.
    const nextTexts = ['nächste seite', 'next page', 'nächste', 'next', 'weiter'];
    const interactive = [...document.querySelectorAll('a, button, [role="button"]')];
    for (const text of nextTexts) {
      const re = new RegExp(`^${text}$`, 'i');
      const el = interactive.find(e => re.test((e.textContent || '').trim()) && e.offsetParent !== null);
      if (!el) continue;
      if (isDisabled(el)) return 'disabled';
      el.click(); return 'clicked';
    }

    // 3. Last item in any pagination container
    for (const sel of [
      'nav[aria-label*="paginat" i]', 'ul.pagination',
      '[class*="pagination"]:not(a):not(li)', '[class*="pager"]:not(a):not(li)',
      '[class*="Paginator"]:not(a):not(li)',
    ]) {
      const container = document.querySelector(sel);
      if (!container || container.offsetParent === null) continue;
      const items = [...container.querySelectorAll('a, button')];
      if (items.length === 0) continue;
      const last = items[items.length - 1];
      if (isDisabled(last)) return 'disabled';
      last.click(); return 'clicked';
    }

    // 4. Icon-only chevron-right button (e.g. Stellenwerk — SVG with no text label)
    for (const svgSel of [
      'svg.lucide-chevron-right', 'svg[class*="chevron-right"]', 'svg[class*="ChevronRight"]',
      'svg path[d*="m9 18 6-6-6"]',
    ]) {
      const svgEl = document.querySelector(svgSel);
      if (!svgEl) continue;
      const btn = svgEl.closest('button, a, [role="button"]');
      if (!btn || btn.offsetParent === null) continue;
      if (isDisabled(btn)) return 'disabled';
      btn.click(); return 'clicked';
    }

    return 'not_found';
  }).catch(() => 'not_found');

  return result;
}

// Wait until at least one job-like link is visible in the DOM, up to 8 s.
// Handles JS-rendered pages (Porsche, Mahle) where networkidle fires before
// the job cards are painted.
async function waitForFirstJob(page) {
  await page.waitForSelector(
    'a[href*="/job/"], a[href*="/jobs/"], a[href*="/career/"], a[href*="/careers/"], ' +
    'a[href*="ac=jobad"], a[href*="/stellenangebote/"], a[href*="/stellen/"], a[href*="/jobboerse/"]',
    { timeout: 8000 }
  ).catch(() => {});
}

// Dump page structure for debugging — shown when pagination detection fails
async function debugPageStructure(page) {
  const info = await page.evaluate(() => {
    const navs = [...document.querySelectorAll('nav, [role="navigation"]')].map(n => ({
      ariaLabel: n.getAttribute('aria-label') || '',
      links: n.querySelectorAll('a').length,
      buttons: n.querySelectorAll('button').length,
    }));
    const sampleJobLinks = [...document.querySelectorAll('a[href]')]
      .filter(a => /job|career|stell|vacan|posit/i.test(a.href) && a.textContent?.trim().length > 3)
      .slice(0, 4)
      .map(a => `[${a.textContent?.trim().slice(0, 40)}] → ${a.href.slice(0, 90)}`);
    return { navs, sampleJobLinks };
  });
  log(`  DEBUG navs: ${JSON.stringify(info.navs)}`);
  if (info.sampleJobLinks.length) log(`  DEBUG job link samples: ${info.sampleJobLinks.join(' | ')}`);
}

// Read total job count from page text ("310 Stellen", "von 310", "310 Ergebnisse", etc.)
async function extractTotalCount(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText || '';
    const patterns = [
      /\b(\d{2,})\s+(?:Stellen?|Jobs?|Ergebnisse|Results?|Treffer|Positionen?|Vacancies?)\b/i,
      /(?:von|of)\s+(\d{2,})\b/i,
      /(\d{2,})\s+(?:offene|open|aktuelle)\s+(?:Stellen?|Jobs?)/i,
      /(\d{2,})\s+(?:Stellenangebote|Jobangebote)/i,
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  }).catch(() => null);
}

// Extract jobs from a plain JSON API response — captures any SPA that fires XHR/fetch with job arrays.
function extractJobsFromJson(json, sourceUrl, sourceName, jobsMap) {
  const candidates = [
    json.jobs, json.results, json.hits, json.items,
    json.positions, json.vacancies, json.postings, json.records,
    json.offers, json.listings, json.jobPostings, json.jobList,
    json.data?.jobs, json.data?.results, json.data?.items,
  ].filter(v => Array.isArray(v) && v.length > 0);

  // Some APIs nest the job payload one level down under `data` (e.g. Bosch: { data: { title, applicationUrl, … } }).
  const fields = (item) => (item && typeof item.data === 'object' && item.data) ? item.data : item;

  for (const list of candidates) {
    const first = fields(list[0]);
    if (!(first?.title || first?.jobTitle || first?.requisitionTitle || first?.name || first?.headline)) continue;

    let added = 0;
    for (const raw of list) {
      const item = fields(raw);
      const title = (item.title || item.jobTitle || item.requisitionTitle || item.name || item.headline || '')
        .replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      if (!title || title.split(/\s+/).length < 2) continue;

      const rawUrl = item.url || item.link || item.applyUrl || item.applicationUrl || item.jobUrl ||
                     item.detailUrl || item.canonicalUrl || item.permalink || item.href;
      if (!rawUrl) continue;

      let fullUrl;
      try { fullUrl = String(rawUrl).startsWith('http') ? String(rawUrl) : new URL(String(rawUrl), sourceUrl).href; }
      catch (_) { continue; }

      if (jobsMap.has(fullUrl)) continue;

      const locRaw = item.location || item.city || item.cityState || item.locationName || item.place || '';
      const location = Array.isArray(locRaw) ? locRaw.join(', ') : String(locRaw || '');

      jobsMap.set(fullUrl, { title, url: fullUrl, location, company: sourceName, description: '' });
      added++;
    }
    if (added > 0) return added;
    break;
  }

  // SAP SuccessFactors (jobs.sick.com, jobs.bbraun.com – response has jobSearchResult array)
  if (Array.isArray(json.jobSearchResult) && json.jobSearchResult.length > 0) {
    const sample = json.jobSearchResult[0]?.response ?? json.jobSearchResult[0];
    if (sample?.unifiedStandardTitle || sample?.urlTitle) {
      const origin = (() => { try { return new URL(sourceUrl).origin; } catch (_) { return ''; } })();
      let added = 0;
      for (const raw of json.jobSearchResult) {
        const r = raw.response ?? raw;
        const title = (r.unifiedStandardTitle || r.title || '').replace(/\s+/g, ' ').trim();
        if (!title || title.split(/\s+/).length < 2) continue;
        const urlTitle = r.urlTitle || r.unifiedUrlTitle || '';
        if (!urlTitle) continue;
        const id = r.id ?? '';
        const locale = Array.isArray(r.supportedLocales) ? r.supportedLocales[0] : '';
        const brandUrl = r.brandUrl || '';
        const suffix = id ? (locale ? `${id}-${locale}` : String(id)) : '';
        const fullUrl = brandUrl
          ? `${origin}/${brandUrl}/job/${urlTitle}/${suffix}`
          : `${origin}/job/${urlTitle}/${suffix}`;
        if (jobsMap.has(fullUrl)) continue;
        const locRaw = Array.isArray(r.jobLocationShort) ? r.jobLocationShort[0] : (r.jobLocationShort || '');
        const location = String(locRaw).replace(/,\s*[A-Z]{2,3},?\s*\d*\s*$/, '').trim();
        jobsMap.set(fullUrl, { title, url: fullUrl, location, company: sourceName, description: '' });
        added++;
      }
      if (added > 0) return added;
    }
  }

  // GraphQL: { data: { <queryName>: { jobs: [...], totalPages, ... } } } (e.g. Zeiss xSBUSearchJobs)
  if (json.data && typeof json.data === 'object' && !Array.isArray(json.data)) {
    for (const nested of Object.values(json.data)) {
      if (!nested || typeof nested !== 'object' || !Array.isArray(nested.jobs) || nested.jobs.length === 0) continue;
      const first = nested.jobs[0];
      if (!(first.title || first.jobTitle)) continue;
      let added = 0;
      for (const item of nested.jobs) {
        const title = (item.title || item.jobTitle || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
        if (!title || title.split(/\s+/).length < 2) continue;
        const rawUrl = item.externalApplyURL || item.url || item.link || item.jobUrl || item.applyUrl || item.href;
        if (!rawUrl) continue;
        let fullUrl;
        try { fullUrl = String(rawUrl).startsWith('http') ? String(rawUrl) : new URL(String(rawUrl), sourceUrl).href; }
        catch (_) { continue; }
        if (jobsMap.has(fullUrl)) continue;
        const location = [item.primaryLocation, item.locationCountry].filter(Boolean).join(', ');
        jobsMap.set(fullUrl, { title, url: fullUrl, location, company: sourceName, description: '' });
        added++;
      }
      if (added > 0) return added;
    }
  }

  return 0;
}

// When a site only renders a few page links (e.g. 1, 2, 3, …, 35), infer the full range.
function inferAllPages(paginationUrls) {
  if (paginationUrls.length < 2) return paginationUrls;

  const paramRegex = /([?&])(page|pg|p|startrow|start|offset|from|searchpage)=(\d+)/i;
  const parsed = paginationUrls.map(url => {
    const m = url.match(paramRegex);
    return m ? { url, sep: m[1], param: m[2], num: parseInt(m[3]) } : null;
  }).filter(Boolean);

  if (parsed.length === 0) return paginationUrls;

  // Use the most common param name
  const counts = {};
  for (const { param } of parsed) counts[param.toLowerCase()] = (counts[param.toLowerCase()] || 0) + 1;
  const dominantParam = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const relevant = parsed.filter(p => p.param.toLowerCase() === dominantParam);

  const nums = relevant.map(p => p.num);
  const minNum = Math.min(...nums);
  const maxNum = Math.max(...nums);

  // Detect step from GCD of consecutive differences (e.g. startrow=25,50,75 → step=25).
  // Without this, offset-based pagination like Fraunhofer (startrow) would generate every
  // integer between min and max, causing hundreds of duplicate page visits.
  const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
  const sortedNums = [...new Set(nums)].sort((a, b) => a - b);
  let step = 1;
  if (sortedNums.length >= 2) {
    const diffs = sortedNums.slice(1).map((v, i) => v - sortedNums[i]);
    step = Math.max(1, diffs.reduce(gcd));
  }

  const numPages = Math.ceil((maxNum - minNum) / step) + 1;
  if (numPages > 200) return paginationUrls; // safety limit

  const template = relevant[0].url;
  const pattern = new RegExp(`([?&]${relevant[0].param}=)\\d+`, 'i');
  const seen = new Set(paginationUrls);
  const expanded = [...paginationUrls];

  for (let p = minNum; p <= maxNum; p += step) {
    const newUrl = template.replace(pattern, `$1${p}`);
    if (!seen.has(newUrl)) {
      seen.add(newUrl);
      expanded.push(newUrl);
    }
  }

  return expanded;
}

async function scrapeSource(source) {
  log(`Starting scrape: ${source.name}`);

  const allJobs = [];
  const visitedUrls = new Set();
  const seenJobUrls = new Set();
  let duplicateCount = 0;
  let siteTotal = null; // job entries skipped because their URL was already seen this run

  // countDupes=false for infinite-scroll/load-more, where each extraction re-reads the
  // full visible list and the "duplicates" are expected re-reads, not real duplicate postings.
  const addJobs = (jobs, countDupes = true) => {
    let added = 0;
    for (const job of jobs) {
      if (!seenJobUrls.has(job.url)) {
        seenJobUrls.add(job.url);
        allJobs.push({ ...job, id: generateId(job.url, job.title, job.company), source: source.name });
        added++;
      }
    }
    if (countDupes) duplicateCount += jobs.length - added;
    return added;
  };

  // Single browser + single page — looks like one human browsing, avoids rate-limiting
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'de-DE',
    });
    const page = await context.newPage();

    // ── Azure Cognitive Search API interception (Schaeffler / j2w pattern) ────
    // Some SPAs gate DOM rendering behind cookie consent but fire the jobs API
    // immediately on load. We capture those responses to extract jobs without
    // needing to resolve the cookie banner.
    const apiJobsMap = new Map(); // applyUrl → job object
    let apiTotalCount = 0;
    page.on('response', async (res) => {
      if (!res.url().includes('search.windows.net')) return;
      try {
        const json = await res.json();
        if (!Array.isArray(json.value)) return;
        const hasJobs = json.value.some(item => item.applyUrl);
        // Only count from calls that return actual job items (not the facets-only call)
        if (hasJobs && json['@odata.count'] != null) apiTotalCount = json['@odata.count'];
        for (const item of json.value) {
          const id = item.applyUrl;
          if (!id || apiJobsMap.has(String(id))) continue;
          const locale = item.defaultLanguage || 'de_DE';
          const origin = new URL(source.url).origin;
          const jobUrl = `${origin}/JobDescription/?jobId=${id}&locale=${locale}`;
          const title = (item.title || item.jobTitle || '').replace(/<[^>]*>/g, '').trim();
          const location = [item.city, item.country].filter(Boolean).join(', ');
          if (title) apiJobsMap.set(String(id), { title, url: jobUrl, location, company: source.name, description: '' });
        }
      } catch (_) {}
    });

    // ── General JSON API interceptor (Bosch, DLR, and similar React SPAs) ────
    // Captures job arrays from any XHR/fetch response — complements Azure interceptor.
    const generalApiJobs = new Map();
    let apiQuery = null; // { url, totalHits, perPage } — for deterministic page-by-page replay (Bosch)
    let apiPaginationMeta = null; // { totalPages, pageSize } — fallback for Strategy 0 when DOM count absent
    page.on('response', async (res) => {
      if (res.url().includes('search.windows.net')) return; // already handled above
      const rt = res.request().resourceType();
      if (rt !== 'xhr' && rt !== 'fetch') return;
      const ct = res.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      // Skip "show everything" calls with an empty filter object ({}), which SPAs like Bosch fire on
      // initial load before applying the URL's filter. Capturing them pollutes results with off-criteria jobs.
      if (/[?&]filter=(%257B%257D|%7B%7D|%257B%2520%257D|%7B%20%7D|\{\})/i.test(res.url())) return;
      try {
        const json = await res.json();
        const added = extractJobsFromJson(json, source.url, source.name, generalApiJobs);
        if (added > 0) log(`  API-intercept (general): +${added} from ${res.url().slice(0, 80)}`);
        // Remember the paginated query so we can replay remaining pages deterministically
        if (typeof json?.totalHits === 'number' && Array.isArray(json?.jobs) && /[?&]page=\d+/.test(res.url())) {
          apiQuery = { url: res.url(), totalHits: json.totalHits, perPage: json.jobsPerPage || json.jobs.length || 20 };
        }
        // Capture pagination metadata for Strategy 0 fallback (when DOM has no count text)
        if (!apiPaginationMeta) {
          if (typeof json.totalPages === 'number' && json.totalPages > 1) {
            // Standard REST with totalPages (e.g. Zeiss GraphQL outer response)
            apiPaginationMeta = { totalPages: json.totalPages, pageSize: json.pageSize || json.jobs?.length || 20, totalJobs: json.totalJobs };
          } else if (typeof json.totalJobs === 'number' && json.totalJobs > 0 && Array.isArray(json.jobSearchResult)) {
            // SAP SuccessFactors: { totalJobs, jobSearchResult: [...] }
            const pgSize = json.jobSearchResult.length || 10;
            apiPaginationMeta = { totalPages: Math.ceil(json.totalJobs / pgSize), pageSize: pgSize, totalJobs: json.totalJobs };
          } else if (json.data && typeof json.data === 'object') {
            // GraphQL: data.<queryName>.{ totalPages, pageSize } (e.g. Zeiss xSBUSearchJobs)
            for (const v of Object.values(json.data)) {
              if (v && typeof v.totalPages === 'number' && v.totalPages > 1) {
                apiPaginationMeta = { totalPages: v.totalPages, pageSize: v.pageSize || 20, totalJobs: v.totalJobs };
                break;
              }
            }
          }
        }
      } catch (_) {}
    });

    // ── Page 1 ───────────────────────────────────────────────────────────────
    visitedUrls.add(source.url);
    // Some sites (e.g. Rheinmetall) block domcontentloaded indefinitely via consent scripts.
    // Fall back to 'commit' (first bytes received) so the goto never hangs.
    try {
      await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      if (e.message.includes('Timeout')) {
        log(`  domcontentloaded timed out — retrying with commit`);
        await page.goto(source.url, { waitUntil: 'commit', timeout: 15000 });
        await page.waitForTimeout(4000); // give JS time to render content
      } else {
        throw e;
      }
    }
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
    await dismissOverlays(page);
    // After cookie accept the page may reload — wait for that to settle before reading DOM
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await waitForFirstJob(page);
    if (source.extraWait) await page.waitForTimeout(source.extraWait);

    const { jobs: firstPageJobs, paginationUrls } = await extractJobsAndPagination(page, source);
    // apiOnly sources (e.g. Bosch) carry job data only in their JSON API; their DOM links use
    // different URLs than the API, so adding both would double-count. Skip DOM, trust the API.
    if (!source.apiOnly) addJobs(firstPageJobs);

    // Merge general API-intercepted jobs
    if (generalApiJobs.size > 0) {
      const genAdded = addJobs([...generalApiJobs.values()]);
      log(`  General API: ${generalApiJobs.size} intercepted (${genAdded} new)`);
    }

    // ── API replay: deterministically fetch remaining pages of a paginated JSON API (e.g. Bosch) ──
    // More reliable than clicking a flaky "load more" button — we replay the captured query URL
    // with an incrementing page param until totalHits is reached.
    if (source.apiOnly && apiQuery) {
      const pages = Math.ceil(apiQuery.totalHits / apiQuery.perPage);
      log(`  API replay: ${apiQuery.totalHits} total, ${apiQuery.perPage}/page → ${pages} page(s)`);
      for (let pg = 1; pg < Math.min(pages, 40); pg++) {
        const pageUrl = apiQuery.url.replace(/([?&]page=)\d+/, `$1${pg}`);
        try {
          const json = await page.evaluate(async (u) => {
            const r = await fetch(u, { credentials: 'include' });
            return r.ok ? await r.json() : null;
          }, pageUrl);
          if (!json) { log(`  API replay page ${pg}: fetch failed — stopping`); break; }
          extractJobsFromJson(json, source.url, source.name, generalApiJobs);
          // countDupes=false: re-reading the cumulative map isn't a real duplicate signal
          const added = addJobs([...generalApiJobs.values()], false);
          log(`  API replay page ${pg}: +${added} new (${allJobs.length} total)`);
          await page.waitForTimeout(400);
        } catch (err) { log(`  API replay page ${pg}: ERROR — ${err.message}`); break; }
      }
    }

    // Merge Azure Search API-intercepted jobs (e.g. Schaeffler)
    if (apiJobsMap.size > 0) {
      const apiAdded = addJobs([...apiJobsMap.values()]);
      log(`  Azure API-intercepted ${apiJobsMap.size} job(s) (${apiAdded} new)`);

      // If the source URL has a currentPage param, paginate by URL to capture remaining API pages
      const srcUrl = new URL(source.url);
      if (srcUrl.searchParams.has('currentPage') && srcUrl.searchParams.has('pageSize')) {
        const pageSize = parseInt(srcUrl.searchParams.get('pageSize') || '30', 10);
        const totalPages = Math.ceil(apiTotalCount / pageSize);
        for (let pg = 2; pg <= Math.min(totalPages, 20); pg++) {
          srcUrl.searchParams.set('currentPage', String(pg));
          const pgUrl = srcUrl.toString();
          if (visitedUrls.has(pgUrl)) continue;
          visitedUrls.add(pgUrl);
          const prevSize = apiJobsMap.size;
          await page.waitForTimeout(1500);
          await page.goto(pgUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
          await page.waitForTimeout(1500);
          if (apiJobsMap.size > prevSize) {
            const pgAdded = addJobs([...apiJobsMap.values()]);
            log(`  Azure API page ${pg}: ${apiJobsMap.size - prevSize} new job(s) (${pgAdded} added)`);
          } else {
            log(`  Azure API page ${pg}: no new jobs — stopping`);
            break;
          }
        }
      }
    }

    // Read the total job count shown on the website (e.g. "67 Ergebnisse") for verification.
    siteTotal = (await extractTotalCount(page)) ??
      (apiPaginationMeta ? (apiPaginationMeta.totalJobs || null) : null);

    log(`  Page 1: ${firstPageJobs.length} DOM job(s) found, ${paginationUrls.length} pagination link(s) detected${siteTotal ? `, ${siteTotal} announced on site` : ''}`);

    // ── Strategy 0: config-driven offset pagination ───────────────────────────
    // Used for sites where we know the pagination param (e.g. DLR, Zeiss, Sick).
    // Takes priority over href-based detection — Strategy A and B/C are skipped when this is active.
    if (source.paginationParam) {
      const step = source.paginationStep || firstPageJobs.length || apiPaginationMeta?.pageSize || 25;
      const totalCount = siteTotal ??
        (apiPaginationMeta ? (apiPaginationMeta.totalJobs || apiPaginationMeta.totalPages * (apiPaginationMeta.pageSize || step)) : null);
      if (totalCount && totalCount > allJobs.length) {
        const numPages = Math.ceil(totalCount / step);
        log(`  Config-driven pagination: ${totalCount} total, step=${step}, pages=${numPages}`);
        for (let pg = 1; pg < Math.min(numPages + 1, 50); pg++) {
          const pgUrl = new URL(source.url);
          // 'index' mode: param is a 0-based page index (page,1,2,…). Default 'offset' mode: param is a row offset (step,2·step,…).
          const value = source.paginationMode === 'index' ? pg : pg * step;
          pgUrl.searchParams.set(source.paginationParam, String(value));
          const pgStr = pgUrl.toString();
          if (!visitedUrls.has(pgStr)) {
            visitedUrls.add(pgStr);
            await page.waitForTimeout(1500);
            try {
              await page.goto(pgStr, { waitUntil: 'domcontentloaded', timeout: 30000 });
              await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
              await waitForFirstJob(page);
              const { jobs: pgJobs } = await extractJobsAndPagination(page, source);
              let pgAdded = addJobs(pgJobs);
              if (generalApiJobs.size > 0) pgAdded += addJobs([...generalApiJobs.values()], false);
              log(`  Config-page ${pg + 1}: ${pgJobs.length} found, ${pgAdded} new`);
              if (pgAdded === 0 && pg > 1) { log(`  Config-page: no new jobs — stopping`); break; }
            } catch (err) {
              log(`  Config-page ${pg + 1}: ERROR — ${err.message}`);
            }
          }
        }
      } else {
        log(`  Config-driven pagination: could not read total count from page — skipping`);
      }
    }

    // ── Strategy A: numbered pagination (href-based) ─────────────────────────
    if (paginationUrls.length > 0 && !source.paginationParam) {
      const allPaginationUrls = inferAllPages(paginationUrls);
      if (allPaginationUrls.length > paginationUrls.length) {
        log(`  Inferred ${allPaginationUrls.length - paginationUrls.length} additional page(s) (total ${allPaginationUrls.length})`);
      }
      allPaginationUrls.forEach((u, i) => log(`    [pagLink ${i + 1}] ${u}`));

      const remainingPages = allPaginationUrls.filter(u => !visitedUrls.has(u));
      log(`  Visiting ${remainingPages.length} more page(s)...`);

      for (let i = 0; i < remainingPages.length; i++) {
        const pageUrl = remainingPages[i];
        if (visitedUrls.has(pageUrl)) continue;
        visitedUrls.add(pageUrl);

        await page.waitForTimeout(2000);
        try {
          await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
          await waitForFirstJob(page);

          const { jobs: pageJobs } = await extractJobsAndPagination(page, source);
          let added = addJobs(pageJobs);
          if (generalApiJobs.size > 0) added += addJobs([...generalApiJobs.values()], false);
          log(`  Page ${i + 2}: ${pageJobs.length} job(s) found, ${added} new`);
        } catch (err) {
          log(`  Page ${i + 2}: ERROR — ${err.message}`);
        }
      }

    // ── Strategy B: "Load more" button (infinite scroll) ────────────────────
    // Skipped for apiOnly sources and for config-driven pagination (Strategy 0).
    } else if (!source.apiOnly && !source.paginationParam) {
      log(`  No href-based pagination — trying load-more / next-button...`);
      let anyStrategyWorked = false;
      let consecutiveZeros = 0;
      const MAX_ACTIONS = 100;

      for (let action = 1; action <= MAX_ACTIONS; action++) {
        // Try load-more first (infinite scroll), then next-button (paginated SPA)
        const loadMoreClicked = await clickLoadMore(page);

        if (loadMoreClicked) {
          anyStrategyWorked = true;
          await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
          await page.waitForTimeout(800);
          const { jobs: visible } = await extractJobsAndPagination(page, source);
          let added = source.apiOnly ? 0 : addJobs(visible, false);
          // Also merge jobs from API responses fired by the click (e.g. Bosch /api/filter/query?page=N).
          // Re-reading the cumulative maps is cheap — addJobs dedupes, so only genuinely new postings count.
          if (generalApiJobs.size > 0) added += addJobs([...generalApiJobs.values()], false);
          if (apiJobsMap.size > 0)     added += addJobs([...apiJobsMap.values()], false);
          log(`  Load-more ${action}: +${added} new (${allJobs.length} total)`);
          if (added === 0) { consecutiveZeros++; if (consecutiveZeros >= 2) { log(`  Load-more: end of results`); break; } }
          else { consecutiveZeros = 0; }

        } else {
          // Strategy C: click the "→" in a pagination nav (Rheinmetall-style)
          const result = await clickNextButton(page);

          if (result === 'not_found') {
            if (!anyStrategyWorked && allJobs.length === 0) {
              // Nothing worked and no jobs found — dump debug info so the user can report it
              await debugPageStructure(page);
            }
            if (!anyStrategyWorked) log(`  No further pagination detected — single page result.`);
            break;
          }

          if (result === 'disabled') {
            log(`  Next button is disabled — reached last page`);
            break;
          }

          // result === 'clicked'
          anyStrategyWorked = true;
          await page.waitForTimeout(2500);
          // Wait for the SPA's API call to finish before extracting.
          // networkidle fires when no fetch/XHR requests are in flight for 500ms.
          await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
          await waitForFirstJob(page);

          const { jobs: pageJobs } = await extractJobsAndPagination(page, source);
          let added = addJobs(pageJobs);
          if (generalApiJobs.size > 0) added += addJobs([...generalApiJobs.values()], false);
          log(`  Next-click ${action}: +${added} new (${allJobs.length} total)`);

          if (added === 0) {
            consecutiveZeros = (consecutiveZeros ?? 0) + 1;
            if (consecutiveZeros >= 2) {
              log(`  Next-click: ${consecutiveZeros} pages with no new jobs — reached last page`);
              break;
            }
            log(`  Next-click: +0 this page — retrying once more`);
          } else {
            consecutiveZeros = 0;
          }
        }
      }
    }

  } finally {
    await browser.close();
  }

  log(`Finished ${source.name}: ${allJobs.length} unique job(s)${duplicateCount > 0 ? `, ${duplicateCount} duplicate(s) skipped` : ''}${siteTotal ? ` (site announced ${siteTotal})` : ''}`);
  return { jobs: allJobs, duplicates: duplicateCount, siteTotal: siteTotal ?? null };
}

// Fetch full job descriptions for an array of jobs (in-place, mutates description field).
// Called after deduplication so we only visit detail pages for genuinely new jobs.
export async function fetchDescriptions(jobs, concurrency = Number(process.env.SCRAPE_CONCURRENCY) || 4) {
  if (jobs.length === 0) return;
  log(`Fetching descriptions for ${jobs.length} new job(s) with concurrency=${concurrency}...`);

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'de-DE',
    });

    let idx = 0;
    async function worker() {
      while (idx < jobs.length) {
        const i = idx++;
        const job = jobs[i];
        const page = await context.newPage();
        try {
          await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
          await page.waitForTimeout(600);

          const description = await page.evaluate(() => {
            const selectors = [
              '[class*="job-description"]', '[class*="jobDescription"]',
              '[class*="job-detail"]',      '[class*="jobDetail"]',
              '[class*="vacancy-body"]',    '[class*="position-description"]',
              '[class*="job-content"]',     '[class*="jobContent"]',
              '[class*="job-body"]',        '[class*="requisition"]',
              'article', 'main',
            ];
            for (const sel of selectors) {
              const el = document.querySelector(sel);
              if (!el) continue;
              const clone = el.cloneNode(true);
              for (const tag of clone.querySelectorAll(
                'nav, header, footer, script, style, noscript, ' +
                '[class*="apply"], [class*="share"], [class*="social"], ' +
                'button, iframe, [aria-hidden="true"]'
              )) tag.remove();
              const text = clone.textContent?.replace(/\s+/g, ' ').trim();
              if (text && text.length > 150) return text;
            }
            return document.body.textContent?.replace(/\s+/g, ' ').trim() || '';
          });

          job.description = description.slice(0, 4000);
          log(`  [${i + 1}/${jobs.length}] ${job.title} (${job.description.length} chars)`);
        } catch (err) {
          log(`  [${i + 1}/${jobs.length}] Failed for "${job.title}": ${err.message}`);
        } finally {
          await page.close();
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  } finally {
    await browser.close();
  }
}

export async function scrapeAll(sources, concurrency = Number(process.env.SCRAPE_CONCURRENCY) || 4) {
  const allJobs = [];
  const stats = {};
  let idx = 0;

  log(`Scraping ${sources.length} source(s) with concurrency=${concurrency}...`);

  async function worker() {
    while (idx < sources.length) {
      const source = sources[idx++];
      try {
        const { jobs, duplicates, siteTotal } = await scrapeSource(source);
        allJobs.push(...jobs);
        stats[source.name] = {
          duplicates: (stats[source.name]?.duplicates || 0) + duplicates,
          siteTotal: siteTotal ?? stats[source.name]?.siteTotal ?? null,
        };
      } catch (err) {
        log(`ERROR scraping ${source.name}: ${err.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, sources.length) }, worker));
  log(`Scrape complete: ${allJobs.length} total unique job(s) from ${sources.length} source(s)`);
  return { jobs: allJobs, stats };
}

// Allow direct execution: npm run test-scraper
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const configPath = path.join(__dirname, '..', 'config', 'jobs.json');
  const { sources } = JSON.parse(await readFile(configPath, 'utf-8'));
  const { jobs } = await scrapeAll(sources);
  console.log(JSON.stringify(jobs.map(j => ({ title: j.title, source: j.source })), null, 2));
}
