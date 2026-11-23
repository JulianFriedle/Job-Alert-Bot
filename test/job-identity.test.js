import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idTokens, createCrossChannelDedup } from '../src/job-identity.js';

const PAGE = 'https://careers.rolls-royce.com/de/stellenangebote/head-of-component-engineering/JR6162978';
const APPLY = 'https://rollsroyce.wd3.myworkdayjobs.com/professional/job/Derby/Head-of-Component-Engineering_JR6162978-1/apply';

test('idTokens: requisition and numeric IDs from path and query, not words, years or locales', () => {
  assert.deepEqual(idTokens(PAGE), ['JR6162978']);
  assert.deepEqual(idTokens(APPLY), ['JR6162978']);
  assert.deepEqual(idTokens('https://x.de/JobDescription/?jobId=2090415&locale=de_DE'), ['2090415']);
  assert.deepEqual(idTokens('https://x.de/jobs/2026/werkstudent-p2'), []);
  assert.deepEqual(idTokens('not a url'), []);
});

test('page link and API apply link of the same posting are one job', () => {
  const isDup = createCrossChannelDedup();
  assert.equal(isDup(PAGE, 'dom'), false);
  assert.equal(isDup(APPLY, 'api'), true);
});

test('works in either order: API first, page link second', () => {
  const isDup = createCrossChannelDedup();
  assert.equal(isDup(APPLY, 'api'), false);
  assert.equal(isDup(PAGE, 'dom'), true);
});

test('never merges two links of the same channel by token', () => {
  const isDup = createCrossChannelDedup();
  assert.equal(isDup('https://x.de/job/a/123456', 'dom'), false);
  assert.equal(isDup('https://x.de/job/b/123456', 'dom'), false);
});

test('a token in several URLs of one channel is no posting ID (tenant / site IDs)', () => {
  const isDup = createCrossChannelDedup();
  isDup('https://x.de/c/T99999/job/1111111', 'dom');
  isDup('https://x.de/c/T99999/job/2222222', 'dom');
  // Shares only the tenant token with the page links: a different posting.
  assert.equal(isDup('https://ats.example/T99999/apply/3333333', 'api'), false);
  // Shares the posting ID: the same posting.
  assert.equal(isDup('https://ats.example/T99999/apply/2222222', 'api'), true);
});

test('URLs without ID tokens are never treated as duplicates', () => {
  const isDup = createCrossChannelDedup();
  assert.equal(isDup('https://x.de/jobs/werkstudent-marketing', 'dom'), false);
  assert.equal(isDup('https://y.de/apply/werkstudent-marketing', 'api'), false);
});
