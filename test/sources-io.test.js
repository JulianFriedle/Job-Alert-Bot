// Sources tab JSON export/import (#31): pure helpers from public/sources-io.js.
import test from 'node:test';
import assert from 'node:assert/strict';

import { sourceKey, sourceProblem, parseSourcesFile, combineSources, countNew, exportFileName } from '../public/sources-io.js';

const A = { name: 'ACME', url: 'https://jobs.acme.example/karriere/', type: 'careers-page', paginationParam: 'page', maxPages: 10 };
const B = { name: 'Beta', url: 'https://beta.example/jobs' };
const LI = { name: 'LinkedIn Suche', type: 'linkedin', managedBy: 'wizard', search: { keywords: 'Konstrukteur', location: 'Stuttgart', radiusKm: 30 } };

test('same source = same page URL (case, slash, fragment ignored) or same portal search', () => {
  assert.equal(sourceKey(A), sourceKey({ url: 'https://JOBS.acme.example/karriere#top' }));
  assert.notEqual(sourceKey(A), sourceKey({ url: 'https://jobs.acme.example/karriere?page=2' }));
  assert.equal(sourceKey(LI), sourceKey({ type: 'linkedin', search: { keywords: ' konstrukteur ', location: 'STUTTGART' } }));
  assert.notEqual(sourceKey(LI), sourceKey({ type: 'indeed', search: { keywords: 'Konstrukteur', location: 'Stuttgart' } }));
});

test('entries are checked like PUT /api/sources', () => {
  assert.equal(sourceProblem(A), null);
  assert.equal(sourceProblem(LI), null);
  assert.match(sourceProblem({ url: 'https://x.example' }), /Name/);
  assert.match(sourceProblem({ name: 'X', url: 'ftp://x' }), /URL/);
  assert.match(sourceProblem({ name: 'X', type: 'indeed', search: {} }), /Suchbegriff/);
  assert.match(sourceProblem('text'), /kein Objekt/);
});

test('a file is read as { sources } or a plain list; invalid entries are reported, not fatal', () => {
  const r = parseSourcesFile('﻿' + JSON.stringify({ sources: [A, { name: '' }, LI] }));
  assert.deepEqual(r.valid, [A, LI]);
  assert.deepEqual(r.invalid, [{ index: 2, name: '', problem: 'Name fehlt' }]);
  assert.deepEqual(parseSourcesFile(JSON.stringify([B])).valid, [B]);
  assert.throws(() => parseSourcesFile('{nope'), /Keine gültige JSON-Datei/);
  assert.throws(() => parseSourcesFile('{"x":1}'), /Erwarte/);
});

test('merge adds only new sources and keeps every field; replace takes the file', () => {
  const current = [{ ...A, name: 'ACME (mein Name)' }, LI];
  const imported = [A, B, B];
  assert.equal(countNew(current, imported), 2);
  const m = combineSources(current, imported, 'merge');
  assert.deepEqual(m.sources.map(s => s.name), ['ACME (mein Name)', 'LinkedIn Suche', 'Beta']);
  assert.equal(m.added, 1);
  assert.equal(m.sources[1].managedBy, 'wizard', 'hidden fields survive');
  const r = combineSources(current, [A, B, B], 'replace');
  assert.deepEqual(r.sources, [A, B]);
  assert.equal(r.sources[0].maxPages, 10);
});

test('export file name: client slug and date', () => {
  const d = new Date('2026-11-14T12:00:00Z');
  assert.equal(exportFileName('', d), 'quellen-2026-11-14.json');
  assert.equal(exportFileName('Müller & Söhne GmbH', d), 'quellen-muller-sohne-gmbh-2026-11-14.json');
});
