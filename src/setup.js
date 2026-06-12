// ── First-run setup wizard backend ──────────────────────────────────────────
// Drives the GUI "Einrichtung" wizard. A *step* groups related variables; the
// wizard shows only the steps that are still incomplete, so:
//   • a fresh install walks the whole flow, and
//   • when a later release adds a new step, existing users see *only* that step.
//
// DEBUG MODE (?debug=1): reads fall back to the user's real config so the form
// is realistically prefilled, but every write goes to a throwaway sandbox under
// data/setup-debug/. Nothing the user already has is touched, and the full flow
// is always shown — so the wizard can be rehearsed end to end risk-free.

import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const REAL = {
  env:     path.join(ROOT, '.env'),
  profile: path.join(ROOT, 'config', 'profile.json'),
  jobs:    path.join(ROOT, 'config', 'jobs.json'),
  filters: path.join(ROOT, 'config', 'filters.json'),
  state:   path.join(ROOT, 'config', 'setup-state.json'),
};
const SANDBOX_DIR = path.join(ROOT, 'data', 'setup-debug');
const SANDBOX = {
  env:     path.join(SANDBOX_DIR, 'env'),
  profile: path.join(SANDBOX_DIR, 'profile.json'),
  jobs:    path.join(SANDBOX_DIR, 'jobs.json'),
  filters: path.join(SANDBOX_DIR, 'filters.json'),
  state:   path.join(SANDBOX_DIR, 'setup-state.json'),
};

// Bump when steps that should re-prompt existing users are added.
const SETUP_VERSION = 1;

