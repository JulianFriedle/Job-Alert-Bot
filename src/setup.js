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

import { getClient, updateClient, DEFAULT_CLIENT_ID } from './database.js';
import { APP_ROOT, CONFIG_DIR as DEFAULT_CONFIG_DIR, DATA_DIR, ENV_FILE } from './paths.js';

// Templates ship with the code; everything the wizard writes goes to the
// writable paths from paths.js.
const ROOT = APP_ROOT;

// Both overridable so a sandbox instance (scripts/operator-sandbox.js) can
// redirect every wizard write away from the operator's real files.
const CONFIG_DIR = process.env.SETUP_CONFIG_DIR || DEFAULT_CONFIG_DIR;
const REAL = {
  env:     ENV_FILE,
  profile: path.join(CONFIG_DIR, 'profile.json'),
  jobs:    path.join(CONFIG_DIR, 'jobs.json'),
  filters: path.join(CONFIG_DIR, 'filters.json'),
  state:   path.join(CONFIG_DIR, 'setup-state.json'),
};
const SANDBOX_DIR = path.join(DATA_DIR, 'setup-debug');
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
// store: where a field is persisted — 'env' | 'profile' | 'jobs' | 'filters' |
//        'boards' (the wizard-managed job-board searches inside the jobs store) |
//        'ui' (browser-only, applied by the frontend; never reaches the server).
// For 'profile', `key` is a dotted path into config/profile.json.
// type:  'secret' | 'text' | 'textarea' | 'int' | 'list' | 'sources' | 'toggle' |
//        'select' (options; allowCustom keeps a value that isn't one of them) |
//        'checks' (multi-select over options, stored as an array)
// later: the GUI tab where the step's answers can be changed afterwards.
export const STEPS = [
  {
    id: 'language', title: 'Sprache', required: false, later: 'language',
    subtitle: 'In welcher Sprache du die Oberfläche und die KI-Texte haben möchtest.',
    intro: 'Die Oberflächen-Sprache gilt für dieses Browser-Fenster. Die Sprache der KI-Texte ' +
           'bestimmt, in welcher Sprache die Begründungen zu jedem Job und deine Anschreiben verfasst werden.',
    // Optional but always worth confirming once: done as soon as a content
    // language is stored, otherwise it nags until acknowledged like any optional step.
    completeWhen: (v) => !!v['preferences.outputLanguage'],
    fields: [
      // Browser-only (localStorage): the frontend applies it, the server never stores it.
      { key: 'uiLanguage', store: 'ui', type: 'select', default: 'de',
        options: [{ value: 'de', label: 'Deutsch' }, { value: 'en', label: 'English' }],
        label: 'Sprache der Oberfläche', help: 'Menüs, Buttons und Hinweise in der GUI.' },
      { key: 'preferences.outputLanguage', store: 'profile', type: 'select', default: 'de',
        options: [{ value: 'de', label: 'Deutsch' }, { value: 'en', label: 'English' }],
        label: 'Sprache der KI-Texte', help: 'Job-Begründungen, Zusammenfassungen und Anschreiben.' },
    ],
  },
  {
    id: 'apikey', title: 'Anthropic API-Schlüssel', required: true, later: 'settings',
    subtitle: 'Die KI bewertet, wie gut jede Stelle zu dir passt.',
    intro: 'Erstelle einen Schlüssel auf console.anthropic.com → "API Keys". Er beginnt mit "sk-ant-". ' +
           'Jede bewertete Stelle kostet einen Bruchteil eines Cents; ein Anschreiben etwas mehr.',
    fields: [
      { key: 'ANTHROPIC_API_KEY', store: 'env', type: 'secret', required: true,
        label: 'Anthropic API Key', help: 'Von console.anthropic.com', placeholder: 'sk-ant-…' },
    ],
  },
  {
    id: 'telegram', title: 'Telegram-Benachrichtigungen', required: true, later: 'settings',
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
      { key: 'TELEGRAM_BOT_TOKEN', store: 'env', type: 'secret', telegramOnly: true,
        label: 'Bot Token', help: 'Von @BotFather', placeholder: '123456:ABC-DEF…' },
      { key: 'TELEGRAM_CHAT_ID', store: 'env', type: 'text', telegramOnly: true,
        label: 'Chat ID', help: 'Deine persönliche Chat-ID', placeholder: '987654321' },
      { key: 'EXPIRY_NOTIFICATIONS', store: 'env', type: 'toggle', default: 'on', telegramOnly: true,
        label: 'Auch melden, wenn gemeldete Stellen verschwinden',
        help: 'Eine kurze Nachricht, sobald eine Stelle nicht mehr online ist (wahrscheinlich besetzt).' },
    ],
  },
  {
    id: 'profile', title: 'Über dich', required: true, later: 'profile',
    subtitle: 'Dein Lebenslauf in Kurzform – daran misst die KI jede Stelle.',
    intro: 'Je konkreter, desto besser die Treffer und Anschreiben. Mehrfachfelder: ein Eintrag pro Zeile. ' +
           'Nur Name und Kurzprofil sind Pflicht – alles andere kannst du später im Tab „Profil“ ergänzen.',
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
      { key: 'cv.skills.programming', store: 'profile', type: 'list',
        label: 'Programmierung', help: 'Sprachen und Frameworks, eine pro Zeile, z. B. Python, SQL' },
      { key: 'cv.skills.tools', store: 'profile', type: 'list',
        label: 'Tools / Software', help: 'Eine pro Zeile, z. B. SolidWorks, Excel' },
      { key: 'cv.education', store: 'profile', type: 'list',
        label: 'Ausbildung', help: 'Ein Abschluss pro Zeile, z. B. M.Sc. Maschinenbau – TU München' },
      { key: 'cv.experience', store: 'profile', type: 'list',
        label: 'Berufliche Stationen', help: 'Eine pro Zeile: Rolle bei Firma – kurz was (Zeitraum)' },
      { key: 'cv.languages', store: 'profile', type: 'list',
        label: 'Sprachkenntnisse', help: 'z. B. Deutsch (Muttersprache)' },
    ],
  },
  {
    id: 'wishes', title: 'Was du suchst', required: true, later: 'profile',
    subtitle: 'Deine Wunsch-Stellen – und was gar nicht geht.',
    intro: 'Die KI vergleicht jede Anzeige mit diesen Wünschen. No-Gos drücken den Score deutlich.',
    fields: [
      { key: 'preferences.desiredRoles', store: 'profile', type: 'list', required: true,
        label: 'Wunsch-Rollen', help: 'Job-Titel, die du suchst — eine pro Zeile' },
      { key: 'preferences.locations', store: 'profile', type: 'list',
        label: 'Orte', help: 'Städte, "Remote", "Hybrid" …' },
      { key: 'preferences.industries', store: 'profile', type: 'list',
        label: 'Branchen' },
      { key: 'preferences.contractTypes', store: 'profile', type: 'list',
        label: 'Vertragsarten', help: 'z. B. Vollzeit, Unbefristet' },
      { key: 'preferences.salaryMin', store: 'profile', type: 'int', min: 0, max: 1000000,
        label: 'Mindestgehalt (€/Jahr)', help: 'Optional – nur ein Hinweis für die KI', placeholder: '50000' },
      { key: 'preferences.dealbreakers', store: 'profile', type: 'list',
        label: 'No-Gos', help: 'Was du auf keinen Fall willst' },
    ],
  },
  {
    id: 'boards', title: 'Jobportale', required: false, later: 'sources',
    subtitle: 'Optional: LinkedIn, StepStone und Indeed nach deinem Suchbegriff durchsuchen.',
    intro: 'Der einfachste Einstieg: ein Suchbegriff und ein Ort genügen, dafür brauchst du kein Konto. ' +
           'Pro Lauf werden die neuesten Treffer geholt und von der KI bewertet. ' +
           'Weitere Suchen lassen sich später im Tab „Quellen“ anlegen.',
    completeWhen: (v) => Array.isArray(v.platforms) && v.platforms.length > 0,
    fields: [
      { key: 'platforms', store: 'boards', type: 'checks',
        options: [
          { value: 'linkedin', label: 'LinkedIn' },
          { value: 'stepstone', label: 'StepStone' },
          { value: 'indeed', label: 'Indeed' },
        ],
        label: 'Portale', help: 'Keins ausgewählt = keine Portal-Suche' },
      { key: 'keywords', store: 'boards', type: 'text',
        label: 'Suchbegriff', help: 'Wie du im Portal suchen würdest', placeholder: 'z. B. Entwicklungsingenieur' },
      { key: 'location', store: 'boards', type: 'text',
        label: 'Ort', placeholder: 'z. B. Stuttgart' },
      { key: 'radiusKm', store: 'boards', type: 'int', min: 0, max: 200, default: '30',
        label: 'Umkreis (km)', placeholder: '30' },
    ],
  },
  {
    id: 'sources', title: 'Karriereseiten', required: true, later: 'sources',
    subtitle: 'Optional: Stellenseiten bestimmter Firmen direkt beobachten.',
    intro: 'Füge die Karriere-/Stellenseiten der Firmen hinzu, die dich interessieren (Adresse aus der ' +
           'Browser-Zeile kopieren). Nötig ist mindestens eine Quelle – eine Jobportal-Suche aus dem ' +
           'vorigen Schritt zählt mit.',
    // Any source counts — a job-board search alone is a complete setup.
    completeWhen: (v) => Array.isArray(v.sources) && v.sources.length > 0,
    fields: [
      { key: 'sources', store: 'jobs', type: 'sources', required: true, label: 'Quellen' },
    ],
  },
  {
    id: 'filters', title: 'Titel-Filter', required: false, later: 'wizard',
    subtitle: 'Optional: Stellen vorab nach Stichwörtern im Titel aus- oder einschließen.',
    intro: 'Spart KI-Kosten. Geblockte Titel werden gar nicht erst analysiert; ' +
           'Prioritäts-Stichwörter heben den Score an. Leer lassen ist völlig in Ordnung.',
    fields: [
      { key: 'titleAllowlist', store: 'filters', type: 'list',
        label: 'Nur diese Titel (Positivliste)',
        help: 'Wenn ausgefüllt, gehen nur Stellen an die KI, deren Titel eines dieser Stichwörter enthält – ' +
              'z. B. assistenz, office manager. Ideal für eine eng umrissene Wunsch-Rolle. Leer = keine Einschränkung' },
      { key: 'titleBlocklist', store: 'filters', type: 'list',
        label: 'Blockliste (Titel überspringen)', help: 'Ein Stichwort pro Zeile, z. B. praktikum' },
      { key: 'priorityKeywords', store: 'filters', type: 'list',
        label: 'Prioritäts-Stichwörter', help: 'Titel mit diesen Wörtern werden bevorzugt' },
    ],
  },
  {
    id: 'tuning', title: 'Wie oft & wie streng', required: false, later: 'settings',
    subtitle: 'Optional: Zeitplan und Schwelle. Die Standardwerte passen für die meisten.',
    intro: 'Häufigere Suchen finden neue Stellen schneller, kosten aber nicht mehr KI-Geld: ' +
           'bewertet wird jede Stelle nur einmal. Kann später unter „Einstellungen“ geändert werden.',
    fields: [
      { key: 'CRON_SCHEDULE', store: 'env', type: 'select', default: '0 * * * *', allowCustom: true,
        options: [
          { value: '0 * * * *', label: 'Stündlich' },
          { value: '0 */3 * * *', label: 'Alle 3 Stunden' },
          { value: '0 8,18 * * *', label: 'Zweimal täglich (8 und 18 Uhr)' },
          { value: '0 8 * * *', label: 'Einmal täglich (8 Uhr)' },
        ],
        label: 'Wie oft suchen?', help: 'Gilt für den Hintergrund-Dienst (npm start bzw. Docker-Container „scheduler“). Läuft nur die Oberfläche, startest du Läufe mit „Lauf starten“ von Hand.' },
      { key: 'MIN_RELEVANCE_SCORE', store: 'env', type: 'select', default: '4',
        options: [
          { value: '3', label: '3 – großzügig: lieber zu viel als etwas verpassen' },
          { value: '4', label: '4 – ausgewogen (Standard)' },
          { value: '6', label: '6 – wählerisch' },
          { value: '8', label: '8 – nur Top-Treffer' },
        ],
        allowCustom: true,
        label: 'Ab wann ist ein Job passend?', help: 'Die KI vergibt 1–10 Punkte. Nur Jobs ab dieser Schwelle werden gemeldet.' },
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

// ── DB-backed config (source of truth once the GUI has saved) ───────────────
// The pipeline reads profile/sources/filters from the default client's DB
// columns (client-config.js) and falls back to config/*.json only while the
// column is NULL. The wizard must follow the same precedence, or its reads go
// stale and its writes become no-ops the moment anything was saved in the GUI.
const DB_COLUMN = { profile: 'profile_json', jobs: 'sources_json', filters: 'filters_json' };

function readDbStore(store) {
  const col = DB_COLUMN[store];
  if (!col) return null;
  let client;
  try { client = getClient(DEFAULT_CLIENT_ID); } catch { return null; }
  if (!client || client[col] == null) return null;
  try {
    const parsed = JSON.parse(client[col]);
    if (store === 'jobs') return { sources: Array.isArray(parsed?.sources) ? parsed.sources : [] };
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

// Read one store with wizard precedence: sandbox (debug) → DB → legacy file.
async function readStore(store, debug) {
  if (debug) {
    const sandboxed = await readJson(SANDBOX[store]);
    if (sandboxed) return sandboxed;
  }
  const fromDb = readDbStore(store);
  if (fromDb) return fromDb;
  return (await readJson(REAL[store])) || null;
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
// ── Template placeholders ────────────────────────────────────────────────────
// Setup tells users to `cp .env.example .env` and `cp config/profile.example.json
// config/profile.json`, so a brand-new install starts with every required field
// already non-empty — filled with the template's own placeholders. Read plainly,
// that makes every step look complete and the wizard never opens for the one
// person it exists for. A value byte-identical to what the template ships is not
// an answer, so treat it as missing.
//
// Deriving the placeholders from the template files means there is no second list
// to keep in sync: edit a placeholder in .env.example and detection follows.
const TEMPLATES = {
  env:     path.join(ROOT, '.env.example'),
  profile: path.join(ROOT, 'config', 'profile.example.json'),
};

let _templates = null;
async function templateValues() {
  if (_templates) return _templates;
  let env = {};
  // parseEnv ignores comment lines, so this yields exactly the keys a plain copy
  // of the template leaves live — the placeholder secrets, not the commented knobs.
  try { env = parseEnv(await readFile(TEMPLATES.env, 'utf-8')); } catch { /* template absent */ }
  _templates = { env, profile: (await readJson(TEMPLATES.profile)) || {} };
  return _templates;
}

// A field still carrying its template value counts as unanswered. Lists compare
// element-wise, so editing even one entry makes the field the user's own.
export function isTemplateValue(value, templateValue) {
  if (value == null || templateValue == null) return false;
  if (Array.isArray(value) || Array.isArray(templateValue)) {
    return JSON.stringify(value) === JSON.stringify(templateValue);
  }
  return String(value).trim() === String(templateValue).trim();
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

// ── Job-board searches managed by the wizard ─────────────────────────────────
// The "Jobportale" step owns at most one search per platform, tagged
// managedBy:'wizard'. Searches the user added by hand (Quellen tab) are never
// read or touched by it, so re-running the wizard can't clobber them.
export const PLATFORM_TYPES = ['linkedin', 'stepstone', 'indeed'];
const PLATFORM_NAMES = { linkedin: 'LinkedIn', stepstone: 'StepStone', indeed: 'Indeed' };
const isPlatformSource = (s) => PLATFORM_TYPES.includes(s?.type);
const isManagedBoard = (s) => isPlatformSource(s) && s.managedBy === 'wizard';

// Current answers of the boards step, read back from the managed sources.
export function boardsFromSources(sources) {
  const managed = (Array.isArray(sources) ? sources : []).filter(isManagedBoard);
  const first = managed[0]?.search || {};
  return {
    platforms: managed.map(s => s.type),
    keywords: first.keywords || '',
    location: first.location || '',
    radiusKm: first.radiusKm != null ? String(first.radiusKm) : '',
  };
}

// Replace the managed searches with the ones described by `answers`, keeping
// every other source (career pages, hand-made searches) exactly as it was.
export function applyBoards(sources, { platforms, keywords, location, radiusKm }) {
  const kept = (Array.isArray(sources) ? sources : []).filter(s => !isManagedBoard(s));
  const search = { keywords, ...(location ? { location } : {}), ...(radiusKm ? { radiusKm } : {}) };
  const boards = platforms.map(type => ({
    name: `${PLATFORM_NAMES[type]} Suche`, type, managedBy: 'wizard', search: { ...search },
  }));
  return [...boards, ...kept];
}

// Merge the career-page rows edited in the wizard back into the full source
// list: job-board searches have no URL, so the wizard doesn't show them as rows
// and must not drop them on save.
export function mergeCareerSources(sources, careerRows) {
  const boards = (Array.isArray(sources) ? sources : []).filter(isPlatformSource);
  return [...careerRows, ...boards];
}

// ── Current values for a step's fields ───────────────────────────────────────
async function valuesForStep(step, debug) {
  const needs = (store) => step.fields.some(f => f.store === store);
  const env = needs('env') ? await readEnv(debug) : {};
  const profile = (needs('profile') || needs('boards')) ? (await readStore('profile', debug)) || {} : {};
  const jobs = (needs('jobs') || needs('boards')) ? (await readStore('jobs', debug)) || {} : {};
  const filters = needs('filters') ? (await readStore('filters', debug)) || {} : {};

  const templates = await templateValues();
  const boards = needs('boards') ? boardsFromSources(jobs.sources) : null;

  // A first-time boards step starts from the profile: first desired role and the
  // first real place (not "Remote"/"Hybrid"), unless those are still placeholders.
  if (boards && boards.platforms.length === 0) {
    const pick = (key, ok = () => true) => {
      const list = getPath(profile, key);
      if (!Array.isArray(list) || isTemplateValue(list, getPath(templates.profile, key))) return '';
      return list.find(x => typeof x === 'string' && x.trim() && ok(x)) || '';
    };
    boards.keywords ||= pick('preferences.desiredRoles');
    boards.location ||= pick('preferences.locations', x => !/remote|hybrid|homeoffice|home office/i.test(x));
    boards.radiusKm ||= '30';
  }

  const out = {};
  for (const f of step.fields) {
    if (f.type === 'sources') { out[f.key] = Array.isArray(jobs.sources) ? jobs.sources : []; continue; }
    if (f.store === 'boards') { out[f.key] = boards[f.key]; continue; }
    if (f.store === 'ui') { out[f.key] = ''; continue; }
    let v;
    if (f.store === 'env') v = env[f.key];
    else if (f.store === 'profile') v = getPath(profile, f.key);
    else if (f.store === 'filters') v = filters[f.key];

    // Blank anything still holding the template's placeholder. Doing it here — the
    // single place values are read — means completeness checks, `completeWhen`, and
    // the prefilled form all agree, and the user gets an empty field to type into
    // rather than "Your Name" to edit.
    const fromTemplate = f.store === 'env' ? templates.env[f.key]
      : f.store === 'profile' ? getPath(templates.profile, f.key)
      : undefined;
    if (isTemplateValue(v, fromTemplate)) v = undefined;

    out[f.key] = v ?? ((f.type === 'list' || f.type === 'checks') ? [] : '');
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

  // A "fresh install" is one where the user has never finished the wizard and
  // something required is still open — that's when we frame it with a welcome and
  // a finish page. A later release adding one new step to an already-configured
  // user is NOT a fresh install, so only that step shows, without the chrome.
  //
  // This deliberately does not ask whether *every* required step is empty: the repo
  // ships config/jobs.json with a populated source list, so the sources step is
  // complete out of the box and that test could never be true for anyone.
  const requiredSteps = STEPS.filter(s => s.required);
  const freshInstall = !state.completedAt && requiredSteps.some(s => !completeById[s.id]);
  const firstRun = debug ? true : freshInstall;

  const steps = [];
  for (const step of STEPS) {
    const complete = completeById[step.id];
    // Required steps stay pending until complete. Optional steps nag until
    // acknowledged (saved or skipped) — on a first run regardless of completeness:
    // a step without required fields (filters, tuning) always counts as complete,
    // so otherwise a new user would never even see it.
    const pending = debug ? true
      : step.required ? !complete
      : !ackd.has(step.id) && (firstRun || !complete);
    steps.push({
      id: step.id, title: step.title, subtitle: step.subtitle, intro: step.intro,
      required: !!step.required, test: step.test || null, complete, pending,
      later: step.later || null,
      fields: step.fields.map(f => ({
        key: f.key, label: f.label, help: f.help || '', type: f.type, store: f.store,
        required: !!f.required, default: f.default ?? '', min: f.min, max: f.max,
        placeholder: f.placeholder ?? '', options: f.options || null,
        allowCustom: !!f.allowCustom, telegramOnly: !!f.telegramOnly,
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
  let profile = null, careerRows = null, filters = null, boards = null;

  for (const f of step.fields) {
    let val = incoming ? incoming[f.key] : undefined;

    // Browser-only preference (UI language): the frontend already applied it.
    if (f.store === 'ui') continue;

    if (f.type === 'sources') {
      const arr = Array.isArray(val) ? val : [];
      const clean = [];
      for (const s of arr) {
        const name = (s?.name || '').trim();
        const url = (s?.url || '').trim();
        const type = (s?.type || 'careers-page').trim();
        // Job-board searches are edited in their own step and merged back below.
        if (PLATFORM_TYPES.includes(type)) continue;
        if (!name && !url) continue;
        if (!name) { errors.push('Jede Quelle braucht einen Namen'); continue; }
        if (!url) { errors.push('Jede Karriereseiten-Quelle braucht eine URL'); continue; }
        if (!/^https?:\/\//i.test(url)) { errors.push(`${name}: URL muss mit http:// oder https:// beginnen`); continue; }
        // Keep per-source extras (paginationParam, extraWait, …) the row carried along.
        const extras = Object.fromEntries(Object.entries(s).filter(([k]) => !['name', 'url', 'type'].includes(k)));
        clean.push({ name, url, type, ...extras });
      }
      careerRows = clean;
      continue;
    }

    if (f.type === 'toggle') {
      // Stored in .env: 'off' disables; empty/absent means default-enabled.
      const on = val === true || val === 'true' || val === 'on' || val === '1';
      if (f.store === 'env') envUpdates[f.key] = on ? '' : 'off';
      continue;
    }

    if (f.type === 'checks') {
      const allowed = new Set((f.options || []).map(o => o.value));
      const arr = (Array.isArray(val) ? val : []).map(String).filter(v => allowed.has(v));
      if (f.store === 'boards') { boards = boards || {}; boards[f.key] = [...new Set(arr)]; }
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

    if (f.type === 'select' && val !== '' && !f.allowCustom && !(f.options || []).some(o => o.value === val)) {
      errors.push(`${f.label}: ungültige Auswahl`); continue;
    }
    if ((f.type === 'int' || (f.type === 'select' && f.key === 'MIN_RELEVANCE_SCORE')) && val !== '') {
      const min = f.key === 'MIN_RELEVANCE_SCORE' ? 1 : f.min;
      const max = f.key === 'MIN_RELEVANCE_SCORE' ? 10 : f.max;
      if (!/^-?\d+$/.test(val)) { errors.push(`${f.label}: ganze Zahl erwartet`); continue; }
      const n = Number(val);
      if (min != null && n < min) { errors.push(`${f.label}: mindestens ${min}`); continue; }
      if (max != null && n > max) { errors.push(`${f.label}: höchstens ${max}`); continue; }
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
      // An emptied number is removed (undefined drops out of the JSON) rather
      // than stored as "" and handed to the AI.
      setPath(profile, f.key, f.type === 'int' ? (val === '' ? undefined : Number(val)) : val);
    } else if (f.store === 'filters') {
      filters = filters || {};
      filters[f.key] = val;
    } else if (f.store === 'boards') {
      boards = boards || {};
      boards[f.key] = f.type === 'int' ? (val === '' ? null : Number(val)) : val;
    }
  }

  if (boards && (boards.platforms || []).length > 0 && !boards.keywords) {
    errors.push('Suchbegriff: wird für die Portal-Suche benötigt');
  }

  // Sources: the new list is only known after merging with what is stored, so
  // the "at least one source" rule is checked against the merged result.
  let sources = null;
  if (careerRows || boards) {
    const current = ((await readStore('jobs', debug)) || {}).sources || [];
    sources = current;
    if (careerRows) sources = mergeCareerSources(sources, careerRows);
    if (boards) sources = applyBoards(sources, { platforms: boards.platforms || [], keywords: boards.keywords || '',
      location: boards.location || '', radiusKm: boards.radiusKm ?? null });
    if (careerRows && step.fields.some(f => f.type === 'sources' && f.required) && sources.length === 0) {
      errors.push('Mindestens eine Quelle wird benötigt – eine Karriereseite oder eine Jobportal-Suche');
    }
  }

  if (errors.length) return { ok: false, error: errors.join(' · ') };

  // Apply writes, merging into the CURRENT values (DB-first, same precedence
  // the pipeline uses) so untouched fields survive. Non-debug writes go to the
  // default client's DB columns — the store the pipeline actually reads — and
  // to the legacy file, keeping both in sync.
  if (Object.keys(envUpdates).length) await writeEnv(debug, envUpdates);

  if (profile) {
    const merged = mergeDeep((await readStore('profile', debug)) || {}, profile);
    await writeJson(pathsFor('profile', debug).write, merged);
    if (!debug) updateClient(DEFAULT_CLIENT_ID, { profile_json: JSON.stringify(merged) });
  }
  if (sources) {
    await writeJson(pathsFor('jobs', debug).write, { sources });
    if (!debug) updateClient(DEFAULT_CLIENT_ID, { sources_json: JSON.stringify({ sources }) });
  }
  if (filters) {
    const merged = { ...((await readStore('filters', debug)) || {}), ...filters };
    await writeJson(pathsFor('filters', debug).write, merged);
    if (!debug) updateClient(DEFAULT_CLIENT_ID, { filters_json: JSON.stringify(merged) });
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
