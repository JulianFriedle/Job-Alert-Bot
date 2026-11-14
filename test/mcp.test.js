// MCP server: protocol, tools (with a fake api) and the policy. Fully offline —
// no server, no DB, no network. server.js is deliberately not imported (it would
// start listening); the gate logic lives in mcp-policy.js for that reason.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createMcpHandler, parseLine } from '../src/mcp-protocol.js';
import { createToolkit, mergePatch, createHttpApi } from '../src/mcp-tools.js';
import {
  MCP_HEADER, PROTECTED_SETTINGS_KEYS, isMcpActionRoute, isMcpForbiddenRoute, mcpActionsEnabled,
  secretFieldsInStepBody, redactSetupSecrets, ACTIONS_REFUSAL,
  settingsRefusal, costFieldsInStepBody, COST_SETTINGS_KEYS, pinGuardedStepFields,
} from '../src/mcp-policy.js';
import { candidateBases } from '../src/mcp-tools.js';
import { STEPS as WIZARD_STEPS } from '../src/setup.js';

// ── fake api ────────────────────────────────────────────────────────────────
function fakeApi(routes = {}) {
  const calls = [];
  const handle = (method) => async (path, a, b) => {
    const query = method === 'GET' ? a : b;
    const body = method === 'GET' ? undefined : a;
    calls.push({ method, path, body, query });
    const key = `${method} ${path}`;
    if (!(key in routes)) throw new Error(`unexpected ${key}`);
    const r = routes[key];
    return typeof r === 'function' ? r({ body, query }) : r;
  };
  return { calls, get: handle('GET'), put: handle('PUT'), post: handle('POST') };
}

function setup(routes, env = {}) {
  const api = fakeApi(routes);
  const { tools, prompts } = createToolkit({
    api, env,
    readTemplate: async () => JSON.stringify({ cv: { name: 'Your Name' }, preferences: {} }),
  });
  const { handleMessage } = createMcpHandler({ tools, prompts, serverInfo: { name: 'job-alert-bot', version: '1.2.3' } });
  const call = async (name, args = {}) => {
    const res = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const text = res.result.content[0].text;
    return { isError: Boolean(res.result.isError), text, json: () => JSON.parse(text) };
  };
  return { api, tools, prompts, handleMessage, call };
}

// ── protocol ────────────────────────────────────────────────────────────────
test('initialize echoes a supported protocol version, else the latest', async () => {
  const { handleMessage } = setup({});
  for (const v of ['2025-06-18', '2025-03-26', '2024-11-05']) {
    const r = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: v } });
    assert.equal(r.result.protocolVersion, v);
  }
  const r = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(r.result.protocolVersion, '2025-06-18');
  assert.deepEqual(r.result.capabilities, { tools: {}, prompts: {} });
  assert.deepEqual(r.result.serverInfo, { name: 'job-alert-bot', version: '1.2.3' });
});

test('notifications never get a response', async () => {
  const { handleMessage } = setup({});
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/whatever' }), null);
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'tools/list' }), null);
});

test('ping, unknown method and unknown tool', async () => {
  const { handleMessage, call } = setup({});
  assert.deepEqual((await handleMessage({ jsonrpc: '2.0', id: 5, method: 'ping' })).result, {});
  const r = await handleMessage({ jsonrpc: '2.0', id: 6, method: 'does/not/exist' });
  assert.equal(r.error.code, -32601);
  assert.equal(r.id, 6);
  const t = await call('no_such_tool');
  assert.equal(t.isError, true);
});

test('a malformed line yields a parse error (-32700), blank lines are skipped', () => {
  assert.equal(parseLine('{not json').error.error.code, -32700);
  assert.equal(parseLine('   ').skip, true);
  assert.deepEqual(parseLine('{"jsonrpc":"2.0","id":1,"method":"ping"}').message.method, 'ping');
});

