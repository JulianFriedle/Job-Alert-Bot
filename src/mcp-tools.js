// ── MCP tools + prompts for the Job-Alert-Bot ───────────────────────────────
// Every tool talks to the running GUI server through an injected `api` object:
//   api.get(path, query) · api.put(path, body, query) · api.post(path, body, query)
// so the server keeps owning auth, client scoping, validation and run state, and
// tests can pass a fake. The real HTTP wrapper (createHttpApi) lives at the
// bottom of this file.
//
// Tiers (descriptions are German — the model reads them):
//   Lesen / Einrichtung & Profil / Pflege — always available, free and local.
//   Aktionen — cost money or reach the outside world; listed always, but they
//   refuse unless the user flipped the red button in Einstellungen. server.js
//   enforces that and answers with ACTIONS_REFUSAL, which the tool passes on.

import { readFile } from 'fs/promises';
import path from 'path';
import { APP_ROOT, DATA_DIR } from './paths.js';
import {
  PROTECTED_SETTINGS_KEYS, COST_SETTINGS_KEYS, MCP_HEADER, settingsRefusal, secretFieldsInStepBody,
} from './mcp-policy.js';

const PLATFORM_TYPES = ['linkedin', 'stepstone', 'indeed'];
const JOB_STATUSES = ['applied', 'interview', 'offer', 'rejected'];
const ACTION_PREFIX = '⚠ Kostenpflichtig/extern – nur nach Freischaltung in Einstellungen. ';

// ── small helpers ───────────────────────────────────────────────────────────
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const clamp = (n, lo, hi, dflt) => {
  const x = Number(n);
  return Number.isFinite(x) ? Math.min(Math.max(Math.round(x), lo), hi) : dflt;
};
const cut = (s, n) => {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};
const isEmptyValue = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);

