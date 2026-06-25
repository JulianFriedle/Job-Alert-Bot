// ── Per-client configuration resolver ────────────────────────────────────────
// Each client stores its profile / job sources / filters / prompts as JSON in the
// `clients` table. This module turns a client row (or id) into ready-to-use config
// objects, applying sensible defaults.
//
// Backward compatibility: for the DEFAULT client, any field still empty in the DB
// falls back to the legacy config/*.json files, so an existing single-user install
// keeps working before (and even without) running the migration script.

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { getClient, DEFAULT_CLIENT_ID } from './database.js';
import { mergePrompts } from './prompts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(__dirname, '..', 'config');

// German-tuned defaults (formerly hard-coded in scheduler.js).
export const DEFAULT_TITLE_BLOCKLIST = [
  'praktikum', 'ausbildung', 'berufsausbildung', 'schulpraktikum', 'logistik', 'buchhaltung', ' sap ', 'accounting', 'werkschutz', 'küche',
  'duales studium', 'dualer student', 'kooperatives studium', 'sales', ' hr ', 'elektroniker', 'koch', 'facility', 'praktikant', ' erp ', 'schulpraktikant',
  'vertrieb', 'thesis', 'internship', 'abschlussarbeit', 'ferienhelfer', 'apprentice', 'werkstudent', 'ferienaushilfe', 'ausbilder', 'umkreissuche', 'auszubildender',
];
export const DEFAULT_PRIORITY_KEYWORDS = ['initiativbewerbung', 'initiativ', 'phd', 'doktorand', 'promotion', 'wissenschaftlicher mitarbeiter', 'wissenschaftliche mitarbeiterin'];

function readJsonFile(file) {
  try { return JSON.parse(readFileSync(path.join(CONFIG_DIR, file), 'utf-8')); }
  catch { return null; }
}

function parseJson(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch { return null; }
}

export function resolveClient(clientOrId) {
  if (typeof clientOrId === 'string') {
    const c = getClient(clientOrId);
    if (!c) throw new Error(`Unbekannter Klient: ${clientOrId}`);
    return c;
  }
  return clientOrId;
}

// Whether legacy config/*.json fallback applies (only for the default client).
function allowLegacyFallback(client) {
  return client.id === DEFAULT_CLIENT_ID;
}

export function getProfile(clientOrId) {
  const client = resolveClient(clientOrId);
  const fromDb = parseJson(client.profile_json);
  if (fromDb) return fromDb;
  if (allowLegacyFallback(client)) return readJsonFile('profile.json') || {};
  return {};
}

export function getSources(clientOrId) {
  const client = resolveClient(clientOrId);
  const fromDb = parseJson(client.sources_json);
  if (fromDb && Array.isArray(fromDb.sources)) return fromDb.sources;
  if (allowLegacyFallback(client)) {
    const legacy = readJsonFile('jobs.json');
    if (legacy && Array.isArray(legacy.sources)) return legacy.sources;
  }
  return [];
}

export function getFilters(clientOrId) {
  const client = resolveClient(clientOrId);
  let f = parseJson(client.filters_json);
  if (!f && allowLegacyFallback(client)) f = readJsonFile('filters.json');
  return {
    titleBlocklist:  Array.isArray(f?.titleBlocklist)  ? f.titleBlocklist  : DEFAULT_TITLE_BLOCKLIST,
    priorityKeywords: Array.isArray(f?.priorityKeywords) ? f.priorityKeywords : DEFAULT_PRIORITY_KEYWORDS,
  };
}

export function getPrompts(clientOrId) {
  const client = resolveClient(clientOrId);
  let overrides = parseJson(client.prompts_json);
  if (!overrides && allowLegacyFallback(client)) overrides = readJsonFile('prompts.json');
  return mergePrompts(overrides);
}

// Effective minimum relevance score: per-client override, else global env, else 4.
export function getMinRelevanceScore(clientOrId) {
  const client = resolveClient(clientOrId);
  if (client.min_relevance_score != null) return Number(client.min_relevance_score);
  const envRaw = process.env.MIN_RELEVANCE_SCORE;
  if (envRaw == null || envRaw.trim() === '') return 4;   // unset/blank → default
  const envScore = Number(envRaw);
  return Number.isFinite(envScore) ? envScore : 4;
}

// Everything the pipeline needs for one client, loaded once per run.
export function getClientConfig(clientOrId) {
  const client = resolveClient(clientOrId);
  return {
    client,
    profile:  getProfile(client),
    sources:  getSources(client),
    filters:  getFilters(client),
    prompts:  getPrompts(client),
    minRelevanceScore: getMinRelevanceScore(client),
  };
}
