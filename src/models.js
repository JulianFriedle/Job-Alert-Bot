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
