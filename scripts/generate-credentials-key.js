// Print a fresh 32-byte hex key for encrypting platform credentials at rest.
// Usage: npm run generate-credentials-key
// Put the output into the .env as CREDENTIALS_KEY=<key> (or via the GUI
// settings tab). Changing the key later makes stored credentials unreadable —
// they must then be re-entered.
import crypto from 'crypto';

console.log(crypto.randomBytes(32).toString('hex'));