// ── Step + field schema ──────────────────────────────────────────────────────
// store: where a field is persisted — 'env' | 'profile' | 'jobs' | 'filters'.
// For 'profile', `key` is a dotted path into config/profile.json.
// type:  'secret' | 'text' | 'textarea' | 'int' | 'list' | 'sources'
const STEPS = [
  {
    id: 'apikey', title: 'Anthropic API-Schlüssel', required: true,
    subtitle: 'Die KI bewertet, wie gut jede Stelle zu dir passt.',
    intro: 'Erstelle einen Schlüssel auf console.anthropic.com → "API Keys". Er beginnt mit "sk-ant-".',
    fields: [
      { key: 'ANTHROPIC_API_KEY', store: 'env', type: 'secret', required: true,
        label: 'Anthropic API Key', help: 'Von console.anthropic.com', placeholder: 'sk-ant-…' },
    ],
  },
  {
    id: 'telegram', title: 'Telegram-Benachrichtigungen', required: true,
    subtitle: 'Passende Jobs als Nachricht in dein Telegram – oder ganz weglassen.',
    intro: 'Optional: Schreibe @BotFather auf Telegram an, erstelle einen Bot und kopiere das Token. ' +
           'Die Chat-ID bekommst du z. B. über @userinfobot. Magst du keine Push-Nachrichten, ' +
           'schalte sie einfach aus – relevante Jobs siehst du weiterhin jederzeit in der GUI.',
    test: 'telegram',
    // Done when either switched off, or both credentials are present.
    completeWhen: (v) => v.TELEGRAM_NOTIFICATIONS === 'off' || (!!v.TELEGRAM_BOT_TOKEN && !!v.TELEGRAM_CHAT_ID),
    fields: [
      { key: 'TELEGRAM_NOTIFICATIONS', store: 'env', type: 'toggle', default: 'on',
        label: 'Telegram-Benachrichtigungen nutzen',
        help: 'Ausschalten = keine Push-Nachrichten. Relevante Jobs erscheinen weiterhin in der GUI.' },
      { key: 'TELEGRAM_BOT_TOKEN', store: 'env', type: 'secret',
        label: 'Bot Token', help: 'Von @BotFather', placeholder: '123456:ABC-DEF…' },
      { key: 'TELEGRAM_CHAT_ID', store: 'env', type: 'text',
        label: 'Chat ID', help: 'Deine persönliche Chat-ID', placeholder: '987654321' },
    ],
  },
  {
    id: 'profile', title: 'Dein Profil', required: true,
    subtitle: 'Worauf die KI achtet, wenn sie Stellen für dich bewertet.',
    intro: 'Je konkreter, desto besser die Treffer. Mehrfachfelder: ein Eintrag pro Zeile.',
    fields: [
      { key: 'cv.name', store: 'profile', type: 'text', required: true,
        label: 'Name', placeholder: 'Vor- und Nachname' },
      { key: 'cv.currentRole', store: 'profile', type: 'text',
        label: 'Aktuelle Rolle / Status', placeholder: 'z. B. Maschinenbau-Absolvent' },
      { key: 'cv.yearsOfExperience', store: 'profile', type: 'int', min: 0, max: 60,
        label: 'Berufserfahrung (Jahre)', placeholder: '3' },
      { key: 'cv.summary', store: 'profile', type: 'textarea', required: true,
        label: 'Kurzprofil', help: '2–3 Sätze: Fachgebiet, Stärken, was du suchst. Geht direkt an die KI.',
        placeholder: 'Maschinenbauingenieur mit Fokus auf additive Fertigung …' },
      { key: 'cv.skills.domain', store: 'profile', type: 'list',
        label: 'Fachliche Kompetenzen', help: 'Eine pro Zeile' },
      { key: 'cv.languages', store: 'profile', type: 'list',
        label: 'Sprachen', help: 'z. B. Deutsch (Muttersprache)' },
      { key: 'preferences.desiredRoles', store: 'profile', type: 'list', required: true,
        label: 'Wunsch-Rollen', help: 'Job-Titel, die du suchst — eine pro Zeile' },
      { key: 'preferences.locations', store: 'profile', type: 'list',
        label: 'Orte', help: 'Städte, "Remote", "Hybrid" …' },
      { key: 'preferences.industries', store: 'profile', type: 'list',
        label: 'Branchen' },
      { key: 'preferences.dealbreakers', store: 'profile', type: 'list',
        label: 'No-Gos', help: 'Was du auf keinen Fall willst' },
    ],
  },
  {
    id: 'sources', title: 'Karriereseiten', required: true,
    subtitle: 'Welche Unternehmens-Seiten nach Stellen durchsucht werden.',
    intro: 'Füge die Karriere-/Stellenseiten der Firmen hinzu, die dich interessieren. ' +
           'Mindestens eine Quelle wird benötigt.',
    fields: [
      { key: 'sources', store: 'jobs', type: 'sources', required: true, label: 'Quellen' },
    ],
  },
  {
    id: 'filters', title: 'Titel-Filter', required: false,
    subtitle: 'Optional: Stellen vorab nach Stichwörtern im Titel aus- oder einschließen.',
    intro: 'Spart KI-Kosten. Geblockte Titel werden gar nicht erst analysiert; ' +
           'Prioritäts-Stichwörter heben den Score an. Leer lassen ist völlig in Ordnung.',
    fields: [
      { key: 'titleBlocklist', store: 'filters', type: 'list',
        label: 'Blockliste (Titel überspringen)', help: 'Ein Stichwort pro Zeile, z. B. praktikum' },
      { key: 'priorityKeywords', store: 'filters', type: 'list',
        label: 'Prioritäts-Stichwörter', help: 'Titel mit diesen Wörtern werden bevorzugt' },
    ],
  },
  {
    id: 'tuning', title: 'Feineinstellung', required: false,
    subtitle: 'Optional: Schwellenwerte und Zeitplan. Standardwerte sind sinnvoll.',
    intro: 'Kann später jederzeit unter "Einstellungen" geändert werden.',
    fields: [
      { key: 'MIN_RELEVANCE_SCORE', store: 'env', type: 'int', min: 1, max: 10, default: '4',
        label: 'Min. Relevanz-Score', help: 'Ab diesem Score (1–10) gilt ein Job als passend' },
      { key: 'CRON_SCHEDULE', store: 'env', type: 'text', default: '0 * * * *',
        label: 'Zeitplan (Cron)', help: 'Wie oft gesucht wird. Standard: stündlich' },
    ],
  },
];
const STEP_BY_ID = Object.fromEntries(STEPS.map(s => [s.id, s]));

// ── Path resolution ──────────────────────────────────────────────────────────
function pathsFor(store, debug) {
  // In debug mode writes target the sandbox; reads fall back to the real file.
  return { read: debug ? SANDBOX[store] : REAL[store], realFallback: REAL[store], write: debug ? SANDBOX[store] : REAL[store] };
}

