// One misbehaving career page used to hold the whole scrape phase (#41):
// Diehl paginated past page 40 with 30 s timeouts, Liebherr reset every
// connection from page 3 on. The guard decides when to stop — without quietly
// cutting off jobs.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createPaginationGuard } from '../src/pagination-guard.js';

// steps: Error = failed page; [added, extracted] = a page read.
const walk = (guard, steps) => {
  let fetched = 0;
  for (const step of steps) {
    if (!guard.canFetch()) break;
    fetched++;
    if (step instanceof Error) guard.error(step);
    else guard.page(...step);
  }
  return fetched;
};
const timeout = () => new Error('page.goto: Timeout 30000ms exceeded.');
const reset = () => new Error('page.goto: net::ERR_CONNECTION_RESET at https://jobs.example/?p=3');

test('no page limit unless the source sets one', () => {
  assert.equal(walk(createPaginationGuard(), Array(150).fill([5, 5])), 150);
  const g = createPaginationGuard({ maxPages: 5 });
  assert.equal(walk(g, Array(20).fill([3, 3])), 4, 'pages 2–5 after page 1');
  assert.match(g.stopReason, /Seitenlimit/);
  assert.equal(g.problem, null);
});

test('a page of already-seen jobs is not empty; a page without any jobs is', () => {
  const sticky = createPaginationGuard({ maxEmpty: 3 });
  assert.equal(walk(sticky, [[0, 10], [0, 10], [0, 10], [0, 10], [4, 10]]), 5, 'sticky jobs don\'t stop it');
  assert.equal(sticky.stopReason, null);
  const past = createPaginationGuard({ maxEmpty: 3 });
  assert.equal(walk(past, [[5, 5], [0, 0], [0, 0], [0, 0], [9, 9]]), 4);
  assert.match(past.stopReason, /3 Seiten in Folge ohne Stellen/);
  assert.equal(past.problem, null);
});

test('load-more steps (extracted = null) are never judged empty', () => {
  const g = createPaginationGuard({ maxEmpty: 1 });
  assert.equal(walk(g, [[0, null], [0, null], [3, null]]), 3);
  assert.equal(g.stopReason, null);
});

test('refused connections stop the source and mark the result incomplete', () => {
  const g = createPaginationGuard({ maxRefused: 2 });
  assert.equal(walk(g, [[5, 5], reset(), [4, 4], reset(), [7, 7]]), 4);
  assert.match(g.problem, /Host bricht Verbindungen ab \(ERR_CONNECTION_RESET\)/);
});

test('a failure streak ends pagination with unread pages: incomplete; a recovered failure is not', () => {
  const g = createPaginationGuard({ maxErrors: 3 });
  assert.equal(walk(g, [timeout(), timeout(), [2, 2], timeout(), timeout(), [1, 1]]), 6, 'never three in a row');
  assert.equal(g.stopReason, null);
  assert.equal(g.problem, null);
  const h = createPaginationGuard({ maxErrors: 3 });
  assert.equal(walk(h, [timeout(), timeout(), timeout(), [1, 1]]), 3);
  assert.match(h.problem, /3 Seiten in Folge fehlgeschlagen/);
});

test('giving up after a failure marks the result incomplete', () => {
  const g = createPaginationGuard();
  g.giveUp('Azure-Seite 3 fehlgeschlagen');
  assert.equal(g.canFetch(), false);
  assert.match(g.problem, /Azure-Seite 3/);
});

test('the first reason sticks', () => {
  const g = createPaginationGuard({ maxPages: 3, maxEmpty: 1 });
  g.page(0, 0);
  assert.match(g.stopReason, /ohne Stellen/);
  assert.equal(g.canFetch(), false);
  assert.match(g.stopReason, /ohne Stellen/, 'not overwritten by the page limit');
});

test('a failure on the last page read is visible to the caller', () => {
  const g = createPaginationGuard();
  walk(g, [[3, 3], timeout()]);
  assert.equal(g.trailingFailure, true);
  g.page(2, 2);
  assert.equal(g.trailingFailure, false, 'a later success clears it');
});
