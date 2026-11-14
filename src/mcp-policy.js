// ── MCP policy: what an AI assistant may do through the MCP server ──────────
// Shared by src/server.js (enforcement) and the MCP side (src/mcp-tools.js,
// early refusal with a helpful message). Pure — no imports, no I/O, so it can be
// unit-tested without starting anything.
//
// The MCP process talks to the GUI server over HTTP and marks every request
// with MCP_HEADER. The server then applies three rules to those requests:
//   1. "Action" routes (cost money / reach the outside world) need the red
//      button in Einstellungen (MCP_ALLOW_ACTIONS).
//   2. "Forbidden" routes are never reachable (approval of applications,
//      credentials, backups, …).
//   3. Settings that could unlock the assistant or loosen the auto-apply rails
//      can never be written.

export const MCP_HEADER = 'x-job-alert-mcp';

// Settings an assistant must never change — not even with actions unlocked.
// It must not be able to unlock itself or loosen the auto-apply safety rails.
export const PROTECTED_SETTINGS_KEYS = [
  'MCP_ALLOW_ACTIONS', 'MCP_API_TOKEN',
  'AUTO_APPLY_ENABLED', 'APPLY_DRY_RUN', 'APPLY_DAILY_CAP', 'APPLY_COOLDOWN_MINUTES', 'APPLY_HEADFUL',
  'CREDENTIALS_KEY',
  'AUTH_ENABLED', 'OPERATOR_USER', 'OPERATOR_PASSWORD_HASH', 'SESSION_SECRET',
  'GUI_PORT',
];

export const UNLOCK_HINT = 'Einstellungen → MCP-Server → roter Button „Kostenpflichtige KI-Aktionen freischalten“';

export const ACTIONS_REFUSAL =
  'Diese Aktion kann Kosten verursachen oder nach außen wirken und ist für den KI-Assistenten gesperrt. ' +
  `Der Nutzer muss sie selbst freischalten: ${UNLOCK_HINT}.`;

export const FORBIDDEN_REFUSAL =
  'Diese Funktion steht dem KI-Assistenten nicht zur Verfügung. Bitte direkt in der Job-Alert-GUI ausführen.';

export const PROTECTED_SETTING_REFUSAL =
  'Diese Einstellung kann der KI-Assistent nicht ändern (Sicherheitsregel). Bitte in der Job-Alert-GUI unter Einstellungen selbst ändern.';

// True only for an explicit opt-in value; anything else (unset, 'false', typos) = locked.
export function mcpActionsEnabled(env = process.env) {
  return ['true', '1', 'on', 'yes'].includes(String(env.MCP_ALLOW_ACTIONS || '').trim().toLowerCase());
}

const JOB = '[^/]+';

// Routes that cost money (Anthropic tokens) or reach the outside world
// (Telegram) or queue an application. Gated behind the red button.
const ACTION_ROUTES = [
  ['POST', /^\/api\/run$/],
  ['POST', /^\/api\/run\/stop$/],
  ['POST', new RegExp(`^/api/jobs/${JOB}/documents$`)],
  ['POST', new RegExp(`^/api/jobs/${JOB}/cover-letter$`)],
  ['POST', /^\/api\/setup\/test-telegram$/],
  ['POST', new RegExp(`^/api/clients/${JOB}/telegram-test$`)],
  ['POST', /^\/api\/applications$/],
];

export function isMcpActionRoute(method, pathname) {
  const m = String(method || '').toUpperCase();
  return ACTION_ROUTES.some(([rm, re]) => rm === m && re.test(pathname));
}

// Routes an assistant can never use, regardless of the red button.
// [method or '*' (every method) or '!GET' (every method except GET), pattern]
const FORBIDDEN_ROUTES = [
  // Submission stays with the human: approving, discarding, retrying, editing answers.
  ['POST', new RegExp(`^/api/applications/${JOB}/(approve|discard|retry)$`)],
  ['PUT', new RegExp(`^/api/applications/${JOB}$`)],
  // Secrets and stored logins.
  ['*', /^\/api\/credentials(\/|$)/],
  ['!GET', /^\/api\/cv$/],
  // Backups / restore, updates, restart.
  ['*', /^\/api\/backups(\/|$)/],
  ['*', /^\/api\/update$/],
  ['*', /^\/api\/restart$/],
  // Tenant management (the Telegram test is an action route, not this).
  ['POST', /^\/api\/clients$/],
  ['PUT', new RegExp(`^/api/clients/${JOB}$`)],
  ['DELETE', new RegExp(`^/api/clients/${JOB}$`)],
  // Documents: deleting, re-humanizing (an extra paid call), templates, assets.
  ['!GET', /^\/api\/documents\//],
  ['!GET', /^\/api\/doc-templates\//],
  ['!GET', /^\/api\/doc-assets\//],
  ['!GET', /^\/api\/factbase$/],
  // Finishing the wizard is the user's call.
  ['POST', /^\/api\/setup\/complete$/],
];

export function isMcpForbiddenRoute(method, pathname) {
  const m = String(method || '').toUpperCase();
  return FORBIDDEN_ROUTES.some(([rm, re]) => {
    if (!re.test(pathname)) return false;
    if (rm === '*') return true;
    if (rm === '!GET') return m !== 'GET' && m !== 'HEAD';
    return rm === m;
  });
}

// Keys of a settings update an assistant may not write: protected keys and
// anything the schema marks as secret. `schemaByKey` maps key → { type }.
export function refusedSettingKeys(keys, schemaByKey = {}) {
  return keys.filter(k => PROTECTED_SETTINGS_KEYS.includes(k) || schemaByKey[k]?.type === 'secret');
}

// Secret-typed wizard fields present (non-empty) in a PUT /api/setup/step body.
// `steps` is the wizard's STEPS array.
export function secretFieldsInStepBody(body, steps) {
  const step = (steps || []).find(s => s.id === body?.id);
  if (!step || !body.values || typeof body.values !== 'object') return [];
  return step.fields
    .filter(f => (f.type === 'secret' || PROTECTED_SETTINGS_KEYS.includes(f.key))
      && body.values[f.key] != null && String(body.values[f.key]).trim() !== '')
    .map(f => f.key);
}

// Blank the secret values in a /api/setup/status payload (keeps `isSet`), so an
// assistant never sees API keys or tokens.
export function redactSetupSecrets(payload) {
  if (!payload || !Array.isArray(payload.steps)) return payload;
  return {
    ...payload,
    steps: payload.steps.map(step => {
      const values = { ...(step.values || {}) };
      const isSet = {};
      for (const f of step.fields || []) {
        if (f.type !== 'secret') continue;
        isSet[f.key] = values[f.key] != null && String(values[f.key]) !== '';
        values[f.key] = '';
      }
      return Object.keys(isSet).length ? { ...step, values, secretsSet: isSet } : step;
    }),
  };
}
