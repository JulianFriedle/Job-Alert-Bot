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
// It must not be able to unlock itself, loosen the auto-apply safety rails,
// redirect where notifications go, or thin out the backups.
export const PROTECTED_SETTINGS_KEYS = [
  'MCP_ALLOW_ACTIONS', 'MCP_API_TOKEN',
  'AUTO_APPLY_ENABLED', 'APPLY_DRY_RUN', 'APPLY_DAILY_CAP', 'APPLY_COOLDOWN_MINUTES', 'APPLY_HEADFUL',
  'CREDENTIALS_KEY',
  'AUTH_ENABLED', 'OPERATOR_USER', 'OPERATOR_PASSWORD_HASH', 'SESSION_SECRET',
  'GUI_PORT',
  // Where the job alerts go: a changed chat id sends the user's jobs to a stranger.
  'TELEGRAM_CHAT_ID',
  // Backups are off limits (FORBIDDEN_ROUTES); so is pruning them via retention.
  'BACKUP_ENABLED', 'BACKUP_RETENTION_DAYS',
  // Target of the "Problem melden" button.
  'ISSUE_REPO',
];

// Settings that make every later run cost more (pricier model, an extra paid
// pass per document, more runs). Writable only with the red button, like the
// action routes — the unattended scheduler would otherwise spend on them.
export const COST_SETTINGS_KEYS = ['ANALYZER_MODEL', 'COVER_LETTER_MODEL', 'DOCS_HUMANIZE', 'CRON_SCHEDULE'];

export const UNLOCK_HINT = 'Einstellungen → MCP-Server → roter Button „Kostenpflichtige KI-Aktionen freischalten“';

export const ACTIONS_REFUSAL =
  'Diese Aktion kann Kosten verursachen oder nach außen wirken und ist für den KI-Assistenten gesperrt. ' +
  `Der Nutzer muss sie selbst freischalten: ${UNLOCK_HINT}.`;

export const FORBIDDEN_REFUSAL =
  'Diese Funktion steht dem KI-Assistenten nicht zur Verfügung. Bitte direkt in der Job-Alert-GUI ausführen.';

export const PROTECTED_SETTING_REFUSAL =
  'Diese Einstellung kann der KI-Assistent nicht ändern (Sicherheitsregel). Bitte in der Job-Alert-GUI unter Einstellungen selbst ändern.';

export const COST_SETTING_REFUSAL =
  'Diese Einstellung beeinflusst die Kosten jedes weiteren Laufs und ist für den KI-Assistenten gesperrt. ' +
  `Der Nutzer kann sie selbst in der GUI ändern oder sie freischalten: ${UNLOCK_HINT}.`;

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

// Cost-relevant keys of an update while the actions are locked.
export function costGatedSettingKeys(keys, actionsEnabled = false) {
  return actionsEnabled ? [] : keys.filter(k => COST_SETTINGS_KEYS.includes(k));
}

// Why an assistant's settings update is refused, or null if it may be saved.
export function settingsRefusal(keys, schemaByKey = {}, actionsEnabled = false) {
  const refused = refusedSettingKeys(keys, schemaByKey);
  if (refused.length) return { keys: refused, error: `${PROTECTED_SETTING_REFUSAL} (${refused.join(', ')})` };
  const cost = costGatedSettingKeys(keys, actionsEnabled);
  if (cost.length) return { keys: cost, error: `${COST_SETTING_REFUSAL} (${cost.join(', ')})` };
  return null;
}

const isSecretField = (f, schemaByKey) => f.type === 'secret' || schemaByKey[f.key]?.type === 'secret';

// Wizard fields in a PUT /api/setup/step body an assistant may not write:
// secret fields (in the wizard OR in the settings schema — the wizard shows the
// Telegram chat id as plain text) and protected keys, when non-empty.
// `steps` is the wizard's STEPS array, `schemaByKey` the settings schema.
export function secretFieldsInStepBody(body, steps, schemaByKey = {}) {
  const step = (steps || []).find(s => s.id === body?.id);
  if (!step || !body.values || typeof body.values !== 'object') return [];
  return step.fields
    .filter(f => (isSecretField(f, schemaByKey) || PROTECTED_SETTINGS_KEYS.includes(f.key))
      && body.values[f.key] != null && String(body.values[f.key]).trim() !== '')
    .map(f => f.key);
}

// Cost-relevant wizard fields whose value would change while the actions are
// locked. A step is saved as a whole, so an unchanged value (`current(key)`)
// must not block the other answers of that step.
export function costFieldsInStepBody(body, steps, current, actionsEnabled = false) {
  if (actionsEnabled) return [];
  const step = (steps || []).find(s => s.id === body?.id);
  if (!step || !body.values || typeof body.values !== 'object') return [];
  return step.fields
    .filter(f => COST_SETTINGS_KEYS.includes(f.key) && body.values[f.key] != null
      && String(body.values[f.key]).trim() !== String(current(f.key) ?? '').trim())
    .map(f => f.key);
}

// The wizard saves a step as a whole: a field missing from the body is
// emptied. For the assistant, secret and protected env fields are therefore
// pinned to what is stored — it can neither change nor wipe them (a redacted
// chat id sent back empty would switch Telegram off). Secret wizard fields
// use '' = "leave unchanged". Returns a new body.
export function pinGuardedStepFields(body, steps, schemaByKey = {}, current = () => '') {
  const step = (steps || []).find(s => s.id === body?.id);
  if (!step || !body.values || typeof body.values !== 'object') return body;
  const values = { ...body.values };
  for (const f of step.fields || []) {
    if (f.store !== 'env') continue;
    if (f.type === 'secret') values[f.key] = '';
    else if (isSecretField(f, schemaByKey) || PROTECTED_SETTINGS_KEYS.includes(f.key)) values[f.key] = current(f.key) ?? '';
  }
  return { ...body, values };
}

// Blank the secret values in a /api/setup/status payload (keeps `isSet`), so an
// assistant never sees API keys, tokens or the Telegram chat id.
export function redactSetupSecrets(payload, schemaByKey = {}) {
  if (!payload || !Array.isArray(payload.steps)) return payload;
  return {
    ...payload,
    steps: payload.steps.map(step => {
      const values = { ...(step.values || {}) };
      const isSet = {};
      for (const f of step.fields || []) {
        if (!isSecretField(f, schemaByKey)) continue;
        isSet[f.key] = values[f.key] != null && String(values[f.key]) !== '';
        values[f.key] = '';
      }
      return Object.keys(isSet).length ? { ...step, values, secretsSet: isSet } : step;
    }),
  };
}
