// State machine + credentials round-trip against a throwaway SQLite DB.
// Env must be set BEFORE the modules are imported (they read it at load time).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.JOBS_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'jobbot-test-')), 'test.db');
process.env.CREDENTIALS_KEY = 'a'.repeat(64);

import test from 'node:test';
import assert from 'node:assert/strict';

const db = await import('../src/database.js');
const creds = await import('../src/credentials.js');

test('claimApplication: two claimants, exactly one wins', () => {
  const app = db.createApplication('default', 'job-race', 'stepstone');
  const gui = db.claimApplication(app.id, 'ready_for_review', 'approved'); // wrong from-state
  assert.equal(gui, false, 'claim from wrong state must fail');
  const a = db.claimApplication(app.id, 'queued', 'preparing');
  const b = db.claimApplication(app.id, 'queued', 'preparing');
  assert.equal(a, true);
  assert.equal(b, false, 'second claim loses the race');
  assert.equal(db.getApplicationById(app.id).state, 'preparing');
});

test('createApplication is idempotent per (client, job)', () => {
  const a = db.createApplication('default', 'job-dup', 'linkedin');
  const b = db.createApplication('default', 'job-dup', 'linkedin');
  assert.equal(a.id, b.id);
});

test('updateApplication cannot change state (whitelist)', () => {
  const app = db.createApplication('default', 'job-wl', 'indeed');
  db.updateApplication(app.id, { state: 'submitted', error: 'x' });
  const row = db.getApplicationById(app.id);
  assert.equal(row.state, 'queued', 'state untouched by updateApplication');
  assert.equal(row.error, 'x');
});

test('countSubmittedToday counts only today\'s submitted rows per platform', () => {
  const app = db.createApplication('default', 'job-count', 'stepstone');
  db.claimApplication(app.id, 'queued', 'submitting');
  db.claimApplication(app.id, 'submitting', 'submitted');
  db.updateApplication(app.id, { submitted_at: new Date().toISOString() });
  assert.equal(db.countSubmittedToday('default', 'stepstone'), 1);
  assert.equal(db.countSubmittedToday('default', 'linkedin'), 0);
});

test('credentials: encrypt/decrypt round-trip, wrong key fails', () => {
  const blob = creds.encrypt('geheim123!');
  assert.doesNotMatch(blob, /geheim/);
  assert.equal(creds.decrypt(blob), 'geheim123!');

  process.env.CREDENTIALS_KEY = 'b'.repeat(64);
  assert.throws(() => creds.decrypt(blob), /unable to authenticate|Unsupported state/i);
  process.env.CREDENTIALS_KEY = 'a'.repeat(64);
});

test('credentials: store/list/get per client+platform, password never listed', () => {
  creds.setPlatformCredentials('default', 'stepstone', 'jf@example.de', 'pw123');
  const status = creds.listCredentialStatus('default');
  const st = status.find(s => s.platform === 'stepstone');
  assert.equal(st.isSet, true);
  assert.equal(st.email, 'jf@example.de');
  assert.equal(Object.prototype.hasOwnProperty.call(st, 'password'), false);

  const full = creds.getPlatformCredentials('default', 'stepstone');
  assert.equal(full.password, 'pw123');

  // empty password on update keeps the stored one
  creds.setPlatformCredentials('default', 'stepstone', 'neu@example.de', null);
  const after = creds.getPlatformCredentials('default', 'stepstone');
  assert.equal(after.email, 'neu@example.de');
  assert.equal(after.password, 'pw123');
});

test('telegram correlation tables: prompts + messages round-trip', () => {
  const app = db.createApplication('default', 'job-tg', 'linkedin');
  db.recordTelegramPrompt('123', 42, app.id, 'q1');
  const p = db.getTelegramPrompt('123', 42);
  assert.equal(p.question_id, 'q1');
  assert.equal(db.getOpenTelegramPrompts('123').length, 1);
  db.closeTelegramPromptsForApplication(app.id);
  assert.equal(db.getOpenTelegramPrompts('123').length, 0);

  db.recordTelegramMessage('123', 99, 'default', 'job-tg', 'notification');
  assert.equal(db.getTelegramMessage('123', 99).job_id, 'job-tg');
});

test('answer library upsert bumps use_count and updates the answer', () => {
  db.upsertLibraryAnswer('default', { question_key: 'k', label: 'K?', type: 'text', options_json: null, answer: '1' });
  db.upsertLibraryAnswer('default', { question_key: 'k', label: 'K?', type: 'text', options_json: null, answer: '2' });
  const row = db.getLibraryAnswer('default', 'k');
  assert.equal(row.answer, '2');
  assert.equal(row.use_count, 2);
});
