// The title pre-filters are plain substring matches, so a gender marker sitting in the
// middle of a title silently breaks them. These pin the normalization that fixes it.
// scheduler.js pulls in database.js, which opens the DB at import time — point it at a
// throwaway file first so running the suite never touches the real data/jobs.db. Static
// imports are hoisted above this assignment, so scheduler.js must be pulled in
// dynamically, after the env var is set (same pattern as db.test.js).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.JOBS_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'jobbot-filters-')), 'test.db');

import test from 'node:test';
import assert from 'node:assert/strict';

const { normalizeTitle, createTitleFilter, NOT_ALLOWED_SUMMARY, createLocationFilter, WRONG_LOCATION_SUMMARY } = await import('../src/scheduler.js');
const db = await import('../src/database.js');

test('normalizeTitle strips a gender marker wherever it sits', () => {
  assert.equal(normalizeTitle('Entwickler (m/w/d) für Embedded Systeme'), 'entwickler für embedded systeme');
  assert.equal(normalizeTitle('Ingenieur (w/m/d) Fertigungstechnik'), 'ingenieur fertigungstechnik');
  assert.equal(normalizeTitle('Techniker (m/w/x) Instandhaltung'), 'techniker instandhaltung');
  assert.equal(normalizeTitle('Projektleiter (d/w/m)'), 'projektleiter');
});

test('normalizeTitle folds inline gender forms into the plain noun', () => {
  assert.equal(normalizeTitle('Ingenieur*in Fertigungstechnik'), 'ingenieurin fertigungstechnik');
  assert.equal(normalizeTitle('Referent:in Qualitätssicherung'), 'referentin qualitätssicherung');
});

test('normalizeTitle is total and collapses whitespace', () => {
  assert.equal(normalizeTitle(null), '');
  assert.equal(normalizeTitle(undefined), '');
  assert.equal(normalizeTitle('   Senior   Software   Engineer  '), 'senior software engineer');
});

test('normalizeTitle leaves parentheses that are not gender markers alone', () => {
  assert.equal(normalizeTitle('Monteur (Nachtschicht)'), 'monteur (nachtschicht)');
  assert.equal(normalizeTitle('Techniker (2 Stellen)'), 'techniker (2 stellen)');
});

test('a keyword hits a title it would otherwise miss', () => {
  // Without normalization "entwickler embedded" never matches, because the marker
  // sits between the two words the keyword expects to be adjacent.
  const keyword = 'entwickler für embedded';
  const title = 'Entwickler (m/w/d) für Embedded Systeme';
  assert.equal(title.toLowerCase().includes(keyword), false, 'precondition: raw match fails');
  assert.equal(normalizeTitle(title).includes(keyword), true);
});

// ── Title allowlist (#34) and the shared title filter ────────────────────────

test('an empty allowlist restricts nothing', () => {
  const f = createTitleFilter({ titleBlocklist: ['praktikum'], priorityKeywords: [], titleAllowlist: [] });
  assert.equal(f.hasAllowlist, false);
  assert.equal(f.reject('Konstrukteur (m/w/d)'), null);
  assert.equal(f.reject('Praktikum Konstruktion'), 'blocked');
});

test('with an allowlist only matching titles go on', () => {
  const f = createTitleFilter({ titleBlocklist: [], priorityKeywords: [], titleAllowlist: ['assistenz', 'office manager'] });
  assert.equal(f.reject('Assistenz der Geschäftsführung (m/w/d)'), null);
  assert.equal(f.reject('Office Manager*in'), null);
  assert.equal(f.reject('Konstrukteur (m/w/d)'), 'not-allowed');
});

test('the blocklist wins over the allowlist', () => {
  const f = createTitleFilter({ titleBlocklist: ['praktikum'], priorityKeywords: [], titleAllowlist: ['assistenz'] });
  assert.equal(f.reject('Praktikum Assistenz'), 'blocked');
});

test('a priority keyword counts as allowed', () => {
  const f = createTitleFilter({ titleBlocklist: [], priorityKeywords: ['initiativbewerbung'], titleAllowlist: ['assistenz'] });
  assert.equal(f.reject('Initiativbewerbung'), null);
  assert.equal(f.isPriority('Initiativbewerbung'), true);
});