// JSON merge-patch (RFC 7386): objects merge recursively, null deletes a key,
// everything else — arrays included — replaces.
export function mergePatch(target, patch) {
  if (!isObj(patch)) return patch;
  const out = isObj(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

function validateSource(s) {
  if (!isObj(s)) return 'Eine Quelle muss ein Objekt sein.';
  if (typeof s.name !== 'string' || !s.name.trim()) return 'Jede Quelle braucht einen Namen (name).';
  if (PLATFORM_TYPES.includes(s.type)) {
    if (!isObj(s.search) || typeof s.search.keywords !== 'string' || !s.search.keywords.trim())
      return `Quelle "${s.name}": Plattform-Quellen (${s.type}) brauchen search.keywords.`;
  } else if (typeof s.url !== 'string' || !/^https?:\/\//i.test(s.url.trim())) {
    return `Quelle "${s.name}": Karriereseiten brauchen eine url, die mit http:// oder https:// beginnt.`;
  }
  return null;
}

const schema = (properties = {}, required = []) => ({
  type: 'object',
  properties: {
    ...properties,
  },
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const CLIENT_PROP = {
  clientId: { type: 'string', description: 'Optional: Klienten-ID (siehe list_clients). Standard: der Standard-Klient bzw. MCP_CLIENT_ID.' },
};

// Compact setup status: what is open, which fields are missing. Never values of secrets.
export function summarizeSetupStatus(status) {
  const steps = (status.steps || []).map(step => {
    const values = step.values || {};
    const fields = (step.fields || []).map(f => {
      // Secret in the wizard, or redacted by the server (the Telegram chat id is
      // a plain text field in the wizard but secret in the settings schema).
      const secret = f.type === 'secret' || step.secretsSet?.[f.key] !== undefined;
      const set = secret ? Boolean(step.secretsSet?.[f.key] ?? !isEmptyValue(values[f.key])) : !isEmptyValue(values[f.key]);
      const out = { key: f.key, label: f.label, type: f.type, required: f.required, filled: set };
      if (secret) out.hinweis = 'Geheimnis – der Nutzer trägt es selbst in der GUI ein (Einstellungen), niemals im Chat.';
      else if (f.type === 'sources') out.value = `${(values[f.key] || []).length} Quelle(n)`;
      else out.value = values[f.key];
      if (f.options) out.options = f.options.map(o => o.value);
      if (f.help) out.help = cut(f.help, 200);
      return out;
    });
    return {
      id: step.id, title: step.title, required: step.required, complete: step.complete, pending: step.pending,
      missingRequired: fields.filter(f => f.required && !f.filled).map(f => f.key),
      fields,
    };
  });
  return {
    needed: status.needed,
    firstRun: status.firstRun,
    openSteps: steps.filter(s => s.pending).map(s => s.id),
    steps,
  };
}

// ── tools + prompts ─────────────────────────────────────────────────────────
// opts: { api, env, readTemplate } — all injectable for tests.
export function createToolkit({ api, env = process.env, readTemplate } = {}) {
  const defaultClient = (env.MCP_CLIENT_ID || '').trim() || undefined;
  const q = (args, extra = {}) => ({ clientId: (args?.clientId || '').trim() || defaultClient, ...extra });

  const tools = [];
  // Action tools are only marked here: server.js refuses them while locked.
  const add = (name, description, inputSchema, handler, { action = false } = {}) => {
    tools.push({ name, description: action ? ACTION_PREFIX + description : description, inputSchema, handler });
  };

  // ── Lesen ────────────────────────────────────────────────────────────────
  add('list_clients',
    'Listet die Klienten (Mandanten) der Job-Alert-GUI mit ID und Name. Kostenlos, nur lesend. Die meisten privaten Installationen haben nur den Klienten "default".',
    schema(),
    async () => {
      const r = await api.get('/api/clients');
      return {
        defaultClientId: r.defaultClientId,
        clients: (r.clients || []).map(c => ({ id: c.id, name: c.name, enabled: c.enabled })),
      };
    });

  add('get_overview',
    'Überblick: Gesamtzahlen (Jobs, relevante Jobs, Bewerbungen), Statusverteilung, Ergebnis der letzten Läufe und ob gerade ein Lauf aktiv ist. Kostenlos, nur lesend.',
    schema({ ...CLIENT_PROP }),
    async (args) => {
      const [stats, runStatus] = await Promise.all([api.get('/api/stats', q(args)), api.get('/api/run/status')]);
      return {
        run: runStatus,
        totals: stats.totals,
        lastRunsOverview: stats.overview,
        statusBreakdown: stats.statusBreak,
        recentRuns: (stats.runHistory || []).slice(-5),
      };
    });

  add('list_jobs',
    'Listet relevante Jobs als kompakte Zeilen (ohne Stellenbeschreibung – dafür get_job). Sortiert nach Bewerbungsstatus/Score. Filter werden clientseitig angewandt. Kostenlos, nur lesend.',
    schema({
      query: { type: 'string', description: 'Freitext, sucht in Titel und Firma (ohne Groß-/Kleinschreibung).' },
      minScore: { type: 'number', description: 'Mindest-Relevanz-Score (1–10).' },
      status: { type: 'string', enum: [...JOB_STATUSES, 'none'], description: 'Bewerbungsstatus; "none" = noch ohne Status.' },
      company: { type: 'string', description: 'Teilstring des Firmennamens.' },
      sinceDays: { type: 'number', description: 'Nur Jobs, die in den letzten N Tagen gefunden wurden.' },
      limit: { type: 'number', description: 'Max. Zeilen (Standard 30, maximal 200).' },
      ...CLIENT_PROP,
    }),
    async (args) => {
      let jobs = await api.get('/api/jobs', q(args));
      if (!Array.isArray(jobs)) jobs = [];
      const text = String(args.query || '').trim().toLowerCase();
      const company = String(args.company || '').trim().toLowerCase();
      const minScore = Number(args.minScore);
      const since = Number(args.sinceDays) > 0 ? Date.now() - Number(args.sinceDays) * 86_400_000 : null;
      jobs = jobs.filter(j => {
        if (text && !`${j.title || ''} ${j.company || ''}`.toLowerCase().includes(text)) return false;
        if (company && !String(j.company || '').toLowerCase().includes(company)) return false;
        if (Number.isFinite(minScore) && args.minScore != null && (j.score ?? 0) < minScore) return false;
        if (args.status === 'none' && j.status) return false;
        if (args.status && args.status !== 'none' && j.status !== args.status) return false;
        if (since != null) {
          const t = Date.parse(j.scraped_at || '');
          if (!Number.isFinite(t) || t < since) return false;
        }
        return true;
      });
      const limit = clamp(args.limit, 1, 200, 30);
      return {
        matching: jobs.length,
        shown: Math.min(jobs.length, limit),
        jobs: jobs.slice(0, limit).map(j => ({
          id: j.id, title: j.title, company: j.company, location: j.location, score: j.score,
          status: j.status || null, source: j.source, foundAt: j.scraped_at, url: j.url,
          summary: cut(j.summary, 240),
          applicationState: j.application_state || null,
          documents: j.documents || [],
        })),
      };
    });

  add('get_job',
    'Vollständige Details eines Jobs: Beschreibung, KI-Begründung/Zusammenfassung, Score, Status. Kostenlos, nur lesend.',
    schema({ jobId: { type: 'string', description: 'Job-ID aus list_jobs.' }, ...CLIENT_PROP }, ['jobId']),
    async (args) => api.get(`/api/jobs/${encodeURIComponent(args.jobId)}`, q(args)));

  add('list_runs',
    'Die letzten Pipeline-Läufe mit Kennzahlen (gefunden, neu, analysiert, relevant, benachrichtigt). Kostenlos, nur lesend.',
    schema({ limit: { type: 'number', description: 'Anzahl Läufe (Standard 10, max 100).' }, ...CLIENT_PROP }),
    async (args) => api.get('/api/runs', q(args, { limit: clamp(args.limit, 1, 100, 10) })));

  add('get_run_report',
    'Diagnosebericht zu einer Quelle in einem Lauf (Fehlermeldung, zuletzt gefundene Anzahl, Version) – nützlich, wenn eine Quelle 0 Jobs lieferte oder fehlschlug. Run-ID und Quellenname stammen aus list_runs. Sendet nichts an GitHub. Kostenlos, nur lesend.',
    schema({
      runId: { type: 'number', description: 'Lauf-ID aus list_runs.' },
      source: { type: 'string', description: 'Name der Quelle.' },
      ...CLIENT_PROP,
    }, ['runId', 'source']),
    async (args) => {
      const r = await api.get('/api/runs/report', q(args, { run: args.runId, source: args.source }));
      return { title: r.title, body: r.body, repo: r.repo };
    });

  add('get_run_status',
    'Ob gerade ein Pipeline-Lauf aktiv ist (und seit wann / ob er gerade gestoppt wird). Kostenlos, nur lesend.',
    schema(),
    async () => api.get('/api/run/status'));

  add('get_run_log',
    'Die letzten Zeilen des Live-Logs des aktuellen bzw. letzten Laufs (nur im Speicher der GUI, nach einem Neustart leer). Kostenlos, nur lesend.',
    schema({ tail: { type: 'number', description: 'Anzahl Zeilen (Standard 100, max 800).' } }),
    async (args) => api.get('/api/run/logs', { tail: clamp(args.tail, 1, 800, 100) }));

  add('list_applications',
    'Die Bewerbungs-Warteschlange (vorbereitete/laufende/gesendete Bewerbungen) mit Status. Freigeben, Verwerfen oder Wiederholen kann nur der Nutzer selbst in der GUI. Kostenlos, nur lesend.',
    schema({ state: { type: 'string', description: 'Optional: nur Bewerbungen in diesem Status (z. B. ready_for_review).' }, ...CLIENT_PROP }),
    async (args) => {
      const r = await api.get('/api/applications', q(args, { state: args.state || undefined }));
      return (r.applications || []).map(a => ({
        id: a.id, jobId: a.job_id, title: a.title, company: a.company, platform: a.platform,
        state: a.state, attempts: a.attempts, error: a.error || null, createdAt: a.created_at,
      }));
    });

  add('get_document_status',
    'Welche angepassten Dokumente (Lebenslauf/Anschreiben) für einen Job existieren und ob gerade eine Erstellung läuft. Kostenlos, nur lesend.',
    schema({ jobId: { type: 'string', description: 'Job-ID.' }, ...CLIENT_PROP }, ['jobId']),
    async (args) => {
      const r = await api.get(`/api/jobs/${encodeURIComponent(args.jobId)}/documents`, q(args));
      return {
        status: r.status,
        humanize: r.humanize,
        documents: (r.documents || []).map(({ markdown, html, ...rest }) => rest),
      };
    });

  // ── Einrichtung & Profil ─────────────────────────────────────────────────
  add('get_setup_status',
    'Stand des Einrichtungs-Assistenten: welche Schritte offen sind und welche Pflichtfelder fehlen. Geheimnisse (API-Schlüssel, Tokens) werden nie angezeigt, nur ob sie gesetzt sind. Kostenlos, nur lesend.',
    schema(),
    async () => summarizeSetupStatus(await api.get('/api/setup/status')));

  add('save_setup_step',
    'Speichert die Antworten eines Einrichtungsschritts (id aus get_setup_status). Werte sind ein Objekt { feldKey: wert }; Listen als Array. Betrifft immer den Standard-Klienten. Felder vom Typ "secret" (API-Schlüssel, Bot-Token) und die Telegram-Chat-ID werden abgelehnt: diese gibt der Nutzer selbst in der GUI ein – niemals im Chat. Kostenrelevante Felder (Zeitplan CRON_SCHEDULE, Mindest-Score MIN_RELEVANCE_SCORE, Telegram-Benachrichtigungen an/aus) nur ändern, wenn die KI-Aktionen freigeschaltet sind; sonst ihren bisherigen Wert lassen (einfach weglassen). Mit skip=true wird ein optionaler Schritt übersprungen. Kostenlos, lokal.',
    schema({
      stepId: { type: 'string', description: 'Schritt-ID, z. B. "profile" oder "sources".' },
      values: { type: 'object', description: 'Feld-Werte { key: wert }.' },
      skip: { type: 'boolean', description: 'Optionalen Schritt überspringen.' },
    }, ['stepId']),
    async (args) => {
      const status = await api.get('/api/setup/status');
      const step = (status.steps || []).find(s => s.id === args.stepId);
      if (!step) throw new Error(`Unbekannter Schritt "${args.stepId}". Gültig: ${(status.steps || []).map(s => s.id).join(', ')}`);
      const values = isObj(args.values) ? args.values : {};
      const byKey = Object.fromEntries((step.fields || []).map(f => [f.key, f]));
      const secrets = secretFieldsInStepBody({ id: step.id, values }, [step]);
      if (secrets.length) {
        throw new Error(`Die Felder ${secrets.join(', ')} sind geheim bzw. geschützt und können nicht über den Assistenten gesetzt werden. ` +
          'Bitte den Nutzer, sie selbst in der Job-Alert-GUI einzutragen (Einstellungen oder Einrichtungs-Assistent) – niemals Schlüssel im Chat teilen.');
      }
      const unknown = Object.keys(values).filter(k => !byKey[k]);
      if (unknown.length) throw new Error(`Unbekannte Felder für Schritt "${step.id}": ${unknown.join(', ')}. Gültig: ${Object.keys(byKey).join(', ')}`);
      // The wizard saves a step as a whole and empties every field it doesn't
      // get: keep the effective answers of the fields not passed. The status
      // shows an unset setting as '' — its effective value is the default (an
      // empty toggle would be saved as "off", an empty schedule as a change).
      // Secrets and the redacted ones stay out — the server keeps their stored
      // values.
      const keep = {};
      for (const f of step.fields || []) {
        if (f.type === 'secret' || step.secretsSet?.[f.key] !== undefined || f.key in values) continue;
        if (!step.values || !(f.key in step.values)) continue;
        const v = step.values[f.key];
        // Only for .env settings, where empty already means the default; an
        // unanswered profile field (e.g. the AI output language) stays unset.
        keep[f.key] = (f.store === 'env' && isEmptyValue(v) && f.default != null && f.default !== '') ? f.default : v;
      }
      const r = await api.put('/api/setup/step', { id: step.id, values: { ...keep, ...values }, skip: Boolean(args.skip) });
      const summary = summarizeSetupStatus(r.status || {});
      return { ok: true, openSteps: summary.openSteps, step: summary.steps.find(s => s.id === step.id) };
    });

  add('get_profile',
    'Das aktuelle Profil (Lebenslauf + Präferenzen) des Klienten, das die KI zum Bewerten der Jobs nutzt, plus die Versionskennung. Kostenlos, nur lesend.',
    schema({ ...CLIENT_PROP }),
    async (args) => api.get('/api/profile', q(args)));

  add('get_profile_template',
    'Die Beispiel-Vorlage config/profile.example.json (Struktur und Felder des Profils mit Platzhaltern). Dient als Gerüst, um ein Profil aus einem Lebenslauf zu füllen. Kostenlos, nur lesend.',
    schema(),
    async () => {
      const raw = readTemplate ? await readTemplate() : await readFile(path.join(APP_ROOT, 'config', 'profile.example.json'), 'utf-8');
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    });

  add('update_profile',
    'Ändert das Profil per JSON-Merge-Patch: übergebene Objekte werden mit dem bestehenden Profil zusammengeführt, Arrays ersetzen das bestehende Array komplett, null löscht ein Feld. Es wird die Version aus dem aktuellen Profil mitgeschickt – wurde das Profil inzwischen anderswo geändert, kommt ein Konflikt (dann get_profile neu lesen). Vor dem Speichern dem Nutzer zeigen und bestätigen lassen. Kostenlos, lokal.',
    schema({
      patch: { type: 'object', description: 'Merge-Patch, z. B. { "preferences": { "locations": ["München"] } }.' },
      ...CLIENT_PROP,
    }, ['patch']),
    async (args) => {
      if (!isObj(args.patch)) throw new Error('patch muss ein Objekt sein.');
      const cur = await api.get('/api/profile', q(args));
      const merged = mergePatch(cur.profile || {}, args.patch);
      const r = await api.put('/api/profile', { profile: merged, baseVersion: cur.version }, q(args));
      return { ok: true, version: r.version, changedTopLevelKeys: Object.keys(args.patch) };
    });

  add('get_sources',
    'Die Jobquellen (Karriereseiten und Portal-Suchen) des Klienten plus Versionskennung. Kostenlos, nur lesend.',
    schema({ ...CLIENT_PROP }),
    async (args) => api.get('/api/sources', q(args)));

  add('update_sources',
    'Ersetzt die komplette Quellenliste. Vorher get_sources aufrufen und dessen version als baseVersion übergeben (Konflikterkennung). Karriereseite: { name, url, type: "careers-page" }; Portal-Suche: { name, type: "linkedin"|"stepstone"|"indeed", search: { keywords, location } }. Zum Ergänzen einer einzelnen Quelle besser add_source. Kostenlos, lokal.',
    schema({
      sources: { type: 'array', items: { type: 'object' }, description: 'Die vollständige neue Liste.' },
      baseVersion: { type: 'string', description: 'version aus get_sources.' },
      ...CLIENT_PROP,
    }, ['sources', 'baseVersion']),
    async (args) => {
      if (!Array.isArray(args.sources)) throw new Error('sources muss ein Array sein.');
      for (const s of args.sources) { const e = validateSource(s); if (e) throw new Error(e); }
      return api.put('/api/sources', { sources: args.sources, baseVersion: args.baseVersion }, q(args));
    });

  add('add_source',
    'Fügt eine einzelne Quelle zur bestehenden Liste hinzu. Karriereseite: { name, url } (type wird "careers-page"); Portal-Suche: { name, type: "linkedin"|"stepstone"|"indeed", search: { keywords, location } }. Doppelte URLs werden abgelehnt. Kostenlos, lokal (scrapt erst beim nächsten Lauf).',
    schema({ source: { type: 'object', description: 'Die neue Quelle.' }, ...CLIENT_PROP }, ['source']),
    async (args) => {
      const source = isObj(args.source) ? { type: 'careers-page', ...args.source } : args.source;
      const err = validateSource(source);
      if (err) throw new Error(err);
      const cur = await api.get('/api/sources', q(args));
      const list = cur.sources || [];
      if (source.url && list.some(s => s?.url && s.url.trim() === source.url.trim()))
        throw new Error(`Die URL ist bereits als Quelle eingetragen: ${source.url}`);
      const r = await api.put('/api/sources', { sources: [...list, source], baseVersion: cur.version }, q(args));
      return { ok: true, count: r.count, version: r.version };
    });

  add('get_filters',
    'Die Vorfilter des Klienten (titleBlocklist, priorityKeywords, titleAllowlist, locationAllowlist) plus Versionskennung. Kostenlos, nur lesend.',
    schema({ ...CLIENT_PROP }),
    async (args) => api.get('/api/filters', q(args)));

  add('update_filters',
    'Ändert Vorfilter. Übergeben werden nur die Listen, die sich ändern sollen (titleBlocklist, priorityKeywords, titleAllowlist, locationAllowlist); jede übergebene Liste ersetzt die bestehende komplett. Kostenlos, lokal.',
    schema({
      titleBlocklist: { type: 'array', items: { type: 'string' } },
      priorityKeywords: { type: 'array', items: { type: 'string' } },
      titleAllowlist: { type: 'array', items: { type: 'string' } },
      locationAllowlist: { type: 'array', items: { type: 'string' } },
      ...CLIENT_PROP,
    }),
    async (args) => {
      const keys = ['titleBlocklist', 'priorityKeywords', 'titleAllowlist', 'locationAllowlist'];
      const patch = {};
      for (const k of keys) {
        if (args[k] === undefined) continue;
        if (!Array.isArray(args[k])) throw new Error(`${k} muss eine Liste sein.`);
        patch[k] = args[k];
      }
      if (!Object.keys(patch).length) throw new Error('Keine Liste übergeben.');
      const cur = await api.get('/api/filters', q(args));
      const r = await api.put('/api/filters', { filters: { ...cur.filters, ...patch }, baseVersion: cur.version }, q(args));
      return { ok: true, version: r.version, changed: Object.keys(patch) };
    });

  add('get_prompts',
    'Die KI-Prompts des Klienten (Relevanzbewertung, Dokumente usw.) mit Feldbeschreibungen. Nur lesend; Ändern geht in der GUI (Tab Prompts). Kostenlos.',
    schema({ ...CLIENT_PROP }),
    async (args) => {
      const r = await api.get('/api/prompts', q(args));
      return { fields: (r.fields || []).map(f => ({ key: f.key, label: f.label })), prompts: r.prompts, version: r.version };
    });

  add('get_settings',
    'Die Einstellungen (.env) mit aktuellem Wert. Geheime Werte (API-Schlüssel, Tokens, Chat-ID) werden nie angezeigt, nur ob sie gesetzt sind. Geschützte Einstellungen (Auto-Bewerbung, Login, MCP-Freischaltung, Datensicherung) sind als locked markiert und für den Assistenten nicht änderbar; kostenrelevante (Modelle, Humanize, Zeitplan, Mindest-Score, Mindest-Beschreibungslänge, Telegram an/aus) als requiresUnlock – die gehen nur mit freigeschalteten KI-Aktionen. Kostenlos, nur lesend.',
    schema(),
    async () => {
      const r = await api.get('/api/settings');
      return (r.settings || []).map(s => {
        const secret = s.type === 'secret';
        const row = { key: s.key, group: s.group, label: s.label, type: s.type, default: s.default };
        if (secret) row.isSet = Boolean(s.isSet);
        else row.value = s.value;
        if (secret || PROTECTED_SETTINGS_KEYS.includes(s.key)) row.locked = true;
        else if (COST_SETTINGS_KEYS.includes(s.key)) row.requiresUnlock = true;
        return row;
      });
    });

  add('update_settings',
    'Ändert Einstellungen (.env) als { KEY: wert }. Nicht erlaubt: geheime Felder (API-Schlüssel, Tokens, Chat-ID – die trägt der Nutzer selbst in der GUI ein) und geschützte Einstellungen (Auto-Bewerbung, Login, MCP-Freischaltung, Port, Datensicherung). Kostenrelevante Einstellungen (Modelle, DOCS_HUMANIZE, Zeitplan, MIN_RELEVANCE_SCORE, MIN_DESCRIPTION_CHARS, TELEGRAM_NOTIFICATIONS, EXPIRY_NOTIFICATIONS) nur bei freigeschalteten KI-Aktionen. Ein leerer Wert setzt auf den Standard zurück. Kostenlos, lokal; wirkt ab dem nächsten Lauf.',
    schema({ settings: { type: 'object', description: 'Zu ändernde Einstellungen { KEY: wert }.' } }, ['settings']),
    async (args) => {
      const updates = isObj(args.settings) ? args.settings : null;
      if (!updates || !Object.keys(updates).length) throw new Error('settings muss ein nicht-leeres Objekt sein.');
      // Same rules as the server (mcp-policy.js), checked early for a clear
      // message: protected keys need no lookup, secrets need the schema types.
      // The cost gate is left to the server, which knows the unlock state.
      const keys = Object.keys(updates);
      const early = settingsRefusal(keys, {}, true);
      if (early) throw new Error(early.error);
      const current = await api.get('/api/settings');
      const byKey = Object.fromEntries((current.settings || []).map(s => [s.key, s]));
      const unknown = keys.filter(k => !byKey[k]);
      if (unknown.length) throw new Error(`Unbekannte Einstellung(en): ${unknown.join(', ')}`);
      const refusal = settingsRefusal(keys, byKey, true);
      if (refusal) throw new Error(`${refusal.error} Geheime Werte trägt der Nutzer selbst in der GUI ein – niemals Schlüssel im Chat teilen.`);
      await api.put('/api/settings', { settings: updates });
      return { ok: true, changed: Object.keys(updates) };
    });

  // ── Pflege ───────────────────────────────────────────────────────────────
  add('set_job_status',
    'Setzt den Bewerbungsstatus eines Jobs (applied, interview, offer, rejected) oder löscht ihn (status weglassen oder "clear"). Kostenlos, lokal – es wird nichts versendet.',
    schema({
      jobId: { type: 'string' },
      status: { type: 'string', enum: [...JOB_STATUSES, 'clear'], description: '"clear" oder weglassen = Status entfernen.' },
      ...CLIENT_PROP,
    }, ['jobId']),
    async (args) => {
      const status = args.status && args.status !== 'clear' ? args.status : null;
      if (status && !JOB_STATUSES.includes(status)) throw new Error(`Ungültiger Status. Erlaubt: ${JOB_STATUSES.join(', ')}, clear`);
      const job = await api.post(`/api/jobs/${encodeURIComponent(args.jobId)}/status`, { status }, q(args));
      return { ok: true, id: job.id, title: job.title, status: job.status || null };
    });

  add('ignore_job',
    'Markiert einen Job als nicht relevant (verschwindet aus der Jobliste). Kostenlos, lokal.',
    schema({ jobId: { type: 'string' }, ...CLIENT_PROP }, ['jobId']),
    async (args) => api.post(`/api/jobs/${encodeURIComponent(args.jobId)}/ignore`, {}, q(args)));

  add('add_manual_job',
    'Legt eine Stelle von Hand an (z. B. von einer Seite, die der Bot nicht kennt), damit dafür Unterlagen erstellt werden können. Ruft keine KI auf – kostenlos, lokal.',
    schema({
      title: { type: 'string' }, company: { type: 'string' }, url: { type: 'string', description: 'Optional, http(s)://…' },
      location: { type: 'string' }, description: { type: 'string', description: 'Stellenbeschreibung als Text.' },
      ...CLIENT_PROP,
    }, ['title']),
    async (args) => api.post('/api/jobs/manual', {
      title: args.title, company: args.company, url: args.url, location: args.location, description: args.description,
    }, q(args)));

  // ── Aktionen (nur nach Freischaltung) ────────────────────────────────────
  add('start_run',
    'Startet einen Pipeline-Lauf (scrapen, KI-Analyse, Benachrichtigung). Kostet Anthropic-Tokens pro neu analysiertem Job (bei großem Rückstand schnell mehrere Euro) und kann Telegram-Nachrichten auslösen. Vorher dem Nutzer sagen, was passiert. Mit all=true für alle Klienten.',
    schema({ all: { type: 'boolean', description: 'Alle aktiven Klienten statt nur einen.' }, ...CLIENT_PROP }),
    async (args) => api.post('/api/run', {}, q(args, args.all ? { all: '1' } : {})),
    { action: true });

  add('stop_run',
    'Stoppt den laufenden Pipeline-Lauf (sauber am nächsten Quellen-/Seitenwechsel; bereits bezahlte Ergebnisse bleiben erhalten).',
    schema(),
    async () => api.post('/api/run/stop', {}),
    { action: true });

  add('generate_documents',
    'Erstellt einen angepassten Lebenslauf und ein Anschreiben für einen Job. Läuft im Hintergrund, nutzt das stärkere (teurere) Modell mit bis zu 4 Aufrufen pro Klick. Fortschritt mit get_document_status.',
    schema({
      jobId: { type: 'string' },
      kinds: { type: 'array', items: { type: 'string', enum: ['cv', 'cover'] }, description: 'Standard: beide.' },
      notes: { type: 'string', description: 'Optionale Hinweise für die KI.' },
      ...CLIENT_PROP,
    }, ['jobId']),
    async (args) => api.post(`/api/jobs/${encodeURIComponent(args.jobId)}/documents`,
      { kinds: args.kinds, notes: args.notes }, q(args)),
    { action: true });

  add('generate_cover_letter',
    'Erzeugt einen Anschreiben-Text für einen Job (ein Aufruf des stärkeren, teureren Modells; wird nicht gespeichert, sondern nur zurückgegeben).',
    schema({ jobId: { type: 'string' }, notes: { type: 'string', description: 'Optionale Hinweise.' }, ...CLIENT_PROP }, ['jobId']),
    async (args) => api.post(`/api/jobs/${encodeURIComponent(args.jobId)}/cover-letter`, { notes: args.notes }, q(args)),
    { action: true });

  add('send_telegram_test',
    'Sendet eine echte Telegram-Testnachricht an die Chat-ID des Klienten. Erreicht reale Personen/Geräte.',
    schema({ ...CLIENT_PROP }),
    async (args) => {
      const id = (args.clientId || '').trim() || defaultClient || 'default';
      return api.post(`/api/clients/${encodeURIComponent(id)}/telegram-test`, {});
    },
    { action: true });

  add('enqueue_application',
    'Stellt eine Bewerbung für einen Plattform-Job (LinkedIn/StepStone/Indeed) in die Warteschlange – das heißt nur "vorbereiten", nie "absenden". Gesendet wird erst, wenn der Nutzer sie selbst in der GUI/Telegram freigibt (und nur ohne Probelauf).',
    schema({ jobId: { type: 'string' }, ...CLIENT_PROP }, ['jobId']),
    async (args) => api.post('/api/applications', { jobId: args.jobId }, q(args)),
    { action: true });

  // ── Prompts ──────────────────────────────────────────────────────────────
  const prompts = [
    {
      name: 'einrichtung',
      description: 'Führt Schritt für Schritt durch die Ersteinrichtung der Job-Alert-GUI.',
      get: () => [
        'Du hilfst dem Nutzer bei der Ersteinrichtung seines Job-Alert-Bots. Gehe so vor:',
        '1. Rufe get_setup_status auf und fasse kurz zusammen, welche Schritte offen sind (Pflichtschritte zuerst).',
        '2. Arbeite die offenen Schritte einzeln mit dem Nutzer ab: stelle pro Schritt wenige, konkrete Fragen, speichere die Antworten mit save_setup_step und bestätige kurz, was gespeichert wurde.',
        '3. Frage NIEMALS nach API-Schlüsseln, Bot-Tokens oder Passwörtern und nimm sie nicht im Chat entgegen. Verweise stattdessen auf die GUI: Einstellungen (bzw. der Einrichtungs-Assistent) → dort trägt der Nutzer sie selbst ein. Felder vom Typ "secret" lehnt das Werkzeug ohnehin ab.',
        '4. Karriereseiten, die der Nutzer beobachten möchte, trägst du mit add_source ein (Name + URL). Portal-Suchen (LinkedIn/StepStone/Indeed) gehen mit dem passenden Schritt.',
        '5. Für das Profil nutze den Prompt "profil_aus_lebenslauf" oder frage die Angaben direkt ab.',
        '6. Starte keine Läufe und löse nichts Kostenpflichtiges aus – das ist nur nach Freischaltung durch den Nutzer in den Einstellungen möglich. Zum Schluss: get_setup_status erneut prüfen und den Rest benennen.',
      ].join('\n'),
    },
    {
      name: 'profil_aus_lebenslauf',
      description: 'Füllt das Profil aus einem Lebenslauf, den der Nutzer in den Chat legt – mit Bestätigung vor dem Speichern.',
      get: () => [
        'Der Nutzer hängt gleich seinen Lebenslauf an oder fügt ihn als Text ein (bitte darum, falls noch nicht geschehen). Gehe so vor:',
        '1. Rufe get_profile_template (Struktur) und get_profile (aktueller Stand) auf.',
        '2. Erarbeite daraus ein gefülltes Profil nach der Struktur der Vorlage. Erfinde nichts: Was im Lebenslauf nicht steht, bleibt weg oder wird als Frage an den Nutzer formuliert (z. B. gewünschte Rollen, Orte, Gehaltsvorstellung, Ausschlusskriterien).',
        '3. Zeige dem Nutzer eine verständliche Zusammenfassung dessen, was du eintragen würdest (und was du bewusst offen lässt).',
        '4. Erst nach seiner ausdrücklichen Bestätigung rufst du update_profile mit dem Patch auf. Beachte: Arrays ersetzen das bestehende Array komplett.',
        '5. Gib danach kurz zurück, was gespeichert wurde. Kein Lebenslauf-Inhalt gehört in Logs oder Issues.',
      ].join('\n'),
    },
    {
      name: 'jobs_der_woche',
      description: 'Zusammenfassung der relevantesten Jobs der letzten 7 Tage.',
      get: () => [
        'Rufe list_jobs mit sinceDays=7 auf (limit 50). Sortiere die Treffer nach Score und fasse die interessantesten zusammen:',
        '- pro Job eine Zeile: Titel, Firma, Ort, Score, warum er passt (aus summary), Link;',
        '- danach 2–3 Sätze Einordnung (Häufungen bei Firmen/Orten, auffällig starke Treffer);',
        '- frage zum Schluss, ob für einen Job get_job-Details, ein Status (set_job_status) oder das Ausblenden (ignore_job) gewünscht ist.',
        'Löse keine kostenpflichtigen Aktionen aus.',
      ].join('\n'),
    },
  ];

  return { tools, prompts };
}

// ── Launch command for the connection snippets in Einstellungen ─────────────
// Normally the running binary + the script. A Linux AppImage runs from a mount
// point (/tmp/.mount_XXXX) that changes on every start, so a snippet naming it
// would break with the next launch: there, start the AppImage file itself
// ($APPIMAGE, stable) and resolve the script against the APPDIR its runtime
// sets for that launch.
export function mcpLaunchCommand({ execPath, scriptPath, env = process.env }) {
  const appImage = (env.APPIMAGE || '').trim();
  const appDir = (env.APPDIR || '').trim();
  if (appImage && appDir) {
    const rel = path.relative(appDir, scriptPath);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      const code = `import(require('url').pathToFileURL(require('path').join(process.env.APPDIR, ${JSON.stringify(rel)})).href)`;
      return { command: appImage, args: ['-e', code] };
    }
  }
  return { command: execPath, args: [scriptPath] };
}

// ── Real API wrapper: HTTP against the running GUI ──────────────────────────
// Resolution order for the base URL: JOB_ALERT_URL → the endpoint file the GUI
// server writes on start (the desktop app picks a free port) → GUI_PORT/3000.
export function endpointFilePath() {
  return path.join(DATA_DIR, 'mcp-endpoint.json');
}

// Is the process that wrote the endpoint file still running? After a crash the
// file stays behind, and another program may own that port by now — it must
// not get our requests (or the token).
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return err?.code === 'EPERM'; }
}

// An endpoint file means a desktop install, whose GUI port is picked at start:
// then it is the only address. A stale one (the app is closed) yields none —
// guessing GUI_PORT/3000 would hand the request and the bearer token to
// whatever else listens there. Without the file (git/Docker install) the
// configured GUI_PORT is the GUI's address.
export async function candidateBases(env, readFileImpl, isAlive = pidAlive) {
  const explicit = (env.JOB_ALERT_URL || '').trim();
  if (explicit) return [explicit.replace(/\/+$/, '')];
  let info = null;
  try { info = JSON.parse(await readFileImpl(endpointFilePath(), 'utf-8')); }
  catch { /* no endpoint file – not the desktop app */ }
  if (info && typeof info.url === 'string' && info.url) {
    return isAlive(info.pid) ? [info.url.replace(/\/+$/, '')] : [];
  }
  return [`http://127.0.0.1:${env.GUI_PORT || 3000}`];
}

export function createHttpApi({ env = process.env, fetchImpl = globalThis.fetch, readFileImpl = readFile, timeoutMs = 120_000 } = {}) {
  async function request(method, pathname, { query, body } = {}) {
    const bases = await candidateBases(env, readFileImpl);
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    const suffix = pathname + (qs.size ? `?${qs}` : '');
    const headers = { [MCP_HEADER]: '1', Accept: 'application/json' };
    if (env.MCP_API_TOKEN) headers.Authorization = `Bearer ${env.MCP_API_TOKEN}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let res = null;
    for (const base of bases) {
      try {
        res = await fetchImpl(base + suffix, {
          method, headers, body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        break;
      } catch (err) {
        if (err?.name === 'TimeoutError') throw new Error(`Zeitüberschreitung bei ${method} ${pathname} (${base}).`);
        /* connection refused etc. – try the next candidate */
      }
    }
    if (!bases.length) throw new Error('Job-Alert-App läuft nicht (keine laufende GUI gefunden) – bitte die App starten.');
    if (!res) throw new Error(`Job-Alert-GUI nicht erreichbar unter ${bases.join(' bzw. ')} – läuft die App?`);

    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      let msg = data?.error || `HTTP ${res.status}`;
      if (res.status === 401) msg += ' – ist AUTH_ENABLED aktiv? Dann MCP_API_TOKEN in den Einstellungen setzen und denselben Wert in der MCP-Konfiguration (.env) verwenden.';
      throw new Error(msg);
    }
    return data;
  }
  return {
    get: (p, query) => request('GET', p, { query }),
    put: (p, body, query) => request('PUT', p, { body, query }),
    post: (p, body, query) => request('POST', p, { body: body ?? {}, query }),
  };
}
