// Setup tells users to copy .env.example and profile.example.json into place, so a
// fresh install arrives with every required field non-empty. If those template
// values counted as answers, the wizard would never open for a new user.
// setup.js reads the client's config columns, so it pulls in database.js, which
// opens the DB at import time — point it at a throwaway file first so running the
// suite never touches the real data/jobs.db. Static imports are hoisted above this
// assignment, so setup.js must be pulled in dynamically (same pattern as db.test.js).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.JOBS_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'jobbot-setup-')), 'test.db');

import test from 'node:test';
import assert from 'node:assert/strict';

const { isTemplateValue } = await import('../src/setup.js');

test('a value still equal to the template counts as unanswered', () => {
  assert.equal(isTemplateValue('sk-ant-...', 'sk-ant-...'), true);
  assert.equal(isTemplateValue('123456:ABC-DEF...', '123456:ABC-DEF...'), true);
  assert.equal(isTemplateValue('Your Name', 'Your Name'), true);
  // Whitespace around a copied value doesn't make it the user's own.
  assert.equal(isTemplateValue('  Your Name  ', 'Your Name'), true);
});

test('a real answer is never mistaken for a placeholder', () => {
  assert.equal(isTemplateValue('sk-ant-api03-realkey', 'sk-ant-...'), false);
  assert.equal(isTemplateValue('Julian Friedle', 'Your Name'), false);
  assert.equal(isTemplateValue('987654322', '987654321'), false);
});

test('lists compare element-wise, so one edited entry makes the field the user\'s', () => {
  const template = ['e.g. Automotive', 'e.g. Maschinenbau'];
  assert.equal(isTemplateValue(['e.g. Automotive', 'e.g. Maschinenbau'], template), true);
  assert.equal(isTemplateValue(['e.g. Automotive', 'Halbleiter'], template), false);
  assert.equal(isTemplateValue(['Halbleiter'], template), false);
  assert.equal(isTemplateValue([], template), false);
});

test('a missing template or missing value is never a match', () => {
  // No template shipped for this key (or the template file is absent in a
  // deployment) — every user value must then be taken at face value.
  assert.equal(isTemplateValue('anything', undefined), false);
  assert.equal(isTemplateValue('anything', null), false);
  assert.equal(isTemplateValue(undefined, 'Your Name'), false);
  assert.equal(isTemplateValue(null, 'Your Name'), false);
});

// ── Job-board step and career-page step share one source list ────────────────
const { boardsFromSources, applyBoards, mergeCareerSources } = await import('../src/setup.js');

const career = { name: 'Firma', url: 'https://firma.example/jobs', type: 'careers-page', paginationParam: 'page' };
const handMade = { name: 'Meine LinkedIn-Suche', type: 'linkedin', search: { keywords: 'CAD', location: 'Ulm' } };

test('the boards step creates one managed search per chosen platform', () => {
  const out = applyBoards([career], { platforms: ['linkedin', 'indeed'], keywords: 'Konstrukteur', location: 'Stuttgart', radiusKm: 30 });
  const boards = out.filter(s => s.managedBy === 'wizard');
  assert.deepEqual(boards.map(s => s.type), ['linkedin', 'indeed']);
  assert.deepEqual(boards[0].search, { keywords: 'Konstrukteur', location: 'Stuttgart', radiusKm: 30 });
  assert.ok(out.includes(career), 'career pages survive');
});

test('re-saving the boards step replaces only its own searches', () => {
  const first = applyBoards([career, handMade], { platforms: ['linkedin', 'stepstone'], keywords: 'A', location: '', radiusKm: null });
  const second = applyBoards(first, { platforms: ['indeed'], keywords: 'B', location: '', radiusKm: null });
  assert.deepEqual(second.filter(s => s.managedBy === 'wizard').map(s => s.type), ['indeed']);
  assert.ok(second.includes(handMade), 'a hand-made search is never touched');
  assert.ok(second.includes(career));
  // Unticking every platform removes the managed searches and nothing else.
  assert.deepEqual(applyBoards(second, { platforms: [], keywords: '', location: '', radiusKm: null }), [career, handMade]);
});

test('the boards step reads back what it wrote, and ignores hand-made searches', () => {
  const saved = applyBoards([handMade], { platforms: ['stepstone'], keywords: 'Ingenieur', location: 'Ulm', radiusKm: 25 });
  assert.deepEqual(boardsFromSources(saved), { platforms: ['stepstone'], keywords: 'Ingenieur', location: 'Ulm', radiusKm: '25' });
  assert.deepEqual(boardsFromSources([handMade]).platforms, []);
});

test('saving career pages keeps every job-board search', () => {
  const managed = applyBoards([], { platforms: ['linkedin'], keywords: 'X', location: '', radiusKm: null })[0];
  const merged = mergeCareerSources([career, handMade, managed], [{ ...career, name: 'Firma neu' }]);
  assert.deepEqual(merged.map(s => s.name), ['Firma neu', 'Meine LinkedIn-Suche', 'LinkedIn Suche']);
  assert.equal(merged[0].paginationParam, 'page', 'per-source extras survive a wizard save');
});

// ── Wizard fields and their English overrides ───────────────────────────────
// Wizard labels are German; English comes from WIZARD_FIELDS_EN in i18n.js and
// silently falls back to German when a key is missing. Catch that here.
const { STEPS } = await import('../src/setup.js');
const { readFileSync } = await import('node:fs');

test('the "Über dich" step asks for programming skills', () => {
  const profile = STEPS.find(s => s.id === 'profile');
  assert.ok(profile.fields.some(f => f.key === 'cv.skills.programming' && f.type === 'list'));
});

test('every labelled wizard field has an English override', () => {
  const i18n = readFileSync(new URL('../public/i18n.js', import.meta.url), 'utf8');
  const start = i18n.indexOf('const WIZARD_FIELDS_EN = {');
  const block = i18n.slice(start, i18n.indexOf('\n};', start));
  const missing = STEPS.flatMap(s => s.fields)
    .filter(f => f.label)
    .map(f => f.key)
    .filter(k => !new RegExp(`^\\s*(?:'${k.replace(/\./g, '\\.')}'|${k.replace(/\./g, '\\.')}):`, 'm').test(block));
  assert.deepEqual(missing, []);
});

test('the wizard finish page never pre-checks the first run', () => {
  // A pre-checked box made finishing the wizard start an analysis of every job
  // found — 1,500+ API calls on a setup with many career pages.
  const src = readFileSync(new URL('../public/setup.js', import.meta.url), 'utf8');
  const tag = src.match(/<input[^>]*id="su-run-now"[^>]*>/)?.[0];
  assert.ok(tag, 'su-run-now checkbox not found');
  assert.doesNotMatch(tag, /checked/);
});
