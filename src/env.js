// Load .env before any other module reads process.env. Import this FIRST.
//
// From a clone or Docker this is plain `dotenv/config` (reads ./.env relative to
// the working directory), exactly as before. In the desktop app the .env lives
// in the per-user data folder instead — see paths.js.

import dotenv from 'dotenv';
import { ENV_FILE } from './paths.js';

if (process.env.APP_DATA_DIR) dotenv.config({ path: ENV_FILE });
else dotenv.config();