async function readJson(file, fallbackFile) {
  for (const f of [file, fallbackFile]) {
    if (!f) continue;
    try { return JSON.parse(await readFile(f, 'utf-8')); } catch { /* try next */ }
  }
  return null;
}

async function writeJson(file, obj) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

// ── .env helpers (line-based upsert; preserves comments + unrelated keys) ─────
function envQuote(v) {
  return /[\s#"'=]/.test(v) ? `"${String(v).replace(/"/g, '\\"')}"` : v;
}
function parseEnv(raw) {
  const out = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
async function readEnv(debug) {
  const { read, realFallback } = pathsFor('env', debug);
  for (const f of [read, realFallback]) {
    try { return parseEnv(await readFile(f, 'utf-8')); } catch { /* next */ }
  }
  return {};
}
async function writeEnv(debug, updates) {
  const { write, realFallback } = pathsFor('env', debug);
  let raw = '';
  try { raw = await readFile(write, 'utf-8'); }
  catch { try { raw = await readFile(realFallback, 'utf-8'); } catch { raw = ''; } }

  const lines = raw.split('\n');
  const remaining = { ...updates };
  const next = lines.map(line => {
    const m = line.match(/^\s*#?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && Object.prototype.hasOwnProperty.call(remaining, m[1])) {
      const key = m[1];
      const v = remaining[key];
      delete remaining[key];
      return v === '' ? `# ${key}=` : `${key}=${envQuote(v)}`;
    }
    return line;
  });
  for (const [key, v] of Object.entries(remaining)) {
    if (v !== '') next.push(`${key}=${envQuote(v)}`);
  }
  await mkdir(path.dirname(write), { recursive: true });
  await writeFile(write, next.join('\n'), 'utf-8');

  // Reflect into the live process so the next spawned run sees changes (real only).
  if (!debug) {
    for (const [key, v] of Object.entries(updates)) {
      if (v !== '') process.env[key] = v; else delete process.env[key];
    }
  }
}

// ── Dotted-path get/set for profile.json ─────────────────────────────────────
function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof o[keys[i]] !== 'object' || o[keys[i]] == null) o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
}

// ── Setup state (which optional steps the user already handled) ───────────────
async function readState(debug) {
  const { read } = pathsFor('state', debug);
  return (await readJson(read)) || { version: 0, acknowledged: [], completedAt: null };
}
async function writeState(debug, patch) {
  const cur = await readState(debug);
  const next = { ...cur, ...patch, version: SETUP_VERSION };
  if (patch.acknowledged) next.acknowledged = [...new Set([...(cur.acknowledged || []), ...patch.acknowledged])];
  const { write } = pathsFor('state', debug);
  await writeJson(write, next);
  return next;
}

// ── Current values for a step's fields ───────────────────────────────────────
async function valuesForStep(step, debug) {
  const env = step.fields.some(f => f.store === 'env') ? await readEnv(debug) : {};
  const profile = step.fields.some(f => f.store === 'profile')
    ? (await readJson(pathsFor('profile', debug).read, pathsFor('profile', debug).realFallback)) || {} : {};
  const jobs = step.fields.some(f => f.store === 'jobs')
    ? (await readJson(pathsFor('jobs', debug).read, pathsFor('jobs', debug).realFallback)) || {} : {};
  const filters = step.fields.some(f => f.store === 'filters')
    ? (await readJson(pathsFor('filters', debug).read, pathsFor('filters', debug).realFallback)) || {} : {};

  const out = {};
  for (const f of step.fields) {
    if (f.type === 'sources') { out[f.key] = Array.isArray(jobs.sources) ? jobs.sources : []; continue; }
    let v;
    if (f.store === 'env') v = env[f.key];
    else if (f.store === 'profile') v = getPath(profile, f.key);
    else if (f.store === 'filters') v = filters[f.key];
    out[f.key] = v ?? (f.type === 'list' ? [] : '');
  }
  return out;
}

// ── Completeness per step ────────────────────────────────────────────────────
function fieldFilled(field, value) {
  if (field.type === 'sources' || field.type === 'list') return Array.isArray(value) && value.length > 0;
  return value != null && String(value).trim() !== '';
}
async function isComplete(step, debug) {
  const vals = await valuesForStep(step, debug);
  if (typeof step.completeWhen === 'function') return !!step.completeWhen(vals);
  for (const f of step.fields) {
    if (f.required && !fieldFilled(f, vals[f.key])) return false;
  }
  return true;
}

