// CSV export of the Jobs tab: field escaping, column layout, and the filter/sort
// logic that mirrors the toolbar. Timestamps are formatted in local time, so pin
// the zone before anything constructs a Date.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  csvField, csvRow, buildJobsCsv, filterJobs, formatDateTime, csvFileName,
  COLUMNS, BOM, DELIMITER,
} from '../src/csv-export.js';

const job = (over = {}) => ({
  id: 'j1', title: 'Entwicklungsingenieur', company: 'ACME GmbH', location: 'Stuttgart',
  url: 'https://example.com/1', description: 'Lange Beschreibung', score: 9,
  summary: 'Passt gut', source: 'StepStone', platform: 'stepstone', easy_apply: 0,
  scraped_at: '2026-08-10T08:30:00.000Z', analyzed_at: '2026-08-10T08:35:00.000Z',
  last_seen_at: '2026-08-14T06:00:00.000Z', expired: 0,
  applied: 0, applied_at: null, status: null, application_state: null,
  ...over,
});

// ── field escaping ───────────────────────────────────────────────────────────

test('csvField leaves plain values untouched and blanks null/undefined', () => {
  assert.equal(csvField('Ingenieur'), 'Ingenieur');
  assert.equal(csvField(9), '9');
  assert.equal(csvField(0), '0', 'zero must not become an empty cell');
  assert.equal(csvField(null), '');
  assert.equal(csvField(undefined), '');
});

test('csvField quotes delimiters, quotes and line breaks', () => {
  assert.equal(csvField('ACME; GmbH'), '"ACME; GmbH"');
  assert.equal(csvField('Berlin, Mitte'), '"Berlin, Mitte"');
  assert.equal(csvField('Er sagte "hallo"'), '"Er sagte ""hallo"""');
  assert.equal(csvField('Zeile1\nZeile2'), '"Zeile1\nZeile2"');
});

test('csvField normalizes CRLF inside a cell to LF', () => {
  assert.equal(csvField('Zeile1\r\nZeile2\rZeile3'), '"Zeile1\nZeile2\nZeile3"');
});

test('csvField neutralizes formula injection', () => {
  // A leading =, +, - or @ would be evaluated by Excel/LibreOffice on open.
  assert.equal(csvField('=1+1'), '"\t=1+1"');
  assert.equal(csvField('@SUM(A1)'), '"\t@SUM(A1)"');
  assert.equal(csvField('-2'), '"\t-2"');
  assert.equal(csvField('+49 170 1234567'), '"\t+49 170 1234567"');
  assert.equal(csvField('Ingenieur = super'), 'Ingenieur = super', 'only a LEADING marker is escaped');
});

test('csvRow joins with the semicolon delimiter', () => {
  assert.equal(csvRow(['a', 'b;c', 'd']), `a${DELIMITER}"b;c"${DELIMITER}d`);
});

// ── document shape ───────────────────────────────────────────────────────────

test('buildJobsCsv starts with a BOM, a header row, and uses CRLF line endings', () => {
  const csv = buildJobsCsv([job()]);
  assert.ok(csv.startsWith(BOM), 'UTF-8 BOM so Excel reads umlauts correctly');
  const lines = csv.slice(BOM.length).split('\r\n');
  assert.equal(lines[0].split(DELIMITER)[0], 'Jobbezeichnung');
  assert.equal(lines.length, 3, 'header + 1 job + trailing newline');
  assert.equal(lines[2], '');
});

test('buildJobsCsv emits a header-only file for an empty list', () => {
  const csv = buildJobsCsv([]);
  assert.equal(csv, BOM + csvRow(COLUMNS.map(c => c.header.de)) + '\r\n');
});

test('buildJobsCsv carries every column of a job, including the full description', () => {
  const csv = buildJobsCsv([job({ description: 'Sehr lange Stellenbeschreibung mit Details' })]);
  const cells = csv.slice(BOM.length).split('\r\n')[1].split(DELIMITER);
  const at = (key) => cells[COLUMNS.findIndex(c => c.key === key)];
  assert.equal(at('title'), 'Entwicklungsingenieur');
  assert.equal(at('company'), 'ACME GmbH');
  assert.equal(at('location'), 'Stuttgart');
  assert.equal(at('score'), '9');
  assert.equal(at('source'), 'StepStone');
  assert.equal(at('platform'), 'stepstone');
  assert.equal(at('url'), 'https://example.com/1');
  assert.equal(at('id'), 'j1');
  assert.equal(at('description'), 'Sehr lange Stellenbeschreibung mit Details');
  assert.equal(at('scraped_at'), '10.08.2026 08:30');
});

test('buildJobsCsv translates status, booleans and the application state', () => {
  const rows = buildJobsCsv([
    job({ applied: 1, applied_at: '2026-08-12T10:00:00.000Z', status: 'interview', easy_apply: 1, expired: 1, application_state: 'submitted' }),
  ]).slice(BOM.length).split('\r\n')[1].split(DELIMITER);
  const at = (key) => rows[COLUMNS.findIndex(c => c.key === key)];
  assert.equal(at('status'), 'Interview');
  assert.equal(at('applied'), 'Ja');
  assert.equal(at('applied_at'), '12.08.2026 10:00');
  assert.equal(at('easy_apply'), 'Ja');
  assert.equal(at('expired'), 'Ja');
  assert.equal(at('application_state'), 'Gesendet');
});

