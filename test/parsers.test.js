// Pure parser/URL helpers of the platform scrapers.
import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalJobUrl as linkedinUrl } from '../src/scrapers/linkedin.js';
import { canonicalJobUrl as stepstoneUrl } from '../src/scrapers/stepstone.js';
import { extractJobcards, canonicalJobUrl as indeedUrl } from '../src/scrapers/indeed.js';

test('linkedin: canonical URL strips slug + tracking params', () => {
  assert.equal(
    linkedinUrl('https://de.linkedin.com/jobs/view/entwicklungsingenieur-bei-acme-4012345678?position=3&trk=guest'),
    'https://www.linkedin.com/jobs/view/4012345678'
  );
  assert.equal(
    linkedinUrl('https://www.linkedin.com/jobs/view/4012345678/?refId=abc'),
    'https://www.linkedin.com/jobs/view/4012345678'
  );
});

test('stepstone: canonical URL drops the tracking query', () => {
  assert.equal(
    stepstoneUrl('https://www.stepstone.de/stellenangebote--Ingenieur-Stuttgart-ACME--12345678-inline.html?rltr=17_17'),
    'https://www.stepstone.de/stellenangebote--Ingenieur-Stuttgart-ACME--12345678-inline.html'
  );
});

test('indeed: jobcards extracted from the mosaic provider JSON incl. easy-apply flag', () => {
  const mosaic = {
    providerData: {
      'mosaic-provider-jobcards': {
        metaData: {
          mosaicProviderJobCardsModel: {
            results: [
              { jobkey: 'abc123', title: 'Entwicklungsingenieur (m/w/d)', company: 'ACME GmbH',
                formattedLocation: 'Stuttgart', indeedApplyEnabled: true, snippet: '<b>Toller</b> Job' },
              { jobkey: 'def456', displayTitle: 'Konstrukteur', company: 'Beta AG',
                formattedLocation: 'Karlsruhe', indeedApplyEnabled: false },
              { title: 'kaputt ohne jobkey' },
            ],
          },
        },
      },
    },
  };
  const cards = extractJobcards(mosaic);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].jobkey, 'abc123');
  assert.equal(cards[0].easyApply, true);
  assert.equal(cards[0].snippet, 'Toller Job', 'HTML stripped from snippet');
  assert.equal(cards[1].easyApply, false);
  assert.equal(indeedUrl('abc123'), 'https://de.indeed.com/viewjob?jk=abc123');
});

test('indeed: absent easy-apply flag is unknown (null), never a hard false', () => {
  // Regression: mapping "flag missing" (schema drift) to 0 permanently locked
  // every Indeed job out of auto-apply AND manual apply downstream.
  const mosaic = {
    providerData: {
      'mosaic-provider-jobcards': {
        metaData: {
          mosaicProviderJobCardsModel: {
            results: [{ jobkey: 'ghi789', title: 'Ohne Flag', company: 'Gamma SE' }],
          },
        },
      },
    },
  };
  const cards = extractJobcards(mosaic);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].easyApply, null);
});

test('indeed: broken mosaic shapes yield an empty list', () => {
  assert.deepEqual(extractJobcards(null), []);
  assert.deepEqual(extractJobcards({}), []);
  assert.deepEqual(extractJobcards({ providerData: { 'mosaic-provider-jobcards': {} } }), []);
});

// ── Indeed: why a search came back empty (#37) ──────────────────────────────
import { explainEmptyResult } from '../src/scrapers/indeed.js';

test('indeed: an empty search page says why, and only a real "no results" counts as genuine', () => {
  // [facts, reason, genuine, hard]
  const cases = [
    [{ status: 403 }, /HTTP 403/, false, true],
    [{ status: 200, url: 'https://secure.indeed.com/account/login?hl=de' }, /Login/, false, true],
    [{ status: 200, url: 'https://de.indeed.com/auth?continue=x' }, /Login/, false, true],
    [{ status: 200, url: 'https://de.indeed.com/authors/jobs' }, /Keine Jobkarten/, false, false],
    [{ status: 200, noResults: true }, /keine Treffer/, true, false],
    [{ status: 200, consent: true, domCards: 0 }, /Consent/, false, false],
    [{ status: 200, hasMosaic: true }, /nicht lesbar/, false, false],
    [{ status: 200 }, /Keine Jobkarten/, false, false],
  ];
  for (const [facts, reason, genuine, hard] of cases) {
    const d = explainEmptyResult({ title: 'Ingenieur Jobs in Stuttgart | Indeed', ...facts });
    assert.match(d.reason, reason, JSON.stringify(facts));
    assert.equal(d.genuine, genuine, JSON.stringify(facts));
    assert.equal(d.hard, hard, JSON.stringify(facts));
    // The stored reason never carries the page title (it holds the search terms).
    assert.ok(!/Ingenieur|Stuttgart/.test(d.reason), d.reason);
  }
  // The facts line names what was seen, for the log.
  assert.match(explainEmptyResult({ status: 200, title: 'Jobs | Indeed', domCards: 0 }).facts,
    /HTTP 200, Titel „Jobs \| Indeed“, mosaic-JSON fehlt, Karten im DOM: 0/);
  // An error status beats a "no results" text on the same page.
  assert.equal(explainEmptyResult({ status: 429, noResults: true }).genuine, false);
});