// ── Status payload ───────────────────────────────────────────────────────────
async function buildStatus(debug) {
  const state = await readState(debug);
  const ackd = new Set(state.acknowledged || []);

  const completeById = {};
  for (const step of STEPS) completeById[step.id] = await isComplete(step, debug);

  // A "fresh install" is one where *every* required step is still empty — that's
  // when we frame the wizard with a welcome/finish. A later release adding one new
  // step to an already-configured user is NOT a fresh install, so only that step
  // shows, without the welcome/finish chrome.
  const requiredSteps = STEPS.filter(s => s.required);
  const freshInstall = requiredSteps.length > 0 && requiredSteps.every(s => !completeById[s.id]);
  const firstRun = debug ? true : freshInstall;

  const steps = [];
  for (const step of STEPS) {
    const complete = completeById[step.id];
    // Optional steps only nag until acknowledged; required steps until complete.
    const pending = debug ? true : (step.required ? !complete : (!complete && !ackd.has(step.id)));
    steps.push({
      id: step.id, title: step.title, subtitle: step.subtitle, intro: step.intro,
      required: !!step.required, test: step.test || null, complete, pending,
      fields: step.fields.map(f => ({
        key: f.key, label: f.label, help: f.help || '', type: f.type,
        required: !!f.required, default: f.default ?? '', min: f.min, max: f.max,
        placeholder: f.placeholder ?? '', value: undefined,
      })),
      values: await valuesForStep(step, debug),
    });
  }

  const needed = debug
    || steps.some(s => s.required && s.pending)
    || (firstRun && steps.some(s => s.pending));

  return { debug: !!debug, firstRun, needed, version: SETUP_VERSION, steps };
}

// ── Persist one step ─────────────────────────────────────────────────────────
async function saveStep(step, incoming, debug) {
  const errors = [];
  const envUpdates = {};
  let profile = null, jobs = null, filters = null;

  for (const f of step.fields) {
    let val = incoming ? incoming[f.key] : undefined;

    if (f.type === 'sources') {
      const arr = Array.isArray(val) ? val : [];
      const clean = [];
      for (const s of arr) {
        const name = (s?.name || '').trim();
        const url = (s?.url || '').trim();
        if (!name && !url) continue;
        if (!name || !url) { errors.push('Jede Quelle braucht Name und URL'); continue; }
        clean.push({ name, url, type: s.type || 'careers-page', ...Object.fromEntries(Object.entries(s).filter(([k]) => !['name', 'url', 'type'].includes(k))) });
      }
      if (f.required && clean.length === 0) errors.push('Mindestens eine Quelle wird benötigt');
      jobs = jobs || {};
      jobs.sources = clean;
      continue;
    }

    if (f.type === 'toggle') {
      // Stored in .env: 'off' disables; empty/absent means default-enabled.
      const on = val === true || val === 'true' || val === 'on' || val === '1';
      if (f.store === 'env') envUpdates[f.key] = on ? '' : 'off';
      continue;
    }

    if (f.type === 'list') {
      const arr = Array.isArray(val) ? val.map(x => String(x).trim()).filter(Boolean)
        : String(val ?? '').split('\n').map(x => x.trim()).filter(Boolean);
      if (f.required && arr.length === 0) errors.push(`${f.label}: mindestens ein Eintrag`);
      if (f.store === 'profile') { profile = profile || {}; setPath(profile, f.key, arr); }
      else if (f.store === 'filters') { filters = filters || {}; filters[f.key] = arr; }
      continue;
    }

    val = val == null ? '' : String(val).trim();
    if (f.required && val === '') { errors.push(`${f.label} ist erforderlich`); continue; }

    if (f.type === 'int' && val !== '') {
      if (!/^-?\d+$/.test(val)) { errors.push(`${f.label}: ganze Zahl erwartet`); continue; }
      const n = Number(val);
      if (f.min != null && n < f.min) { errors.push(`${f.label}: mindestens ${f.min}`); continue; }
      if (f.max != null && n > f.max) { errors.push(`${f.label}: höchstens ${f.max}`); continue; }
      val = String(n);
    }
    if (f.key === 'CRON_SCHEDULE' && val !== '') {
      const parts = val.split(/\s+/);
      if (parts.length < 5 || parts.length > 6) { errors.push('Zeitplan (Cron): 5 Felder erwartet, z. B. 0 * * * *'); continue; }
    }

    if (f.store === 'env') {
      // Secrets: empty means "leave unchanged"; others: empty means "unset".
      if (f.type === 'secret' && val === '') continue;
      envUpdates[f.key] = val;
    } else if (f.store === 'profile') {
      profile = profile || {};
      setPath(profile, f.key, f.type === 'int' && val !== '' ? Number(val) : val);
    } else if (f.store === 'filters') {
      filters = filters || {};
      filters[f.key] = val;
    }
  }

  if (errors.length) return { ok: false, error: errors.join(' · ') };

  // Apply writes, merging into existing files so untouched fields survive.
  if (Object.keys(envUpdates).length) await writeEnv(debug, envUpdates);

  if (profile) {
    const cur = (await readJson(pathsFor('profile', debug).read, pathsFor('profile', debug).realFallback)) || {};
    const merged = mergeDeep(cur, profile);
    await writeJson(pathsFor('profile', debug).write, merged);
  }
  if (jobs) {
    await writeJson(pathsFor('jobs', debug).write, jobs);
  }
  if (filters) {
    const cur = (await readJson(pathsFor('filters', debug).read, pathsFor('filters', debug).realFallback)) || {};
    await writeJson(pathsFor('filters', debug).write, { ...cur, ...filters });
  }

  await writeState(debug, { acknowledged: [step.id] });
  return { ok: true };
}

