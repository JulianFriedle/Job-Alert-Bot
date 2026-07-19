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

test('indeed: broken mosaic shapes yield an empty list', () => {
  assert.deepEqual(extractJobcards(null), []);
  assert.deepEqual(extractJobcards({}), []);
  assert.deepEqual(extractJobcards({ providerData: { 'mosaic-provider-jobcards': {} } }), []);
});
