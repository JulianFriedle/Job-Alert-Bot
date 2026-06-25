import crypto from 'crypto';

// Generate a scrypt hash for OPERATOR_PASSWORD_HASH (SaaS / AUTH_ENABLED mode).
//   npm run hash-password -- "mein-geheimes-passwort"
const password = process.argv[2];
if (!password) {
  console.error('Verwendung: npm run hash-password -- "<passwort>"');
  process.exit(1);
}

const salt = crypto.randomBytes(16);
const key = crypto.scryptSync(password, salt, 32);
const hash = `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;

console.log('\nIn die .env eintragen:\n');
console.log(`OPERATOR_PASSWORD_HASH=${hash}\n`);
