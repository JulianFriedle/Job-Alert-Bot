// GitHub problem reports for failed/empty sources: classification, the privacy
// scrubbing (the target repo is public), the pre-filled issue URL, and the
// client-scoped DB lookup behind it. Offline — the DB is a throwaway file.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.JOBS_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'jobbot-report-')), 'test.db');

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  classifySourceProblem, sanitizeUrl, sanitizeText, buildSourceReport,
  buildIssueUrl, issueRepo, DEFAULT_ISSUE_REPO, ISSUE_TEMPLATE,
} = await import('../src/source-report.js');
const db = await import('../src/database.js');

test('classifySourceProblem: error > blocked > empty > fine', () => {
  assert.equal(classifySourceProblem({ found: 0, blocked: true, error: 'boom' }), 'error');
  assert.equal(classifySourceProblem({ found: 3, blocked: true }), 'blocked');
  assert.equal(classifySourceProblem({ found: 0 }), 'empty');
  assert.equal(classifySourceProblem({}), 'empty');
  assert.equal(classifySourceProblem({ found: 5 }), null);
});

test('sanitizeUrl keeps origin + path only', () => {
  assert.equal(sanitizeUrl('https://user:pw@jobs.example.com/de/karriere?q=pm&loc=münchen#top'),
    'https://jobs.example.com/de/karriere');
  assert.equal(sanitizeUrl('javascript:alert(1)'), '');
  assert.equal(sanitizeUrl('not a url'), '');
});

test('sanitizeText scrubs URL queries and home directories from error messages', () => {
  const msg = 'page.goto: net::ERR_TIMED_OUT at https://x.de/jobs?keywords=secret in /home/julian/bot/src/x.js';
  const out = sanitizeText(msg);
  assert.ok(!out.includes('secret'));
  assert.ok(!out.includes('julian'));
  assert.ok(out.includes('https://x.de/jobs'));
});

test('platform sources are reported by type, never with name or search terms', () => {
  const source = { name: 'LinkedIn – Projektleiter München', type: 'linkedin', search: { keywords: 'Projektleiter', location: 'München' } };
  const r = buildSourceReport({
    source,
    row: { source: source.name, found: 0, problem: 'blocked', error: null },
    run: { id: 1, ranAt: '2026-11-13T10:00:00Z' },
  });
  const all = r.title + JSON.stringify(r.fields);
  assert.ok(!all.includes('Projektleiter'));
  assert.ok(!all.includes('München'));
  assert.equal(r.fields.source, 'linkedin');
});

test('a source removed since the run is reported without its stored name', () => {
  // It may have been a platform search, whose name carries the search terms.
  const r = buildSourceReport({
    source: undefined,
    row: { source: 'LinkedIn – Projektleiter München', found: 0, problem: 'empty', error: null },
    run: { id: 1, ranAt: '2026-11-13T10:00:00Z' },
  });
  const all = r.title + JSON.stringify(r.fields);
  assert.ok(!all.includes('Projektleiter'));
  assert.ok(!all.includes('München'));
  assert.equal(r.fields.source, 'entfernte Quelle');
});

test('career-page report carries URL (no query), error, history and safe config only', () => {
  const source = { name: 'ACME', url: 'https://acme.de/jobs?session=abc', paginationMode: 'param', paginationParam: 'page', secretThing: 'x' };
  const r = buildSourceReport({
    source,
    row: { source: 'ACME', found: 0, siteTotal: 12, problem: 'empty', error: null },
    run: { id: 3, ranAt: '2026-11-13T10:00:00Z' },
    history: [{ found: 0, problem: 'empty' }, { found: 12, problem: null }, { found: 3, problem: 'error' }],
    version: '2.0.4',
  });
  const d = r.fields.diagnose;
  assert.match(r.title, /^\[Scraper\] ACME: 0 Stellen gefunden$/);
  assert.ok(d.includes('https://acme.de/jobs'));
  assert.ok(!d.includes('session=abc'));
  assert.ok(d.includes('Website meldet 12'));
  assert.ok(d.includes('0 ← 12 ← 3!'));
  assert.ok(d.includes('paginationParam'));
  assert.ok(!d.includes('secretThing'));
  assert.ok(d.includes('2.0.4'));
});

test('buildIssueUrl targets the issue form with fields as query params, and stays short', () => {
  const url = new URL(buildIssueUrl('owner/repo', { title: 'T', fields: { source: 'S', diagnose: 'D' } }));
  assert.equal(url.origin + url.pathname, 'https://github.com/owner/repo/issues/new');
  assert.equal(url.searchParams.get('template'), ISSUE_TEMPLATE);
  assert.equal(url.searchParams.get('source'), 'S');
  assert.equal(url.searchParams.get('diagnose'), 'D');

  const long = buildIssueUrl('owner/repo', { title: 'T', fields: { source: 'S', diagnose: 'ä|'.repeat(10000) } });
  assert.ok(long.length <= 7500, `URL too long: ${long.length}`);
  assert.ok(new URL(long).searchParams.get('diagnose').endsWith('…(gekürzt)'));
});

test('issueRepo falls back to the default for empty or malformed values', () => {
  assert.equal(issueRepo({}), DEFAULT_ISSUE_REPO);
  assert.equal(issueRepo({ ISSUE_REPO: 'evil.com/x/y' }), DEFAULT_ISSUE_REPO);
  assert.equal(issueRepo({ ISSUE_REPO: ' me/fork ' }), 'me/fork');
});

test('run snapshot persists problem + error; report lookup is client-scoped', () => {
  db.createClient({ id: 'other', name: 'Other' });
  const runId = db.saveRunSnapshot('default', [
    { source: 'ACME', found: 0, problem: 'error', error: 'Timeout' },
    { source: 'Fine', found: 4, problem: null },
  ]);
  const [run] = db.getRecentRuns('default', 1);
  const acme = run.rows.find(r => r.source === 'ACME');
  assert.equal(acme.problem, 'error');
  assert.equal(acme.error, 'Timeout');
  assert.equal(run.rows.find(r => r.source === 'Fine').problem, null);

  const rep = db.getRunSourceReport('default', runId, 'ACME');
  assert.equal(rep.row.error, 'Timeout');
  assert.equal(rep.history.length, 1);
  assert.equal(db.getRunSourceReport('other', runId, 'ACME'), null, 'another client must not see this run');
  assert.equal(db.getRunSourceReport('default', runId, 'Missing'), null);
});
