// Smaller findings from the review in #17 (#21): a new posting found by two
// sources is processed once, deterministically, and Indeed's search snippet
// stands in only when the detail fetch fails or comes back too short.
import test from 'node:test';
import assert from 'node:assert/strict';

const { uniqueJobsById, withSnippetFallback } = await import('../src/scraper.js');
const { decodeEntities, extractJobcards } = await import('../src/scrapers/indeed.js');

const ids = (jobs) => jobs.map(j => `${j.id}:${j.source}`);

test('one copy per id; config order decides, not scrape order', () => {
  const order = ['Konzern', 'Sparte'];
  const scraped = [
    { id: 'a', source: 'Sparte' }, { id: 'b', source: 'Konzern' },
    { id: 'a', source: 'Konzern' }, { id: 'c', source: 'Sparte' },
  ];
  const { unique, dropped } = uniqueJobsById(scraped, order);
  assert.deepEqual(ids(unique).sort(), ['a:Konzern', 'b:Konzern', 'c:Sparte']);
  assert.deepEqual(ids(dropped), ['a:Sparte']);
  // Same result whichever source finished first.
  const reversed = uniqueJobsById([...scraped].reverse(), order);
  assert.deepEqual(ids(reversed.unique).sort(), ids(unique).sort());
});

test('a job-board copy wins, it carries platform data for auto-apply', () => {
  const { unique } = uniqueJobsById([
    { id: 'x', source: 'Firma' },
    { id: 'x', source: 'Indeed Suche', platform: 'indeed', easyApply: 1 },
  ], ['Firma', 'Indeed Suche']);
  assert.equal(unique[0].platform, 'indeed');
});

test('the snippet stands in only for a missing or too short description', () => {
  const snippet = 'Wir suchen dich für spannende Projekte im Maschinenbau. '.repeat(3);
  const full = 'Ausführliche Stellenbeschreibung. '.repeat(20);
  assert.equal(withSnippetFallback({ snippet, description: '' }).description, snippet);
  assert.equal(withSnippetFallback({ snippet, description: 'Cookies akzeptieren' }).description, snippet);
  assert.equal(withSnippetFallback({ snippet, description: full }).description, full, 'never instead of the posting');
  assert.equal(withSnippetFallback({ snippet: 'kurz', description: 'Cookie-Banner Text hier' }).description, 'Cookie-Banner Text hier');
  assert.equal(withSnippetFallback({ description: '' }).description, '', 'no snippet, nothing changes');
  // A fetch cut off by a stop leaves the job empty, so it is not saved and the
  // next run fetches the posting.
  assert.equal(withSnippetFallback({ snippet, description: '' }, true).description, '');
});

test('Indeed snippets are decoded, not just stripped', () => {
  assert.equal(decodeEntities('Stra&szlig;e &amp; M&ouml;bel &#39;x&#39; &#x263A; &nbsp;y &unknown;'),
    'Straße & Möbel \'x\' ☺  y &unknown;');
  const cards = extractJobcards({ providerData: { 'mosaic-provider-jobcards': { metaData: { mosaicProviderJobCardsModel: {
    results: [{ jobkey: 'k1', title: 'Ingenieur', snippet: '<li>Gr&ouml;&szlig;te &amp; beste</li>' }],
  } } } } });
  assert.equal(cards[0].snippet, 'Größte & beste');
});