test('tools/list contains every tier; action tools are flagged and always listed', async () => {
  const { handleMessage } = setup({});
  const r = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const names = r.result.tools.map(t => t.name);
  const expected = [
    'list_clients', 'get_overview', 'list_jobs', 'get_job', 'list_runs', 'get_run_report', 'get_run_status',
    'get_run_log', 'list_applications', 'get_document_status',
    'get_setup_status', 'save_setup_step', 'get_profile', 'get_profile_template', 'update_profile',
    'get_sources', 'update_sources', 'add_source', 'get_filters', 'update_filters', 'get_prompts',
    'get_settings', 'update_settings',
    'set_job_status', 'ignore_job', 'add_manual_job',
    'start_run', 'stop_run', 'generate_documents', 'generate_cover_letter', 'send_telegram_test', 'enqueue_application',
  ];
  for (const n of expected) assert.ok(names.includes(n), `missing tool ${n}`);
  for (const n of ['approve_application', 'discard_application', 'retry_application']) assert.ok(!names.includes(n));
  const action = r.result.tools.find(t => t.name === 'start_run');
  assert.ok(action.description.startsWith('⚠ Kostenpflichtig/extern – nur nach Freischaltung in Einstellungen.'));
  for (const t of r.result.tools) assert.equal(t.inputSchema.type, 'object');
});

test('prompts/list and prompts/get', async () => {
  const { handleMessage } = setup({});
  const list = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'prompts/list' });
  assert.deepEqual(list.result.prompts.map(p => p.name).sort(), ['einrichtung', 'jobs_der_woche', 'profil_aus_lebenslauf']);
  const got = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'einrichtung' } });
  assert.match(got.result.messages[0].content.text, /get_setup_status/);
  assert.match(got.result.messages[0].content.text, /NIEMALS/);
  const bad = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'prompts/get', params: { name: 'nope' } });
  assert.ok(bad.error);
});

// ── tools ───────────────────────────────────────────────────────────────────
const JOBS = (() => {
  const day = 86_400_000;
  const iso = (d) => new Date(Date.now() - d * day).toISOString();
  return [
    { id: 'a', title: 'Data Engineer', company: 'Acme', score: 9, status: null, scraped_at: iso(1), summary: 'x'.repeat(500) },
    { id: 'b', title: 'Backend Dev', company: 'Beta GmbH', score: 6, status: 'applied', scraped_at: iso(3) },
    { id: 'c', title: 'Data Analyst', company: 'Gamma', score: 4, status: null, scraped_at: iso(20) },
  ];
})();

test('list_jobs filters client-side, returns compact rows and honours limit', async () => {
  const { call, api } = setup({ 'GET /api/jobs': JOBS });
  let r = (await call('list_jobs', { query: 'data' })).json();
  assert.deepEqual(r.jobs.map(j => j.id), ['a', 'c']);
  assert.equal(r.jobs[0].summary.length, 240);
  assert.ok(!('description' in r.jobs[0]));
  r = (await call('list_jobs', { minScore: 5 })).json();
  assert.deepEqual(r.jobs.map(j => j.id), ['a', 'b']);
  r = (await call('list_jobs', { sinceDays: 7 })).json();
  assert.deepEqual(r.jobs.map(j => j.id), ['a', 'b']);
  r = (await call('list_jobs', { status: 'none' })).json();
  assert.deepEqual(r.jobs.map(j => j.id), ['a', 'c']);
  r = (await call('list_jobs', { company: 'beta' })).json();
  assert.deepEqual(r.jobs.map(j => j.id), ['b']);
  r = (await call('list_jobs', { limit: 1 })).json();
  assert.equal(r.matching, 3);
  assert.equal(r.jobs.length, 1);
  assert.ok(api.calls.every(c => c.method === 'GET'));
});

test('clientId: explicit argument beats MCP_CLIENT_ID', async () => {
  const { call, api } = setup({ 'GET /api/jobs': [] }, { MCP_CLIENT_ID: 'envclient' });
  await call('list_jobs');
  await call('list_jobs', { clientId: 'other' });
  assert.equal(api.calls[0].query.clientId, 'envclient');
  assert.equal(api.calls[1].query.clientId, 'other');
});

test('mergePatch: objects merge, arrays replace, null deletes', () => {
  const out = mergePatch({ a: { x: 1, y: 2 }, list: [1, 2], gone: 1 }, { a: { y: 3 }, list: [9], gone: null });
  assert.deepEqual(out, { a: { x: 1, y: 3 }, list: [9] });
});

test('update_profile merge-patches onto the current profile and passes baseVersion', async () => {
  const { call, api } = setup({
    'GET /api/profile': { profile: { cv: { name: 'A', skills: ['x'] }, preferences: { locations: ['Berlin'] } }, version: 'v1' },
    'PUT /api/profile': { ok: true, version: 'v2' },
  });
  const r = await call('update_profile', { patch: { preferences: { locations: ['München'] }, cv: { currentRole: 'Dev' } } });
  assert.equal(r.isError, false);
  const put = api.calls.find(c => c.method === 'PUT');
  assert.equal(put.body.baseVersion, 'v1');
  assert.deepEqual(put.body.profile, {
    cv: { name: 'A', skills: ['x'], currentRole: 'Dev' }, preferences: { locations: ['München'] },
  });
});