test('keywords match regardless of how they were capitalized', () => {
  // A "Praktikum" typed into the wizard used to match nothing, because only the
  // title was lowercased.
  const f = createTitleFilter({ titleBlocklist: ['Praktikum'], priorityKeywords: ['PhD'], titleAllowlist: ['Executive Assistant'] });
  assert.equal(f.reject('Praktikum im Vertrieb'), 'blocked');
  assert.equal(f.isPriority('PhD position'), true);
  assert.equal(f.reject('executive assistant to the CEO'), null);
});

test('padded keywords still match whole words only', () => {
  const f = createTitleFilter({ titleBlocklist: [' sap '], priorityKeywords: [], titleAllowlist: [] });
  assert.equal(f.reject('Berater SAP Logistik'), 'blocked');
  assert.equal(f.reject('Sapient Engineer'), null);
});

test('blank entries and missing lists are ignored', () => {
  const f = createTitleFilter({ titleBlocklist: ['', '  ', null], titleAllowlist: ['  '] });
  assert.equal(f.hasAllowlist, false);
  assert.equal(f.reject('Irgendein Job'), null);
  assert.equal(createTitleFilter().reject('Irgendein Job'), null);
});

test('keywords are folded like the title (gender forms, spacing)', () => {
  const f = createTitleFilter({ titleBlocklist: ['Referent:in', 'office  manager', 'Ingenieur*in'], titleAllowlist: [] });
  assert.equal(f.reject('Referent:in Marketing'), 'blocked');
  assert.equal(f.reject('Referent*in Marketing'), 'blocked');
  assert.equal(f.reject('Office Manager (m/w/d)'), 'blocked');
  assert.equal(f.reject('Ingenieurin Fertigung'), 'blocked');
});

test('allowlist-dropped jobs can be found and put back into the queue, per client', () => {
  for (const c of ['default', 'other']) {
    db.saveJob(c, { id: 'allow-1', title: 'Konstrukteur', company: 'A', url: 'https://a.example/1', location: '', description: '', source: 'A' });
    db.markAnalyzed(c, 'allow-1', false, null, NOT_ALLOWED_SUMMARY);
  }
  db.saveJob('default', { id: 'block-1', title: 'Praktikum', company: 'A', url: 'https://a.example/2', location: '', description: '', source: 'A' });
  db.markAnalyzed('default', 'block-1', false);

  const since = new Date(Date.now() - 3600 * 1000).toISOString();
  const found = db.getJobsWithSummary('default', NOT_ALLOWED_SUMMARY, since).map(j => j.id);
  assert.deepEqual(found, ['allow-1'], 'blocklist drops are not reopened');

  db.reopenForAnalysis('default', found);
  assert.equal(db.getJobById('default', 'allow-1').relevant, null);
  assert.equal(db.getJobById('default', 'allow-1').summary, null);
  assert.equal(db.getJobById('other', 'allow-1').relevant, 0, 'other client untouched');
});

test('a job gone from its source is not reopened', () => {
  db.saveJob('default', { id: 'allow-old', title: 'Assistenz', company: 'A', url: 'https://a.example/old', location: '', description: '', source: 'A' });
  db.markAnalyzed('default', 'allow-old', false, null, NOT_ALLOWED_SUMMARY);
  const future = new Date(Date.now() + 3600 * 1000).toISOString(); // "seen since" after its last sighting
  assert.ok(!db.getJobsWithSummary('default', NOT_ALLOWED_SUMMARY, future).some(j => j.id === 'allow-old'));
});

test('a keyword ending in a gender marker matches the end of a title', () => {
  const f = createTitleFilter({ titleBlocklist: ['Ingenieur (m/w/d)'], titleAllowlist: [] });
  assert.equal(f.reject('Konstruktion Ingenieur (m/w/d)'), 'blocked');
  assert.equal(createTitleFilter({ titleBlocklist: [' sap '] }).reject('Berater SAP Logistik'), 'blocked');
});

// ── Location pre-filter (#36) ────────────────────────────────────────────────

test('an empty location list restricts nothing', () => {
  const f = createLocationFilter([]);
  assert.equal(f.hasList, false);
  assert.equal(f.reject({ location: 'São Paulo, Brazil' }), null);
  assert.equal(createLocationFilter(undefined).reject({ location: 'Paris' }), null);
});

