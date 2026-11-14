import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeQuestionKey, applyAnswer, unansweredRequired,
  prefillFromLibrary, libraryRowsFromQuestions, parseQuestions,
} from '../src/questions.js';

test('normalizeQuestionKey: same question, different punctuation → same key', () => {
  const a = normalizeQuestionKey('Wie viele Jahre Berufserfahrung haben Sie mit CAD?');
  const b = normalizeQuestionKey('  wie viele Jahre Berufserfahrung haben Sie mit CAD ');
  assert.equal(a, b);
  assert.equal(a, 'wie viele jahre berufserfahrung haben sie mit cad');
});

test('applyAnswer: free text is stored, select must match an option', () => {
  const qs = [
    { id: 'q1', label: 'Gehalt?', type: 'text', options: null, required: true, answer: null },
    { id: 'q2', label: 'Erfahrung', type: 'select', options: ['0-2', '3-5', '5+'], required: true, answer: null },
  ];
  assert.equal(applyAnswer(qs, 'q1', ' 55000 ', 'telegram'), true);
  assert.equal(qs[0].answer, '55000');
  assert.equal(qs[0].answeredVia, 'telegram');

  assert.equal(applyAnswer(qs, 'q2', 'zehn Jahre', 'telegram'), false, 'invalid option rejected');
  assert.equal(qs[1].answer, null);
  assert.equal(applyAnswer(qs, 'q2', '3-5', 'gui'), true);
  assert.equal(qs[1].answer, '3-5');
  assert.equal(applyAnswer(qs, 'missing', 'x', 'gui'), false);
});

test('unansweredRequired: only required questions without answers', () => {
  const qs = [
    { id: 'q1', label: 'A', required: true, answer: 'x' },
    { id: 'q2', label: 'B', required: true, answer: '  ' },
    { id: 'q3', label: 'C', required: false, answer: null },
  ];
  assert.deepEqual(unansweredRequired(qs).map(q => q.id), ['q2']);
});

test('prefillFromLibrary: fills by normalized label, validates select options', () => {
  const qs = [
    { id: 'q1', label: 'Wie viele Jahre Erfahrung?', type: 'number', options: null, required: true, answer: null },
    { id: 'q2', label: 'Führerschein?', type: 'select', options: ['Ja', 'Nein'], required: true, answer: null },
    { id: 'q3', label: 'Notice period', type: 'select', options: ['1 Monat', '3 Monate'], required: true, answer: null },
  ];
  const library = [
    { question_key: normalizeQuestionKey('Wie viele Jahre Erfahrung'), answer: '5' },
    { question_key: normalizeQuestionKey('Führerschein?'), answer: 'ja' },           // case-insensitive option match
    { question_key: normalizeQuestionKey('Notice period'), answer: '2 Wochen' },     // no longer a valid option
  ];
  const filled = prefillFromLibrary(qs, library);
  assert.equal(filled, 2);
  assert.equal(qs[0].answer, '5');
  assert.equal(qs[0].answeredVia, 'library');
  assert.equal(qs[1].answer, 'Ja', 'library answer mapped onto the exact option casing');
  assert.equal(qs[2].answer, null, 'stale select answer NOT prefilled');
});

test('libraryRowsFromQuestions: only answered questions become library rows', () => {
  const qs = [
    { id: 'q1', label: 'Gehalt?', type: 'text', options: null, answer: '55000' },
    { id: 'q2', label: 'Offen', type: 'text', options: null, answer: null },
    { id: 'q3', label: 'Erfahrung', type: 'select', options: ['0-2', '3-5'], answer: '3-5' },
  ];
  const rows = libraryRowsFromQuestions(qs);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].question_key, 'gehalt');
  assert.deepEqual(JSON.parse(rows[1].options_json), ['0-2', '3-5']);
});

test('parseQuestions: tolerates broken/missing JSON', () => {
  assert.deepEqual(parseQuestions(null), []);
  assert.deepEqual(parseQuestions('kaputt'), []);
  assert.deepEqual(parseQuestions('{"not":"array"}'), []);
  assert.equal(parseQuestions('[{"id":"q1"}]').length, 1);
});