test('update_profile surfaces a version conflict as a tool error', async () => {
  const { call } = setup({
    'GET /api/profile': { profile: {}, version: 'v1' },
    'PUT /api/profile': () => { throw new Error('Die Daten wurden inzwischen an anderer Stelle geändert'); },
  });
  const r = await call('update_profile', { patch: { a: 1 } });
  assert.equal(r.isError, true);
  assert.match(r.text, /geändert/);
});

test('update_settings refuses protected keys without touching the api', async () => {
  const { call, api } = setup({});
  const r = await call('update_settings', { settings: { MCP_ALLOW_ACTIONS: 'true' } });
  assert.equal(r.isError, true);
  const r2 = await call('update_settings', { settings: { APPLY_DRY_RUN: 'false', MIN_RELEVANCE_SCORE: '5' } });
  assert.equal(r2.isError, true);
  assert.equal(api.calls.length, 0);
});

test('update_settings refuses secret keys and never PUTs them', async () => {
  const { call, api } = setup({
    'GET /api/settings': { settings: [
      { key: 'ANTHROPIC_API_KEY', type: 'secret' }, { key: 'MIN_RELEVANCE_SCORE', type: 'int' },
    ] },
    'PUT /api/settings': { ok: true },
  });
  const bad = await call('update_settings', { settings: { ANTHROPIC_API_KEY: 'sk-ant-xyz' } });
  assert.equal(bad.isError, true);
  assert.ok(!api.calls.some(c => c.method === 'PUT'));
  const ok = await call('update_settings', { settings: { MIN_RELEVANCE_SCORE: '5' } });
  assert.equal(ok.isError, false);
  assert.deepEqual(api.calls.find(c => c.method === 'PUT').body, { settings: { MIN_RELEVANCE_SCORE: '5' } });
});

test('get_settings never returns secret values', async () => {
  const { call } = setup({
    'GET /api/settings': { settings: [
      { key: 'ANTHROPIC_API_KEY', type: 'secret', value: 'sk-ant-LEAK', isSet: true },
      { key: 'APPLY_DRY_RUN', type: 'bool', value: 'true' },
    ] },
  });
  const r = await call('get_settings');
  assert.ok(!r.text.includes('sk-ant-LEAK'));
  const rows = r.json();
  assert.equal(rows[0].isSet, true);
  assert.equal(rows[1].locked, true);
});

const STATUS = {
  needed: true, firstRun: true,
  steps: [{
    id: 'apikey', title: 'Key', required: true, complete: false, pending: true,
    fields: [{ key: 'ANTHROPIC_API_KEY', type: 'secret', required: true, label: 'Key' }],
    values: { ANTHROPIC_API_KEY: 'sk-ant-LEAK' },
  }, {
    id: 'profile', title: 'Profil', required: true, complete: false, pending: true,
    fields: [{ key: 'cv.name', type: 'text', required: true, label: 'Name' }],
    values: { 'cv.name': '' },
  }],
};

test('save_setup_step refuses secret fields; saves normal ones', async () => {
  const { call, api } = setup({
    'GET /api/setup/status': STATUS,
    'PUT /api/setup/step': { ok: true, status: STATUS },
  });
  const bad = await call('save_setup_step', { stepId: 'apikey', values: { ANTHROPIC_API_KEY: 'sk-ant-123' } });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /selbst/);
  assert.ok(!api.calls.some(c => c.method === 'PUT'));
  const ok = await call('save_setup_step', { stepId: 'profile', values: { 'cv.name': 'Max' } });
  assert.equal(ok.isError, false);
  assert.deepEqual(api.calls.find(c => c.method === 'PUT').body, { id: 'profile', values: { 'cv.name': 'Max' }, skip: false });
});

test('get_setup_status summarises open steps and hides secret values', async () => {
  const { call } = setup({ 'GET /api/setup/status': STATUS });
  const r = await call('get_setup_status');
  assert.ok(!r.text.includes('sk-ant-LEAK'));
  const s = r.json();
  assert.deepEqual(s.openSteps, ['apikey', 'profile']);
  assert.deepEqual(s.steps[1].missingRequired, ['cv.name']);
});

