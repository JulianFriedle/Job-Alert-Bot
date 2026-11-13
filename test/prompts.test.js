// Output-language directives: unset must leave the prompts exactly as before.
import test from 'node:test';
import assert from 'node:assert/strict';

import { outputLanguage, analyzerLanguageLine, coverLetterLanguageLine } from '../src/prompts.js';

test('no language chosen → no directive, prompts unchanged', () => {
  for (const profile of [undefined, {}, { preferences: {} }, { preferences: { outputLanguage: '' } }]) {
    assert.equal(outputLanguage(profile), null);
    assert.equal(analyzerLanguageLine(profile), '');
    assert.equal(coverLetterLanguageLine(profile), '');
  }
});

test('an unknown language value is ignored rather than passed to the model', () => {
  assert.equal(outputLanguage({ preferences: { outputLanguage: 'fr' } }), null);
  assert.equal(outputLanguage({ preferences: { outputLanguage: 'toString' } }), null);
});

test('English output is requested in both prompts', () => {
  const p = { preferences: { outputLanguage: 'en' } };
  assert.match(analyzerLanguageLine(p), /in English\./);
  assert.match(coverLetterLanguageLine(p), /auf Englisch/);
});

test('German output is requested explicitly once chosen', () => {
  const p = { preferences: { outputLanguage: 'de' } };
  assert.match(analyzerLanguageLine(p), /in German\./);
  assert.match(coverLetterLanguageLine(p), /auf Deutsch/);
});
