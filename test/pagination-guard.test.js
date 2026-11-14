// One misbehaving career page used to hold the whole scrape phase (#41):
// Diehl paginated past page 40 with 30 s timeouts, Liebherr reset every
// connection from page 3 on. The guard decides when to stop.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createPaginationGuard, DEFAULT_MAX_PAGES } from '../src/pagination-guard.js';

const walk = (guard, steps) => {
  let fetched = 0;
  for (const step of steps) {
    if (!guard.canFetch()) break;
    fetched++;
    if (step instanceof Error) guard.error(step); else guard.page(step);
  }
  return fetched;
};

test('stops at the page limit, without calling it a problem', () => {
  const g = createPaginationGuard({ maxPages: 5 });
  assert.equal(walk(g, Array(20).fill(3)), 4, 'pages 2–5 after page 1');
  assert.match(g.stopReason, /Seitenlimit/);
  assert.equal(g.problem, null);
  assert.equal(createPaginationGuard().canFetch(), true);
  assert.equal(DEFAULT_MAX_PAGES, 50);
});

test('stops after a streak of pages without new jobs — a normal end', () => {
  const g = createPaginationGuard({ maxEmpty: 3 });
  assert.equal(walk(g, [5, 0, 0, 4, 0, 0, 0, 9, 9]), 7);
  assert.match(g.stopReason, /3 Seiten in Folge ohne neue Stellen/);
  assert.equal(g.problem, null);
});

test('refused connections stop the source and mark the result incomplete', () => {
  const g = createPaginationGuard({ maxRefused: 2 });
  const reset = new Error('page.goto: net::ERR_CONNECTION_RESET at https://jobs.example/?p=3');
  assert.equal(walk(g, [5, reset, 4, reset, 7, 7]), 4);
  assert.match(g.problem, /Host bricht Verbindungen ab \(ERR_CONNECTION_RESET\)/);
  assert.equal(g.stopReason, g.problem);
});

test('a streak of other failures stops too; a success in between resets it', () => {
  const g = createPaginationGuard({ maxErrors: 3 });
  const timeout = new Error('page.goto: Timeout 30000ms exceeded.');
  assert.equal(walk(g, [timeout, timeout, 2, timeout, timeout, 1, 1]), 7, 'never three in a row');
  assert.equal(g.problem, null);
  const h = createPaginationGuard({ maxErrors: 3 });
  assert.equal(walk(h, [timeout, timeout, timeout, 1]), 3);
  assert.match(h.problem, /3 Seiten in Folge fehlgeschlagen/);
});

test('the first reason sticks', () => {
  const g = createPaginationGuard({ maxPages: 3, maxEmpty: 1 });
  g.page(0);
  assert.match(g.stopReason, /ohne neue Stellen/);
  assert.equal(g.canFetch(), false);
  assert.match(g.stopReason, /ohne neue Stellen/, 'not overwritten by the page limit');
});