test('with a location list only matching career-page jobs go on', () => {
  const f = createLocationFilter(['Stuttgart', 'Esslingen', ' Deutschland ']);
  assert.equal(f.reject({ location: 'Stuttgart-Feuerbach' }), null);
  assert.equal(f.reject({ location: 'ESSLINGEN am Neckar' }), null);
  assert.equal(f.reject({ location: 'Hamburg, Deutschland' }), null);
  assert.equal(f.reject({ location: 'São Paulo, Brazil' }), 'wrong-location');
  assert.equal(f.reject({ location: 'Budapest, Hungary' }), 'wrong-location');
  // No country named and a country term listed: kept (see the country test below).
  assert.equal(f.reject({ location: 'Budapest' }), null);
});

test('no location, remote jobs and job-board results always pass', () => {
  const f = createLocationFilter(['Stuttgart']);
  assert.equal(f.reject({ location: '' }), null);
  assert.equal(f.reject({ location: null }), null);
  assert.equal(f.reject({}), null);
  assert.equal(f.reject({ location: 'Remote (EU)' }), null);
  assert.equal(f.reject({ location: 'Homeoffice / Berlin' }), null);
  assert.equal(f.reject({ location: 'Deutschlandweit' }), null);
  // LinkedIn/StepStone/Indeed searches carry their own location and radius.
  assert.equal(f.reject({ location: 'Ludwigsburg', platform: 'linkedin' }), null);
});

test('location-dropped jobs use their own reversible marker', () => {
  assert.notEqual(WRONG_LOCATION_SUMMARY, NOT_ALLOWED_SUMMARY);
  db.saveJob('default', { id: 'loc-1', title: 'Konstrukteur', company: 'A', url: 'https://a.example/loc', location: 'Paris', description: '', source: 'A' });
  db.markAnalyzed('default', 'loc-1', false, null, WRONG_LOCATION_SUMMARY);
  const since = new Date(Date.now() - 3600 * 1000).toISOString();
  assert.ok(db.getJobsWithSummary('default', WRONG_LOCATION_SUMMARY, since).some(j => j.id === 'loc-1'));
});

test('vague locations are kept like a missing one', () => {
  const f = createLocationFilter(['Stuttgart']);
  for (const loc of ['Mehrere Standorte', 'Diverse Standorte', 'Hybrid', 'Flexibel', 'Anywhere', 'Weltweit', 'Multiple Locations']) {
    assert.equal(f.reject({ location: loc }), null, loc);
  }
});

test('umlauts and ß are folded on both sides', () => {
  const f = createLocationFilter(['München', 'Düsseldorf', 'Gießen']);
  for (const loc of ['Muenchen', 'Munchen', 'MÜNCHEN', 'Duesseldorf', 'Giessen']) assert.equal(f.reject({ location: loc }), null, loc);
  assert.equal(createLocationFilter(['Muenchen']).reject({ location: 'München-Pasing' }), null);
});

test('a country term keeps jobs that name no other country', () => {
  const f = createLocationFilter(['Deutschland']);
  assert.equal(f.reject({ location: 'Berlin' }), null, 'a bare city may well be in Germany');
  assert.equal(f.reject({ location: 'Leinfelden-Echterdingen, Germany' }), null);
  assert.equal(f.reject({ location: 'São Paulo, Brazil' }), 'wrong-location');
  assert.equal(f.reject({ location: 'Etowah, TN, United States' }), 'wrong-location');
  assert.equal(f.reject({ location: 'Budapest, Hungary' }), 'wrong-location');
  assert.equal(f.reject({ location: 'Wien, Österreich' }), 'wrong-location');
  // Without a country term a city list is strict.
  assert.equal(createLocationFilter(['Stuttgart']).reject({ location: 'Berlin' }), 'wrong-location');
  // Country names match whole words only ("uk" is not in "Ukraine" … but Ukraine is its own country).
  assert.equal(createLocationFilter(['Deutschland']).reject({ location: 'Dukovany' }), null);
});

test('a job moves to the marker of the list that filters it now', () => {
  // Pipeline helper semantics: a NOT_ALLOWED job that now only fails the
  // location list must carry WRONG_LOCATION so loosening that list frees it.
  const title = createTitleFilter({ titleAllowlist: [] });
  const loc = createLocationFilter(['Stuttgart']);
  const job = { title: 'Konstrukteur', location: 'Paris' };
  assert.equal(title.reject(job.title) ?? loc.reject(job), 'wrong-location');
});
