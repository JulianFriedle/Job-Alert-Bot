// Jobs whose description is a cookie banner or an error page must not reach
// Claude (#40): they wait, get their detail page fetched again on later runs,
// and are given up after MAX_DESC_ATTEMPTS. No browser here — the fetch is a
// stand-in that calls onJob like fetchDescriptions does.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.JOBS_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'jobbot-thin-')), 'test.db');

import test from 'node:test';
import assert from 'node:assert/strict';

const db = await import('../src/database.js');
const { minDescriptionChars, isThinDescription, DEFAULT_MIN_DESCRIPTION_CHARS } = await import('../src/scraper.js');
const { settleThinDescriptions, MAX_DESC_ATTEMPTS, DESC_MISSING_SUMMARY } = await import('../src/scheduler.js');

const C = 'default';
const LONG = 'Wir suchen eine engagierte Fachkraft. '.repeat(20);
const BANNER = 'Wir verwenden Cookies, um Ihnen das beste Erlebnis zu bieten. Alle akzeptieren';

let n = 0;
function seed(description, extra = {}) {
  const id = `thin-${++n}`;
  db.saveJob(C, { id, title: `Job ${n}`, company: 'ACME', url: `https://acme.example/jobs/${n}`, location: '', description, source: 'ACME', ...extra });
  return id;
}
const unanalyzed = (ids) => db.getUnanalyzedJobs(C).filter(j => ids.includes(j.id));

// Stand-in for fetchDescriptions: hands out the given text per job id.
function fakeFetch(texts) {
  const calls = [];
  const fetch = async (jobs, { onJob }) => {
    calls.push(jobs.map(j => j.id));
    for (const job of jobs) {
      if (job.id in texts) job.description = texts[job.id];
      onJob(job);
    }
  };
  return { fetch, calls };
}

test('MIN_DESCRIPTION_CHARS: blank or invalid → default, 0 → off', () => {
  const saved = process.env.MIN_DESCRIPTION_CHARS;
  try {
    for (const v of [undefined, '', '  ', 'abc', '-5']) {
      if (v === undefined) delete process.env.MIN_DESCRIPTION_CHARS; else process.env.MIN_DESCRIPTION_CHARS = v;
      assert.equal(minDescriptionChars(), DEFAULT_MIN_DESCRIPTION_CHARS, String(v));
    }
    process.env.MIN_DESCRIPTION_CHARS = '0';
    assert.equal(minDescriptionChars(), 0);
    process.env.MIN_DESCRIPTION_CHARS = ' 120 ';
    assert.equal(minDescriptionChars(), 120);
  } finally {
    if (saved === undefined) delete process.env.MIN_DESCRIPTION_CHARS; else process.env.MIN_DESCRIPTION_CHARS = saved;
  }
  assert.equal(isThinDescription(BANNER, 300), true);
  assert.equal(isThinDescription(`   ${'x'.repeat(299)}   `, 300), true, 'whitespace does not count');
  assert.equal(isThinDescription(LONG, 300), false);
  assert.equal(isThinDescription(null, 300), true);
});

test('jobs fetched this run wait; long descriptions go straight through', async () => {
  const ok = seed(LONG);
  const fresh = seed(BANNER);
  const { fetch, calls } = fakeFetch({});
  const res = await settleThinDescriptions(C, unanalyzed([ok, fresh]), new Set([ok, fresh]), { fetch, minChars: 300 });
  assert.deepEqual(res.ready.map(j => j.id), [ok]);
  assert.equal(res.total, 1);
  assert.equal(calls.length, 0, 'no refetch seconds after the first fetch');
  assert.equal(db.getJobById(C, fresh).relevant, null, 'still unanalyzed');
});

test('an older thin job is fetched again and analyzed once the text is there', async () => {
  const id = seed(BANNER);
  const { fetch, calls } = fakeFetch({ [id]: LONG });
  const res = await settleThinDescriptions(C, unanalyzed([id]), new Set(), { fetch, minChars: 300 });
  assert.deepEqual(calls, [[id]]);
  assert.deepEqual(res.ready.map(j => j.id), [id]);
  assert.equal(res.recovered, 1);
  const row = db.getJobById(C, id);
  assert.equal(row.description, LONG, 'the new text is stored');
  assert.equal(row.desc_attempts, 1);
});

test('a refetch that comes back shorter never replaces the stored text', async () => {
  const id = seed(BANNER);
  const { fetch } = fakeFetch({ [id]: '' });
  await settleThinDescriptions(C, unanalyzed([id]), new Set(), { fetch, minChars: 300 });
  assert.equal(db.getJobById(C, id).description, BANNER);
});

test(`after ${MAX_DESC_ATTEMPTS} failed refetches the job is given up, not analyzed`, async () => {
  const id = seed(BANNER);
  const { fetch, calls } = fakeFetch({});
  for (let run = 1; run <= MAX_DESC_ATTEMPTS; run++) {
    const res = await settleThinDescriptions(C, unanalyzed([id]), new Set(), { fetch, minChars: 300 });
    assert.equal(res.ready.length, 0);
    assert.equal(res.gaveUp, run === MAX_DESC_ATTEMPTS ? 1 : 0, `run ${run}`);
  }
  assert.equal(calls.length, MAX_DESC_ATTEMPTS);
  const row = db.getJobById(C, id);
  assert.equal(row.relevant, 0);
  assert.equal(row.summary, DESC_MISSING_SUMMARY);
  assert.equal(unanalyzed([id]).length, 0, 'never comes back for analysis');
});

test('minChars 0 turns the check off', async () => {
  const id = seed(BANNER);
  const { fetch, calls } = fakeFetch({});
  const res = await settleThinDescriptions(C, unanalyzed([id]), new Set(), { fetch, minChars: 0 });
  assert.deepEqual(res.ready.map(j => j.id), [id]);
  assert.equal(calls.length, 0);
});

test('the refetch script finds too-short descriptions, not only empty ones', () => {
  const empty = seed('');
  const thin = seed(BANNER);
  const long = seed(LONG);
  const found = (min) => db.getJobsWithEmptyDescription(C, min).map(j => j.id);
  assert.ok(found(300).includes(empty) && found(300).includes(thin));
  assert.ok(!found(300).includes(long));
  assert.ok(found(0).includes(empty) && !found(0).includes(thin), '0 = only empty ones');
});

test('desc_attempts is scoped by client', () => {
  db.saveJob('other', { id: 'shared-id', title: 'T', company: 'C', url: 'https://x.example/1', location: '', description: BANNER, source: 's' });
  db.saveJob(C, { id: 'shared-id', title: 'T', company: 'C', url: 'https://x.example/1', location: '', description: BANNER, source: 's' });
  db.recordDescriptionAttempt('other', 'shared-id', LONG);
  assert.equal(db.getJobById('other', 'shared-id').desc_attempts, 1);
  assert.equal(db.getJobById(C, 'shared-id').desc_attempts, 0);
  assert.equal(db.getJobById(C, 'shared-id').description, BANNER);
});
