// The point of the limiter is a property that is easy to state and easy to break:
// one request per host at a time, with a real pause between them, while the pool
// stays busy on other hosts. Every test below asserts that property directly from
// a recorded call log rather than from timings alone.
import test from 'node:test';
import assert from 'node:assert/strict';

import { registrableDomain, runHostLimited } from '../src/host-limiter.js';

const GAP = 40;

// Record start/end of every call so overlaps and gaps can be checked after the fact.
function recorder(workMs = 10) {
  const calls = [];
  const handler = async (item, index, host) => {
    const entry = { item, index, host, start: Date.now(), end: 0 };
    calls.push(entry);
    await new Promise(r => setTimeout(r, workMs));
    entry.end = Date.now();
  };
  return { calls, handler };
}

function assertNoHostOverlap(calls) {
  const byHost = new Map();
  for (const c of calls) {
    if (!byHost.has(c.host)) byHost.set(c.host, []);
    byHost.get(c.host).push(c);
  }
  for (const [host, entries] of byHost) {
    entries.sort((a, b) => a.start - b.start);
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1];
      const cur = entries[i];
      assert.ok(cur.start >= prev.end, `${host}: request ${i} started before the previous one finished`);
      // Timer granularity: allow a few ms of slack on the gap itself.
      assert.ok(cur.start - prev.end >= GAP - 5,
        `${host}: only ${cur.start - prev.end}ms between requests, expected ≥${GAP}ms`);
    }
  }
}

test('registrableDomain collapses subdomains onto the operator that rate-limits', () => {
  assert.equal(registrableDomain('https://karriere.bosch.de/jobs?page=2'), 'bosch.de');
  assert.equal(registrableDomain('https://jobs.sick.com/job/123'), 'sick.com');
  assert.equal(registrableDomain('https://example.com/x'), 'example.com');
  // Shared ATS tenants must land in one bucket — that is the case a per-hostname
  // key would get wrong, and the host most likely to throttle centrally.
  assert.equal(
    registrableDomain('https://acme.jobs.personio.de/job/1'),
    registrableDomain('https://beta.jobs.personio.de/job/9'),
  );
  assert.equal(registrableDomain('https://ag.wd3.myworkdayjobs.com/de/x'), 'myworkdayjobs.com');
});

test('registrableDomain keeps multi-part suffixes and odd hosts intact', () => {
  assert.equal(registrableDomain('https://jobs.acme.co.uk/x'), 'acme.co.uk');
  assert.equal(registrableDomain('https://careers.acme.com.au/x'), 'acme.com.au');
  assert.equal(registrableDomain('http://192.168.1.10:8080/x'), '192.168.1.10');
  assert.equal(registrableDomain('not a url'), 'not a url');
  assert.equal(registrableDomain(null), '');
});

test('one request per host at a time, with the full gap between them', async () => {
  const jobs = [
    'https://a.com/1', 'https://a.com/2', 'https://a.com/3',
    'https://b.com/1', 'https://b.com/2', 'https://b.com/3',
    'https://c.com/1', 'https://c.com/2', 'https://c.com/3',
  ];
  const { calls, handler } = recorder();

  await runHostLimited(jobs, handler, { concurrency: 9, perHost: 1, minGapMs: GAP, jitterMs: 0 });

  assert.equal(calls.length, jobs.length);
  assert.deepEqual([...calls.map(c => c.item)].sort(), [...jobs].sort());
  assertNoHostOverlap(calls);
});

test('hosts run in parallel — the pool does not idle through one host at a time', async () => {
  const jobs = ['https://a.com/1', 'https://a.com/2', 'https://b.com/1', 'https://b.com/2'];
  const { calls, handler } = recorder();

  const started = Date.now();
  await runHostLimited(jobs, handler, { concurrency: 4, perHost: 1, minGapMs: GAP, jitterMs: 0 });
  const elapsed = Date.now() - started;

  assertNoHostOverlap(calls);
  // Serialised across all four it would cost 3 gaps; interleaved it costs 1 per
  // host. Assert we are nearer the interleaved figure than the serial one.
  assert.ok(elapsed < GAP * 2.5, `took ${elapsed}ms — hosts were not overlapped`);

  // And the overlap is real: a.com and b.com were genuinely in flight together.
  const a = calls.find(c => c.host === 'a.com');
  const b = calls.find(c => c.host === 'b.com');
  assert.ok(a.start < b.end && b.start < a.end, 'the two hosts never overlapped');
});

test('a single host stays serial no matter how wide the pool is', async () => {
  const jobs = ['https://solo.de/1', 'https://solo.de/2', 'https://solo.de/3'];
  const { calls, handler } = recorder();

  const started = Date.now();
  await runHostLimited(jobs, handler, { concurrency: 16, perHost: 1, minGapMs: GAP, jitterMs: 0 });
  const elapsed = Date.now() - started;

  assert.equal(calls.length, 3);
  assertNoHostOverlap(calls);
  assert.ok(elapsed >= GAP * 2, `took only ${elapsed}ms — the gaps were skipped`);
});

test('per-host order is preserved and keyOf drives the bucketing', async () => {
  const jobs = [
    { id: 1, url: 'https://a.com/1' },
    { id: 2, url: 'https://b.com/1' },
    { id: 3, url: 'https://a.com/2' },
    { id: 4, url: 'https://a.com/3' },
  ];
  const { calls, handler } = recorder(1);

  await runHostLimited(jobs, handler, {
    keyOf: (job) => registrableDomain(job.url),
    concurrency: 4, perHost: 1, minGapMs: GAP, jitterMs: 0,
  });

  const aOrder = calls.filter(c => c.host === 'a.com').map(c => c.item.id);
  assert.deepEqual(aOrder, [1, 3, 4]);
  // The index handed to the handler stays the item's original position.
  assert.deepEqual(calls.map(c => c.item.id).sort(), calls.map(c => jobs[c.index].id).sort());
});

test('a failing item releases its host slot instead of stranding the queue', async () => {
  const jobs = ['https://a.com/boom', 'https://a.com/ok', 'https://b.com/ok'];
  const seen = [];

  const { errors } = await runHostLimited(jobs, async (url) => {
    seen.push(url);
    if (url.endsWith('boom')) throw new Error('detail page exploded');
  }, { concurrency: 4, perHost: 1, minGapMs: 5, jitterMs: 0 });

  assert.equal(seen.length, 3, 'the failure stalled the remaining items');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /exploded/);
});

test('an empty list is a no-op', async () => {
  const result = await runHostLimited([], async () => { throw new Error('must not run'); }, {});
  assert.deepEqual(result, { errors: [], hosts: 0, largestHost: 0 });
});