function mergeDeep(target, src) {
  const out = Array.isArray(target) ? [...target] : { ...target };
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = mergeDeep(out[k], v);
    } else out[k] = v;
  }
  return out;
}

// ── Telegram test message ────────────────────────────────────────────────────
async function testTelegram(incoming, debug) {
  const env = await readEnv(debug);
  const token = (incoming?.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = (incoming?.TELEGRAM_CHAT_ID || env.TELEGRAM_CHAT_ID || '').trim();
  if (!token || !chatId) return { ok: false, error: 'Bot Token und Chat ID werden benötigt.' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: '✅ Job-Alert: Testnachricht – die Telegram-Einrichtung funktioniert!' }),
    });
    const body = await res.json().catch(() => ({}));
    if (body.ok) return { ok: true };
    return { ok: false, error: body.description || `Telegram-Fehler (HTTP ${res.status})` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── HTTP handler ─────────────────────────────────────────────────────────────
// Returns true if it handled the request. ctx: { sendJson, readBody }.
export async function handleSetupApi(req, res, url, { sendJson, readBody }) {
  const { pathname } = url;
  if (!pathname.startsWith('/api/setup')) return false;
  const debug = url.searchParams.get('debug') === '1';
  const method = req.method;

  if (method === 'GET' && pathname === '/api/setup/status') {
    sendJson(res, 200, await buildStatus(debug));
    return true;
  }

  if (method === 'PUT' && pathname === '/api/setup/step') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); }
    catch (e) { sendJson(res, 400, { error: `kein gültiges JSON: ${e.message}` }); return true; }
    const step = STEP_BY_ID[body.id];
    if (!step) { sendJson(res, 400, { error: 'unbekannter Schritt' }); return true; }
    if (body.skip) {
      await writeState(debug, { acknowledged: [step.id] });
      sendJson(res, 200, { ok: true, status: await buildStatus(debug) });
      return true;
    }
    const result = await saveStep(step, body.values || {}, debug);
    if (!result.ok) { sendJson(res, 400, result); return true; }
    sendJson(res, 200, { ok: true, status: await buildStatus(debug) });
    return true;
  }

  if (method === 'POST' && pathname === '/api/setup/test-telegram') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { /* ignore */ }
    sendJson(res, 200, await testTelegram(body.values || body, debug));
    return true;
  }

  if (method === 'POST' && pathname === '/api/setup/complete') {
    if (!debug) await writeState(debug, { completedAt: new Date().toISOString() });
    sendJson(res, 200, { ok: true });
    return true;
  }

  sendJson(res, 404, { error: 'unknown setup endpoint' });
  return true;
}
