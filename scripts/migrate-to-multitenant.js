import 'dotenv/config';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Importing database.js runs openDb(), which performs the idempotent schema
// migration (adds client_id + composite PK to jobs, backfills the default client
// on existing rows) and ensures the default client row exists.
import { getClient, updateClient, getTotals, DEFAULT_CLIENT_ID } from '../src/database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(__dirname, '..', 'config');

function log(msg) { console.log(`[migrate] ${msg}`); }

function readJson(file) {
  try { return JSON.parse(readFileSync(path.join(CONFIG_DIR, file), 'utf-8')); }
  catch { return null; }
}

log('Multi-tenant migration starting…');

// The default client now exists (created by openDb). Fill any still-empty config
// columns from the legacy config/*.json files + Telegram env, so the existing
// single-user setup is preserved as the "Privat" client. Idempotent: only writes
// columns that are currently null/empty.
const client = getClient(DEFAULT_CLIENT_ID);
const patch = {};

if (!client.profile_json) {
  const profile = readJson('profile.json');
  if (profile) { patch.profile_json = JSON.stringify(profile); log('Imported profile.json'); }
}
if (!client.sources_json) {
  const jobs = readJson('jobs.json');
  if (jobs && Array.isArray(jobs.sources)) { patch.sources_json = JSON.stringify({ sources: jobs.sources }); log(`Imported jobs.json (${jobs.sources.length} sources)`); }
}
if (!client.filters_json) {
  const filters = readJson('filters.json');
  if (filters) { patch.filters_json = JSON.stringify(filters); log('Imported filters.json'); }
}
if (!client.prompts_json) {
  const prompts = readJson('prompts.json');
  if (prompts && Object.keys(prompts).length) { patch.prompts_json = JSON.stringify(prompts); log('Imported prompts.json'); }
}

// Telegram target + toggles from the global env (operator's own chat for the
// private client). Only set when not already present.
if (!client.telegram_chat_id && process.env.TELEGRAM_CHAT_ID) {
  patch.telegram_chat_id = process.env.TELEGRAM_CHAT_ID;
  log('Imported TELEGRAM_CHAT_ID');
}
if (process.env.TELEGRAM_NOTIFICATIONS) patch.telegram_notifications = process.env.TELEGRAM_NOTIFICATIONS;
if (process.env.EXPIRY_NOTIFICATIONS) patch.expiry_notifications = process.env.EXPIRY_NOTIFICATIONS;

if (Object.keys(patch).length) {
  updateClient(DEFAULT_CLIENT_ID, patch);
  log(`Updated default client with: ${Object.keys(patch).join(', ')}`);
} else {
  log('Default client already populated — nothing to import.');
}

const totals = getTotals(DEFAULT_CLIENT_ID);
log(`Default client "${getClient(DEFAULT_CLIENT_ID).name}" now owns ${totals.total} job(s) (${totals.relevant} relevant).`);
log('Migration complete. Start the GUI with `npm run gui`.');
process.exit(0);
