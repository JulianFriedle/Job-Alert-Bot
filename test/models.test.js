// Model defaults live in src/models.js; the docs must show the same values, and
// an unknown model ID must fail fast instead of retrying every job.
// analyzer.js pulls in database.js, which opens the DB at import time — point it
// at a throwaway file first (same pattern as db.test.js).
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.JOBS_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'jobbot-models-')), 'test.db');

import test from 'node:test';
import assert from 'node:assert/strict';

const { DEFAULT_ANALYZER_MODEL, DEFAULT_WRITER_MODEL, analyzerModel, writerModel } = await import('../src/models.js');

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

test('unset or blank model settings fall back to the defaults', () => {
  for (const v of [undefined, '', '   ']) {
    withEnv({ ANALYZER_MODEL: v, COVER_LETTER_MODEL: v }, () => {
      assert.equal(analyzerModel(), DEFAULT_ANALYZER_MODEL);
      assert.equal(writerModel(), DEFAULT_WRITER_MODEL);
    });
  }
});

test('a configured model wins and is trimmed', () => {
  withEnv({ ANALYZER_MODEL: ' claude-x ', COVER_LETTER_MODEL: 'claude-y' }, () => {
    assert.equal(analyzerModel(), 'claude-x');
    assert.equal(writerModel(), 'claude-y');
  });
});

test('.env.example and the README show the current defaults', () => {
  const root = new URL('../', import.meta.url);
  const env = readFileSync(new URL('.env.example', root), 'utf8');
  const readme = readFileSync(new URL('README.md', root), 'utf8');
  assert.match(env, new RegExp(`^# ANALYZER_MODEL=${DEFAULT_ANALYZER_MODEL}$`, 'm'));
  assert.match(env, new RegExp(`^# COVER_LETTER_MODEL=${DEFAULT_WRITER_MODEL}$`, 'm'));
  assert.match(readme, new RegExp(`\\| \`ANALYZER_MODEL\` \\| \`${DEFAULT_ANALYZER_MODEL}\` \\|`));
  assert.match(readme, new RegExp(`\\| \`COVER_LETTER_MODEL\` \\| \`${DEFAULT_WRITER_MODEL}\` \\|`));
});

test('docker-compose leaves the model default to the app', () => {
  // A hard-coded fallback there always wins over src/models.js and goes stale.
  const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  const lines = compose.split('\n').filter(l => /(ANALYZER|COVER_LETTER)_MODEL:/.test(l));
  assert.ok(lines.length > 0);
  for (const l of lines) assert.match(l, /:-\}"\s*$/, l);
});

test('an unknown analyzer model is reported once and never retried', async () => {
  // A local stand-in for the Messages API that knows no models — no network.
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      requests.push(JSON.parse(body));
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'model: claude-gone' } }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.ANALYZER_MODEL = 'claude-gone';
    const { analyzeJob } = await import('../src/analyzer.js');
    const cfg = { profile: {}, prompts: { analyzerSystem: 's', analyzerInstructions: 'i' }, minRelevanceScore: 5 };
    const job = { id: 'x', title: 'Ingenieur', company: 'ACME', location: 'Ulm', description: 'd' };

    assert.equal(await analyzeJob(job, cfg), null);
    assert.equal(await analyzeJob({ ...job, id: 'y' }, cfg), null);

    assert.equal(requests.length, 2, 'one request per job, no retries');
    assert.equal(requests[0].model, 'claude-gone');
    assert.equal(logs.filter(l => l.includes('claude-gone') && l.includes('FEHLER')).length, 1, 'reported once');
  } finally {
    console.log = origLog;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANALYZER_MODEL;
    server.closeAllConnections();
    server.close();
  }
});

// ── Model dropdown (#43) ─────────────────────────────────────────────────────
const { listAvailableModels } = await import('../src/models.js');

test('available models: newest first, cached per key for an hour, no key = error', async () => {
  let calls = 0;
  const makeClient = () => ({ models: { list: async function* () {
    calls++;
    yield { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', created_at: '2025-10-01T00:00:00Z' };
    yield { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-10-01T00:00:00Z' };
    yield { display_name: 'kaputt ohne id' };
  } } });
  let t = 1_000_000;
  const now = () => t;
  const a = await listAvailableModels({ apiKey: 'sk-test-1', makeClient, now });
  assert.deepEqual(a.map(m => m.id), ['claude-opus-5-5', 'claude-haiku-4-5']);
  assert.equal(a[0].name, 'Claude Opus 5.5');
  await listAvailableModels({ apiKey: 'sk-test-1', makeClient, now });
  assert.equal(calls, 1, 'cached');
  t += 61 * 60 * 1000;
  await listAvailableModels({ apiKey: 'sk-test-1', makeClient, now });
  assert.equal(calls, 2, 'refreshed after an hour');
  await listAvailableModels({ apiKey: 'sk-test-2', makeClient, now });
  assert.equal(calls, 3, 'another key, its own list');
  await assert.rejects(listAvailableModels({ apiKey: '  ', makeClient, now }), /Kein Anthropic API-Key/);
});
