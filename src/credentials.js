// Per-client job-board credentials, encrypted at rest with AES-256-GCM.
// The key comes from the CREDENTIALS_KEY env var (64 hex chars = 32 bytes),
// generated once via: npm run generate-credentials-key
// Blob format: base64(iv).base64(authTag).base64(ciphertext)
import 'dotenv/config';
import crypto from 'crypto';

import {
  getCredentialRow, listCredentialRows, setCredentialRow, deleteCredentialRow,
} from './database.js';

export const PLATFORMS = ['linkedin', 'stepstone', 'indeed'];

function getKey() {
  const hex = (process.env.CREDENTIALS_KEY || '').trim();
  if (!hex) {
    throw new Error(
      'CREDENTIALS_KEY ist nicht gesetzt. Einmalig erzeugen mit: npm run generate-credentials-key ' +
      'und in die Einstellungen (.env) eintragen.'
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('CREDENTIALS_KEY muss 64 Hex-Zeichen lang sein (32 Bytes).');
  }
  return Buffer.from(hex, 'hex');
}

export function isCredentialsKeySet() {
  return /^[0-9a-fA-F]{64}$/.test((process.env.CREDENTIALS_KEY || '').trim());
}

export function encrypt(plain) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf-8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${ct.toString('base64')}`;
}

export function decrypt(blob) {
  const key = getKey();
  const parts = String(blob || '').split('.');
  if (parts.length !== 3) throw new Error('Ungültiges Credential-Format.');
  const [iv, tag, ct] = parts.map(p => Buffer.from(p, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8');
}

// Store (or partially update — empty password keeps the existing one).
export function setPlatformCredentials(clientId, platform, email, password) {
  if (!PLATFORMS.includes(platform)) throw new Error(`Unbekannte Plattform: ${platform}`);
  setCredentialRow(clientId, platform, {
    email_enc: email ? encrypt(email) : null,
    password_enc: password ? encrypt(password) : null,
  });
}

// Decrypted credentials for the login flow (worker only — never for the GUI).
export function getPlatformCredentials(clientId, platform) {
  const row = getCredentialRow(clientId, platform);
  if (!row || !row.email_enc || !row.password_enc) return null;
  return {
    email: decrypt(row.email_enc),
    password: decrypt(row.password_enc),
    loginState: row.login_state,
    lastLoginAt: row.last_login_at,
  };
}

export function deletePlatformCredentials(clientId, platform) {
  deleteCredentialRow(clientId, platform);
}

// GUI-safe status list: shows the email (operator owns it) but NEVER the
// password — only whether one is stored.
export function listCredentialStatus(clientId) {
  const rows = listCredentialRows(clientId);
  const byPlatform = Object.fromEntries(rows.map(r => [r.platform, r]));
  return PLATFORMS.map(platform => {
    const r = byPlatform[platform];
    let email = '';
    if (r?.email_enc) {
      try { email = decrypt(r.email_enc); } catch { email = '(Schlüssel geändert?)'; }
    }
    return {
      platform,
      email,
      isSet: Boolean(r?.email_enc && r?.password_enc),
      loginState: r?.login_state || 'unknown',
      lastLoginAt: r?.last_login_at || null,
    };
  });
}
