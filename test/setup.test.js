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