// ── Checkboxes (#20) ─────────────────────────────────────────────────────────
// A required consent checkbox had no producer: it was never harvested, so the
// application went to review "complete" and failed at submit every time.
const { hasChoices, isTickAnswer, CHECKBOX_OPTIONS } = await import('../src/questions.js');
const { fieldsToQuestions, fillAnswerInPage, fillAnswers } = await import('../src/appliers/common.js');

test('a harvested checkbox becomes a Ja/Nein choice question', () => {
  const qs = fieldsToQuestions([
    { kind: 'checkbox', label: 'Ich stimme der Datenschutzerklärung zu', options: ['Ja', 'Nein'], required: true, answered: false },
    { kind: 'checkbox', label: 'Schon angehakt', options: ['Ja', 'Nein'], required: true, answered: true },
  ]);
  assert.equal(qs.length, 1, 'a ticked box needs no answer');
  assert.equal(qs[0].type, 'checkbox');
  assert.deepEqual(qs[0].options, CHECKBOX_OPTIONS);
  assert.equal(hasChoices(qs[0]), true);
  assert.deepEqual(unansweredRequired(qs).map(q => q.label), ['Ich stimme der Datenschutzerklärung zu']);
});

test('checkbox answers must be one of Ja/Nein, case-insensitive', () => {
  const qs = [{ id: 'q1', label: 'Einwilligung', type: 'checkbox', options: ['Ja', 'Nein'], required: true, answer: null }];
  assert.equal(applyAnswer(qs, 'q1', 'vielleicht', 'gui'), false);
  assert.equal(applyAnswer(qs, 'q1', 'ja', 'telegram'), true);
  assert.equal(qs[0].answer, 'Ja');
  assert.equal(unansweredRequired(qs).length, 0);
});

test('a library answer only prefills a checkbox when it is Ja or Nein', () => {
  const qs = [
    { id: 'q1', label: 'Einwilligung Datenschutz', type: 'checkbox', options: ['Ja', 'Nein'], answer: null },
    { id: 'q2', label: 'Newsletter', type: 'checkbox', options: ['Ja', 'Nein'], answer: null },
  ];
  prefillFromLibrary(qs, [
    { question_key: 'einwilligung datenschutz', answer: 'ja' },
    { question_key: 'newsletter', answer: 'max@example.org' },
  ]);
  assert.equal(qs[0].answer, 'Ja');
  assert.equal(qs[1].answer, null);
});

test('isTickAnswer and the in-page fill agree on what ticks a box', () => {
  for (const v of ['Ja', 'yes', 'true', '1', 'x', '✓', 'an']) assert.equal(isTickAnswer(v), true, v);
  for (const v of ['Nein', 'no', 'false', '0', 'aus', '', null]) assert.equal(isTickAnswer(v), false, String(v));
  // fillAnswerInPage runs in the browser and can't import isTickAnswer — keep
  // its yes-pattern identical.
  assert.ok(fillAnswerInPage.toString().includes('/^(ja|yes|y|true|1|x|✓|✔|checked|an|on)$/i'));
  assert.ok(isTickAnswer.toString().includes('/^(ja|yes|y|true|1|x|✓|✔|checked|an|on)$/i'));
});

test('fillAnswers hands each question its type, so only checkbox questions touch checkboxes', async () => {
  const calls = [];
  const page = {
    evaluate: async (fn, args) => { calls.push(args); return true; },
    waitForTimeout: async () => {},
  };
  await fillAnswers(page, [
    { label: 'Berufserfahrung (Jahre)', type: 'number', answer: '1' },
    { label: 'Ich akzeptiere die AGB', type: 'checkbox', answer: 'Ja' },
    { label: 'Ohne Antwort', type: 'text', answer: null },
  ]);
  assert.deepEqual(calls.map(c => [c.label, c.type, c.value]), [
    ['Berufserfahrung (Jahre)', 'number', '1'],
    ['Ich akzeptiere die AGB', 'checkbox', 'Ja'],
  ]);
});
