// ── Personio: the public XML feed instead of the career page (#41) ───────────
// Every Personio career site (`<company>.jobs.personio.de` / `.com`) also
// publishes its open positions as XML at `/xml`, including the full job
// description. Reading that is one request instead of a browser session plus
// one detail page per job — and it works when the page itself times out
// (APworks hit "page.goto: Timeout 15000ms exceeded" on every run).
//
// The feed's job URLs (`/job/<id>`) need not match the links the page scraper
// collected, and a different URL means a different job id. Switching a source
// that already works to the feed would therefore report all its jobs as new
// (analysis cost) and the old ones as expired. So the feed is used only when
// asked for (`personioFeed: true`) or as a fallback when the page fails or
// yields nothing — see scrapeCareerSource in src/scraper.js.
import { decodeEntities } from './indeed.js';

export function isPersonioUrl(url) {
  try { return /(^|\.)jobs\.personio\.(de|com)$/i.test(new URL(url).hostname); }
  catch { return false; }
}

export function feedUrl(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.host}/xml`;
}

const unwrap = (s) => decodeEntities(String(s ?? '')
  .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')).trim();
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? unwrap(m[1]) : '';
};
const allTags = (xml, name) =>
  [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'g'))].map(m => m[1]);
const htmlToText = (html) => decodeEntities(String(html)
  .replace(/<\s*(br|\/p|\/li|\/h\d|\/div)\s*\/?>/gi, '\n')
  .replace(/<[^>]*>/g, ' '))
  .replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

// Parse the feed into job objects (title, url, location, company, description).
// Pure, unit-tested in test/personio.test.js.
export function parsePersonioXml(xml, siteUrl, companyName = '') {
  const origin = new URL(siteUrl).origin;
  const jobs = [];
  for (const pos of allTags(String(xml ?? ''), 'position')) {
    // Read the position's own fields with the nested blocks taken out, so a
    // description section's <name> or an extra office can't stand in for them.
    const descriptions = pos.match(/<jobDescriptions>([\s\S]*?)<\/jobDescriptions>/)?.[1] ?? '';
    const additional = pos.match(/<additionalOffices>([\s\S]*?)<\/additionalOffices>/)?.[1] ?? '';
    const own = pos.replace(/<jobDescriptions>[\s\S]*?<\/jobDescriptions>/, '')
      .replace(/<additionalOffices>[\s\S]*?<\/additionalOffices>/, '');
    const id = tag(own, 'id');
    const title = tag(own, 'name').replace(/\s+/g, ' ');
    if (!id || !title) continue;
    const offices = [tag(own, 'office'), ...allTags(additional, 'office').map(unwrap)].filter(Boolean);
    const sections = allTags(descriptions, 'jobDescription').map(d => {
      const heading = tag(d, 'name');
      const body = htmlToText(tag(d, 'value'));
      return [heading, body].filter(Boolean).join('\n');
    }).filter(Boolean);
    jobs.push({
      title,
      url: `${origin}/job/${encodeURIComponent(id)}`,
      location: [...new Set(offices)].join(', '),
      company: tag(own, 'subcompany') || companyName,
      description: sections.join('\n\n').slice(0, 4000),
    });
  }
  return jobs;
}

// Fetch and parse the feed. Throws on HTTP errors; returns [] for a valid
// feed without positions.
export async function fetchPersonioJobs(source, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const res = await fetchImpl(feedUrl(source.url), {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; job-alert-bot)', Accept: 'application/xml, text/xml' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Personio-Feed HTTP ${res.status}`);
  const xml = await res.text();
  if (!/<workzag-jobs[\s>]/.test(xml)) throw new Error('Personio-Feed: unerwartetes Format');
  return parsePersonioXml(xml, source.url, source.name);
}