test('add_source validates, appends with baseVersion and rejects duplicates', async () => {
  const { call, api } = setup({
    'GET /api/sources': { sources: [{ name: 'A', url: 'https://a.example/jobs', type: 'careers-page' }], version: 's1' },
    'PUT /api/sources': { ok: true, count: 2, version: 's2' },
  });
  assert.equal((await call('add_source', { source: { name: 'NoUrl' } })).isError, true);
  assert.equal((await call('add_source', { source: { name: 'B', url: 'ftp://x' } })).isError, true);
  assert.equal((await call('add_source', { source: { name: 'Dup', url: 'https://a.example/jobs' } })).isError, true);
  assert.ok(!api.calls.some(c => c.method === 'PUT'));
  const ok = await call('add_source', { source: { name: 'B', url: 'https://b.example/jobs' } });
  assert.equal(ok.isError, false);
  const put = api.calls.find(c => c.method === 'PUT');
  assert.equal(put.body.baseVersion, 's1');
  assert.equal(put.body.sources.length, 2);
  assert.equal(put.body.sources[1].type, 'careers-page');
});

test('get_profile_template reads the injected template', async () => {
  const { call } = setup({});
  assert.equal((await call('get_profile_template')).json().cv.name, 'Your Name');
});

// ── action tools: locked vs unlocked ────────────────────────────────────────
test('action tools are refused while locked — and make no POST', async () => {
  const { call, api } = setup({ 'GET /api/mcp/info': { actionsEnabled: false } });
  for (const [name, args] of [
    ['start_run', {}], ['stop_run', {}], ['generate_documents', { jobId: 'j' }],
    ['generate_cover_letter', { jobId: 'j' }], ['send_telegram_test', {}], ['enqueue_application', { jobId: 'j' }],
  ]) {
    const r = await call(name, args);
    assert.equal(r.isError, true, name);
    assert.equal(r.text, ACTIONS_REFUSAL);
    assert.match(r.text, /Einstellungen → MCP-Server/);
  }
  assert.ok(api.calls.every(c => c.method === 'GET'));
});

test('action tools post to the right path with the client once unlocked', async () => {
  const { call, api } = setup({
    'GET /api/mcp/info': { actionsEnabled: true },
    'POST /api/run': { started: true },
    'POST /api/jobs/j%201/documents': { status: {} },
    'POST /api/applications': { application: {} },
  }, { MCP_CLIENT_ID: 'kl1' });
  assert.equal((await call('start_run', { all: true })).isError, false);
  const run = api.calls.find(c => c.method === 'POST' && c.path === '/api/run');
  assert.equal(run.query.clientId, 'kl1');
  assert.equal(run.query.all, '1');
  await call('generate_documents', { jobId: 'j 1', clientId: 'x', kinds: ['cv'] });
  const docs = api.calls.find(c => c.path.endsWith('/documents'));
  assert.equal(docs.query.clientId, 'x');
  assert.deepEqual(docs.body.kinds, ['cv']);
  await call('enqueue_application', { jobId: 'j' });
  assert.deepEqual(api.calls.find(c => c.path === '/api/applications').body, { jobId: 'j' });
});

test('add_manual_job is a free tool (plain POST, no unlock check)', async () => {
  const { call, api } = setup({ 'POST /api/jobs/manual': { job: { id: 'm' } } });
  const r = await call('add_manual_job', { title: 'T', company: 'C' });
  assert.equal(r.isError, false);
  assert.ok(!api.calls.some(c => c.path === '/api/mcp/info'));
});

// ── HTTP wrapper ────────────────────────────────────────────────────────────
test('createHttpApi sends the MCP header and bearer token, builds the query', async () => {
  const seen = [];
  const api = createHttpApi({
    env: { JOB_ALERT_URL: 'http://gui.test:1234/', MCP_API_TOKEN: 'tok' },
    fetchImpl: async (url, opts) => {
      seen.push({ url, opts });
      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    },
  });
  await api.get('/api/jobs', { clientId: 'c', empty: '', none: undefined });
  assert.equal(seen[0].url, 'http://gui.test:1234/api/jobs?clientId=c');
  assert.equal(seen[0].opts.headers[MCP_HEADER], '1');
  assert.equal(seen[0].opts.headers.Authorization, 'Bearer tok');
});

