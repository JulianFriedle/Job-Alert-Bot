// ── Where the app keeps its files ────────────────────────────────────────────
// APP_ROOT is where the code lives. From a git clone or the Docker image it is
// also where all state is written (.env, config/, data/, logs/) — unchanged
// from before this module existed.
//
// An installed desktop app lives in a read-only place (/Applications/…app,
// C:\Program Files\…, an AppImage), so the desktop shell sets APP_DATA_DIR to
// the OS's per-user app-data folder and every writable path moves there.
// Read-only assets that ship with the code (public/, *.example files) always
// stay under APP_ROOT.
//
// Deliberately free of imports from the rest of src/: env.js loads this before
// anything else, so it must not read .env-provided values at import time.

import path from 'path';
import { fileURLToPath } from 'url';

export const APP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const appDataDir = (process.env.APP_DATA_DIR || '').trim();

// Root of all writable state.
export const DATA_HOME = appDataDir ? path.resolve(appDataDir) : APP_ROOT;

export const DATA_DIR   = path.join(DATA_HOME, 'data');
export const CONFIG_DIR = path.join(DATA_HOME, 'config');
export const LOGS_DIR   = path.join(DATA_HOME, 'logs');
// Overridable so a sandbox instance (scripts/operator-sandbox.js) never writes
// the operator's real .env.
export const ENV_FILE   = process.env.ENV_FILE_PATH || path.join(DATA_HOME, '.env');

// True when running inside the desktop app (set by desktop/main.js).
export const IS_DESKTOP = process.env.JOB_ALERT_DESKTOP === '1';
