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

const { normalizeTitle } = await import('../src/scheduler.js');

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
