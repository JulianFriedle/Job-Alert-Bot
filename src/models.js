// Default Claude models — the single place to bump when a new generation ships.
// Callers read the env var at call time (so a change in Einstellungen applies
// without a restart) and fall back to these. SETTINGS_SCHEMA, .env.example and
// the README show the same values.

// Scores every scraped job, so it runs thousands of times: cheap and fast.
export const DEFAULT_ANALYZER_MODEL = 'claude-haiku-5-5';
// Writes cover letters and tailored CVs: a handful of calls, quality matters.
export const DEFAULT_WRITER_MODEL = 'claude-opus-5-5';

const fromEnv = (name, fallback) => String(process.env[name] ?? '').trim() || fallback;

export const analyzerModel = () => fromEnv('ANALYZER_MODEL', DEFAULT_ANALYZER_MODEL);
export const writerModel = () => fromEnv('COVER_LETTER_MODEL', DEFAULT_WRITER_MODEL);

// ── Available models for the settings dropdown (#43) ─────────────────────────
// The Models API lists what the configured key can use. It costs no tokens, is
// only asked when the Einstellungen tab opens, and is cached for an hour per
// key. Newest first, so a new generation shows up at the top.
const MODEL_CACHE_MS = 60 * 60 * 1000;
const modelCache = new Map(); // api key → { at, models }

export async function listAvailableModels({ apiKey = process.env.ANTHROPIC_API_KEY, makeClient, now = Date.now } = {}) {
  const key = String(apiKey ?? '').trim();
  if (!key) throw new Error('Kein Anthropic API-Key gesetzt');
  const hit = modelCache.get(key);
  if (hit && now() - hit.at < MODEL_CACHE_MS) return hit.models;
  const client = makeClient
    ? makeClient(key)
    : new (await import('@anthropic-ai/sdk')).default({ apiKey: key, maxRetries: 0, timeout: 15000 });
  const models = [];
  for await (const m of client.models.list({ limit: 100 })) {
    if (m?.id) models.push({ id: m.id, name: m.display_name || m.id, created: m.created_at || '' });
  }
  models.sort((a, b) => String(b.created).localeCompare(String(a.created)));
  modelCache.clear();   // one key at a time — an old key's list is of no use
  modelCache.set(key, { at: now(), models });
  return models;
}
