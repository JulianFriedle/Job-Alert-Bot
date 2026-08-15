// Cooperative abort: the flag itself, and that the scrape loop honours it.
import test from 'node:test';
import assert from 'node:assert/strict';

import { isAborted, requestAbort, onAbort, resetAbort } from '../src/run-control.js';
import { scrapeAll } from '../src/scraper.js';

test('requestAbort flips the flag exactly once and notifies listeners', (t) => {
  t.after(resetAbort);
  let calls = 0;
  onAbort(() => { calls++; });

  assert.equal(isAborted(), false);
  assert.equal(requestAbort(), true, 'first request wins');
  assert.equal(isAborted(), true);
  assert.equal(requestAbort(), false, 'second SIGTERM must not re-notify');
  assert.equal(calls, 1);
});

test('a throwing listener does not block the others', (t) => {
  t.after(resetAbort);
  const seen = [];
  onAbort(() => { throw new Error('boom'); });
  onAbort(() => seen.push('second'));

  requestAbort();
  assert.deepEqual(seen, ['second']);
});

test('onAbort unsubscribe stops later notifications', (t) => {
  t.after(resetAbort);
  let calls = 0;
  const off = onAbort(() => { calls++; });
  off();

  requestAbort();
  assert.equal(calls, 0);
});

test('scrapeAll skips every source once aborted (no browser is launched)', async (t) => {
  t.after(resetAbort);
  requestAbort();

  const sources = [
    { name: 'A', url: 'https://example.invalid/jobs', type: 'careers-page' },
    { name: 'B', url: 'https://example.invalid/karriere', type: 'careers-page' },
  ];
  // Would need a real browser and reach the network if the abort were ignored.
  const { jobs, stats } = await scrapeAll(sources);
  assert.deepEqual(jobs, []);
  assert.deepEqual(stats, {});
});