test('buildJobsCsv honours the English locale for headers, labels and dates', () => {
  const csv = buildJobsCsv([job({ applied: 1, status: 'rejected' })], { lang: 'en' });
  const lines = csv.slice(BOM.length).split('\r\n');
  const at = (key) => lines[1].split(DELIMITER)[COLUMNS.findIndex(c => c.key === key)];
  assert.equal(lines[0].split(DELIMITER)[0], 'Job title');
  assert.equal(at('status'), 'Rejected');
  assert.equal(at('applied'), 'Yes');
  assert.equal(at('scraped_at'), '2026-08-10 08:30');
});

test('buildJobsCsv keeps a semicolon in the data from shifting columns', () => {
  const csv = buildJobsCsv([job({ company: 'Müller; Söhne GmbH', summary: 'A;B' })]);
  const line = csv.slice(BOM.length).split('\r\n')[1];
  // Naive split would over-count; the quoted cells keep the real column count.
  assert.ok(line.includes('"Müller; Söhne GmbH"'));
  assert.ok(line.includes('"A;B"'));
});

test('formatDateTime tolerates empty and unparseable input', () => {
  assert.equal(formatDateTime(null), '');
  assert.equal(formatDateTime(''), '');
  assert.equal(formatDateTime('nicht-ein-datum'), '');
});

// ── filtering (mirrors public/app.js filteredJobs) ────────────────────────────

const corpus = [
  job({ id: 'a', title: 'Entwicklungsingenieur', company: 'ACME', location: 'Stuttgart', source: 'StepStone', score: 9, status: 'applied', applied: 1, scraped_at: '2026-08-01T00:00:00.000Z' }),
  job({ id: 'b', title: 'Konstrukteur',          company: 'Beta', location: 'Karlsruhe', source: 'Indeed',    score: 7, status: null,      applied: 0, scraped_at: '2026-08-05T00:00:00.000Z' }),
  job({ id: 'c', title: 'Projektleiter',         company: 'Gamma', location: 'München',  source: 'Indeed',    score: 4, status: 'rejected', applied: 1, scraped_at: '2026-08-03T00:00:00.000Z' }),
];
const ids = (jobs) => jobs.map(j => j.id);

test('filterJobs without criteria returns everything in the given order', () => {
  assert.deepEqual(ids(filterJobs(corpus)), ['a', 'b', 'c']);
  assert.deepEqual(ids(filterJobs(corpus, {})), ['a', 'b', 'c']);
});

test('filterJobs filters by source, min score and status', () => {
  assert.deepEqual(ids(filterJobs(corpus, { source: 'Indeed' })), ['b', 'c']);
  assert.deepEqual(ids(filterJobs(corpus, { minScore: 6 })), ['a', 'b']);
  assert.deepEqual(ids(filterJobs(corpus, { minScore: '8' })), ['a'], 'string param from the query string');
  assert.deepEqual(ids(filterJobs(corpus, { status: 'rejected' })), ['c']);
  assert.deepEqual(ids(filterJobs(corpus, { status: 'none' })), ['b'], '"none" = jobs without any status');
});

test('filterJobs searches title, company, location and source case-insensitively', () => {
  assert.deepEqual(ids(filterJobs(corpus, { q: 'ingenieur' })), ['a']);
  assert.deepEqual(ids(filterJobs(corpus, { q: 'BETA' })), ['b']);
  assert.deepEqual(ids(filterJobs(corpus, { q: 'münchen' })), ['c']);
  assert.deepEqual(ids(filterJobs(corpus, { q: '  stepstone  ' })), ['a'], 'query is trimmed');
  assert.deepEqual(ids(filterJobs(corpus, { q: 'gibtsnicht' })), []);
});

test('filterJobs combines criteria', () => {
  assert.deepEqual(ids(filterJobs(corpus, { source: 'Indeed', minScore: 6, q: 'konstrukteur' })), ['b']);
  assert.deepEqual(ids(filterJobs(corpus, { source: 'Indeed', minScore: 8 })), []);
});

test('filterJobs sorts by discovery date on request', () => {
  assert.deepEqual(ids(filterJobs(corpus, { sort: 'found-asc' })), ['a', 'c', 'b']);
  assert.deepEqual(ids(filterJobs(corpus, { sort: 'found-desc' })), ['b', 'c', 'a']);
  assert.deepEqual(ids(filterJobs(corpus, { sort: 'default' })), ['a', 'b', 'c'], 'default keeps DB relevance order');
});

test('filterJobs does not mutate the input array', () => {
  const input = [...corpus];
  filterJobs(input, { sort: 'found-desc' });
  assert.deepEqual(ids(input), ['a', 'b', 'c']);
});

test('filterJobs treats a missing score as 0', () => {
  const withoutScore = [job({ id: 'x', score: null })];
  assert.deepEqual(ids(filterJobs(withoutScore, { minScore: 1 })), []);
  assert.deepEqual(ids(filterJobs(withoutScore, { minScore: 0 })), ['x']);
});

// ── file name ────────────────────────────────────────────────────────────────

test('csvFileName is date-stamped and only suffixed for non-default clients', () => {
  const now = new Date('2026-08-15T12:00:00.000Z');
  assert.equal(csvFileName('default', 'default', now), 'jobs-2026-08-15.csv');
  assert.equal(csvFileName('kunde-1', 'default', now), 'jobs-kunde-1-2026-08-15.csv');
  assert.equal(csvFileName('a/b c', 'default', now), 'jobs-a_b_c-2026-08-15.csv', 'path separators cannot escape');
});