test('createHttpApi reports an unreachable GUI in German', async () => {
  const api = createHttpApi({
    env: { JOB_ALERT_URL: 'http://127.0.0.1:9' },
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  await assert.rejects(() => api.get('/api/stats'), /Job-Alert-GUI nicht erreichbar unter http:\/\/127\.0\.0\.1:9 – läuft die App\?/);
});

// ── policy ──────────────────────────────────────────────────────────────────
test('isMcpActionRoute matrix', () => {
  const yes = [
    ['POST', '/api/run'], ['POST', '/api/run/stop'], ['POST', '/api/jobs/abc/documents'],
    ['POST', '/api/jobs/abc/cover-letter'], ['POST', '/api/setup/test-telegram'],
    ['POST', '/api/clients/default/telegram-test'], ['POST', '/api/applications'],
  ];
  for (const [m, p] of yes) assert.equal(isMcpActionRoute(m, p), true, `${m} ${p}`);
  const no = [
    ['GET', '/api/run'], ['GET', '/api/run/status'], ['GET', '/api/jobs/abc/documents'], ['GET', '/api/applications'],
    ['POST', '/api/jobs/abc/status'], ['POST', '/api/jobs/manual'], ['PUT', '/api/settings'],
  ];
  for (const [m, p] of no) assert.equal(isMcpActionRoute(m, p), false, `${m} ${p}`);
});

test('isMcpForbiddenRoute matrix', () => {
  const yes = [
    ['POST', '/api/applications/1/approve'], ['POST', '/api/applications/1/discard'], ['POST', '/api/applications/1/retry'],
    ['PUT', '/api/applications/1'], ['GET', '/api/credentials'], ['PUT', '/api/credentials/linkedin'],
    ['POST', '/api/cv'], ['DELETE', '/api/cv'], ['GET', '/api/backups'], ['POST', '/api/backups/restore'],
    ['POST', '/api/update'], ['POST', '/api/restart'], ['POST', '/api/clients'], ['PUT', '/api/clients/x'],
    ['DELETE', '/api/clients/x'], ['DELETE', '/api/documents/5'], ['POST', '/api/documents/5/humanize'],
  ];
  for (const [m, p] of yes) assert.equal(isMcpForbiddenRoute(m, p), true, `${m} ${p}`);
  const no = [
    ['GET', '/api/jobs'], ['POST', '/api/run'], ['POST', '/api/applications'], ['GET', '/api/applications/1'],
    ['GET', '/api/cv'], ['GET', '/api/documents/5/preview'], ['POST', '/api/clients/x/telegram-test'],
    ['PUT', '/api/profile'], ['PUT', '/api/settings'], ['PUT', '/api/setup/step'],
  ];
  for (const [m, p] of no) assert.equal(isMcpForbiddenRoute(m, p), false, `${m} ${p}`);
});

test('mcpActionsEnabled only accepts explicit opt-in values', () => {
  for (const v of ['true', '1', 'on', 'yes', ' TRUE ', 'On']) assert.equal(mcpActionsEnabled({ MCP_ALLOW_ACTIONS: v }), true, v);
  for (const v of ['', 'false', '0', 'off', 'no', 'maybe', undefined]) assert.equal(mcpActionsEnabled({ MCP_ALLOW_ACTIONS: v }), false, String(v));
  assert.equal(mcpActionsEnabled({}), false);
});

test('PROTECTED_SETTINGS_KEYS covers the unlock switch and the auto-apply rails', () => {
  for (const k of ['MCP_ALLOW_ACTIONS', 'MCP_API_TOKEN', 'AUTO_APPLY_ENABLED', 'APPLY_DRY_RUN', 'APPLY_DAILY_CAP',
    'APPLY_COOLDOWN_MINUTES', 'APPLY_HEADFUL', 'CREDENTIALS_KEY', 'AUTH_ENABLED', 'OPERATOR_USER',
    'OPERATOR_PASSWORD_HASH', 'SESSION_SECRET', 'GUI_PORT']) {
    assert.ok(PROTECTED_SETTINGS_KEYS.includes(k), k);
  }
});

test('secretFieldsInStepBody / redactSetupSecrets', () => {
  assert.deepEqual(secretFieldsInStepBody({ id: 'apikey', values: { ANTHROPIC_API_KEY: 'x' } }, STATUS.steps), ['ANTHROPIC_API_KEY']);
  assert.deepEqual(secretFieldsInStepBody({ id: 'apikey', values: { ANTHROPIC_API_KEY: '' } }, STATUS.steps), []);
  assert.deepEqual(secretFieldsInStepBody({ id: 'profile', values: { 'cv.name': 'x' } }, STATUS.steps), []);
  const red = redactSetupSecrets(STATUS);
  assert.equal(red.steps[0].values.ANTHROPIC_API_KEY, '');
  assert.equal(red.steps[0].secretsSet.ANTHROPIC_API_KEY, true);
});

// ── review fixes: notification target, backups, cost knobs ─────────────────
test('the wizard cannot redirect Telegram alerts (chat id) or touch protected keys', () => {
  // The real wizard: TELEGRAM_CHAT_ID is a plain text field there.
  const tg = WIZARD_STEPS.find(s => s.fields.some(f => f.key === 'TELEGRAM_CHAT_ID'));
  assert.ok(tg, 'wizard has a chat id field');
  assert.deepEqual(secretFieldsInStepBody({ id: tg.id, values: { TELEGRAM_CHAT_ID: '123', TELEGRAM_NOTIFICATIONS: 'on' } }, WIZARD_STEPS),
    ['TELEGRAM_CHAT_ID']);
  for (const k of ['TELEGRAM_CHAT_ID', 'BACKUP_ENABLED', 'BACKUP_RETENTION_DAYS', 'ISSUE_REPO']) {
    assert.ok(PROTECTED_SETTINGS_KEYS.includes(k), k);
    assert.ok(settingsRefusal([k], {}, true), `${k} refused even when unlocked`);
  }
});

test('setup status hides values the settings schema marks secret', () => {
  const status = { steps: [{ id: 'telegram', fields: [{ key: 'TELEGRAM_CHAT_ID', type: 'text' }], values: { TELEGRAM_CHAT_ID: '987654' } }] };
  const red = redactSetupSecrets(status, { TELEGRAM_CHAT_ID: { type: 'secret' } });
  assert.equal(red.steps[0].values.TELEGRAM_CHAT_ID, '');
  assert.equal(red.steps[0].secretsSet.TELEGRAM_CHAT_ID, true);
});

test('cost-relevant settings need the red button; harmless ones do not', () => {
  for (const k of ['ANALYZER_MODEL', 'COVER_LETTER_MODEL', 'DOCS_HUMANIZE', 'CRON_SCHEDULE']) {
    assert.ok(COST_SETTINGS_KEYS.includes(k), k);
    assert.match(settingsRefusal([k], {}, false).error, /freischalten/);
    assert.equal(settingsRefusal([k], {}, true), null, `${k} allowed when unlocked`);
  }
  assert.equal(settingsRefusal(['MIN_RELEVANCE_SCORE'], {}, false), null);
  // A secret in the schema is refused like a protected key.
  assert.ok(settingsRefusal(['ANTHROPIC_API_KEY'], { ANTHROPIC_API_KEY: { type: 'secret' } }, true));
});

test('a wizard step may keep the schedule unchanged while locked, not change it', () => {
  const tuning = WIZARD_STEPS.find(s => s.fields.some(f => f.key === 'CRON_SCHEDULE'));
  assert.ok(tuning);
  const current = (k) => ({ CRON_SCHEDULE: '0 * * * *' })[k];
  assert.deepEqual(costFieldsInStepBody({ id: tuning.id, values: { CRON_SCHEDULE: '0 * * * *', MIN_RELEVANCE_SCORE: 5 } }, WIZARD_STEPS, current, false), []);
  assert.deepEqual(costFieldsInStepBody({ id: tuning.id, values: { CRON_SCHEDULE: '* * * * *' } }, WIZARD_STEPS, current, false), ['CRON_SCHEDULE']);
  assert.deepEqual(costFieldsInStepBody({ id: tuning.id, values: { CRON_SCHEDULE: '* * * * *' } }, WIZARD_STEPS, current, true), []);
  // Fresh install: nothing stored, the status shows '' — empty on either side means the default.
  const def = (k) => ({ CRON_SCHEDULE: '0 * * * *' })[k];
  assert.deepEqual(costFieldsInStepBody({ id: tuning.id, values: { CRON_SCHEDULE: '', MIN_RELEVANCE_SCORE: '6' } }, WIZARD_STEPS, () => undefined, false, def), []);
  assert.deepEqual(costFieldsInStepBody({ id: tuning.id, values: { CRON_SCHEDULE: '0 * * * *' } }, WIZARD_STEPS, () => '', false, def), []);
  assert.deepEqual(costFieldsInStepBody({ id: tuning.id, values: { CRON_SCHEDULE: '' } }, WIZARD_STEPS, () => '0 8 * * *', false, def), ['CRON_SCHEDULE'],
    'clearing a custom schedule is a change too');
});

test('a stale endpoint file (its process is gone) is not used', async () => {
  const file = async () => JSON.stringify({ url: 'http://127.0.0.1:5123', pid: 999999 });
  assert.deepEqual(await candidateBases({ GUI_PORT: '3000' }, file, () => false), ['http://127.0.0.1:3000']);
  assert.deepEqual(await candidateBases({ GUI_PORT: '3000' }, file, () => true), ['http://127.0.0.1:5123', 'http://127.0.0.1:3000']);
  assert.deepEqual(await candidateBases({ JOB_ALERT_URL: 'http://x:1/' }, file, () => true), ['http://x:1']);
});

test('wizard save from the assistant keeps secret and protected fields as stored', () => {
  const tg = WIZARD_STEPS.find(s => s.fields.some(f => f.key === 'TELEGRAM_CHAT_ID'));
  const body = { id: tg.id, values: { TELEGRAM_NOTIFICATIONS: 'on', TELEGRAM_CHAT_ID: '' } };
  const pinned = pinGuardedStepFields(body, WIZARD_STEPS, { TELEGRAM_CHAT_ID: { type: 'secret' } }, (k) => ({ TELEGRAM_CHAT_ID: '55555' })[k]);
  assert.equal(pinned.values.TELEGRAM_CHAT_ID, '55555', 'a redacted (empty) chat id must not unset the stored one');
  assert.equal(pinned.values.TELEGRAM_BOT_TOKEN, '', "secret wizard field: '' = leave unchanged");
  assert.equal(pinned.values.TELEGRAM_NOTIFICATIONS, 'on');
  assert.equal(body.values.TELEGRAM_CHAT_ID, '', 'input not mutated');
  const other = { id: 'profile', values: { 'cv.name': 'x' } };
  assert.deepEqual(pinGuardedStepFields(other, WIZARD_STEPS).values, { 'cv.name': 'x' });
});

test('save_setup_step keeps the stored answers of fields it was not given', async () => {
  const status = { steps: [{
    id: 'profile', title: 'Profil', required: true, complete: false, pending: true,
    fields: [{ key: 'cv.name', type: 'text' }, { key: 'cv.summary', type: 'textarea' }, { key: 'cv.skills.tools', type: 'list' }],
    values: { 'cv.name': 'Alt', 'cv.summary': 'Bleibt', 'cv.skills.tools': ['Excel'] },
  }, {
    id: 'telegram', title: 'Telegram', required: true, complete: false, pending: true,
    fields: [{ key: 'TELEGRAM_NOTIFICATIONS', type: 'toggle' }, { key: 'TELEGRAM_BOT_TOKEN', type: 'secret' }, { key: 'TELEGRAM_CHAT_ID', type: 'text' },
      { key: 'EXPIRY_NOTIFICATIONS', type: 'toggle', default: 'on' }],
    values: { TELEGRAM_NOTIFICATIONS: 'on', TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '', EXPIRY_NOTIFICATIONS: '' },
    secretsSet: { TELEGRAM_BOT_TOKEN: true, TELEGRAM_CHAT_ID: true },
  }] };
  const { call, api } = setup({ 'GET /api/setup/status': status, 'PUT /api/setup/step': { ok: true, status } });
  assert.equal((await call('save_setup_step', { stepId: 'profile', values: { 'cv.name': 'Neu' } })).isError, false);
  assert.deepEqual(api.calls.find(c => c.method === 'PUT').body.values,
    { 'cv.name': 'Neu', 'cv.summary': 'Bleibt', 'cv.skills.tools': ['Excel'] });
  await call('save_setup_step', { stepId: 'telegram', values: { TELEGRAM_NOTIFICATIONS: 'off' } });
  assert.deepEqual(api.calls.filter(c => c.method === 'PUT')[1].body.values, { TELEGRAM_NOTIFICATIONS: 'off', EXPIRY_NOTIFICATIONS: 'on' },
    'redacted fields are left to the server; an unset toggle keeps its default instead of turning off');
});
