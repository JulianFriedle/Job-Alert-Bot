// Dispatch for the job-board platform scrapers. A source whose `type` names a
// platform (linkedin | stepstone | indeed) is handled by its dedicated module;
// everything else falls through to the generic career-page scraper (the
// caller, scrapeAll in src/scraper.js, decides).
import * as linkedin from './linkedin.js';
import * as stepstone from './stepstone.js';
import * as indeed from './indeed.js';

const PLATFORMS = { linkedin, stepstone, indeed };

export const PLATFORM_TYPES = Object.keys(PLATFORMS);

export function isPlatformSource(source) {
  // hasOwn, not a bare property probe: `type: "constructor"` would hit
  // Object.prototype and route the source into scrapePlatform, where
  // .scrape is undefined — the same predicate the server validation uses.
  return Boolean(source && Object.hasOwn(PLATFORMS, source.type));
}

// Same contract as scrapeSource: resolves { jobs, duplicates, siteTotal }.
export function scrapePlatform(source) {
  return PLATFORMS[source.type].scrape(source);
}
