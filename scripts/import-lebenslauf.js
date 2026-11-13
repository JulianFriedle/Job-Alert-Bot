// One-off import of a "Lebenslauf" repository (Markdown CV workflow) into a client:
//
//   npm run import-lebenslauf -- <pfad-zum-repo> [--client <id>] [--force]
//
// Takes over:
//   profil.md                          → fact base
//   bewerbung/lebenslauf.md            → CV base template
//   bewerbung/anschreiben.md           → cover-letter base template
//   bewerbung/foto.*, unterschrift.*   → images
//   log/index.md + log/*.md snapshots  → one manual job per application, with its
//                                        status, date and the stored documents
//
// Existing fact base / templates / images are only overwritten with --force.
// Re-running is safe: already imported applications are skipped.
// Makes no network or API calls.

import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

import {
  getClient, updateClient, getClientAsset, setClientAsset, getJobById, createManualJob,
  setApplicationStatus, createDocument, DEFAULT_CLIENT_ID,
} from '../src/database.js';
import { splitFrontmatter } from '../src/markdown-doc.js';

function log(msg) {
  console.log(`[${new Date().toISOString()}] [import] ${msg}`);
}

// ── Arguments ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const force = args.includes('--force');
if (force) args.splice(args.indexOf('--force'), 1);
const clientId = flag('--client') || DEFAULT_CLIENT_ID;
const repo = args[0] ? path.resolve(args[0]) : null;

if (!repo || !existsSync(repo)) {
  console.error('Fehler: Pfad zum Lebenslauf-Repo fehlt oder existiert nicht.\n' +
    '  Verwendung: npm run import-lebenslauf -- <pfad> [--client <id>] [--force]');
  process.exit(1);
}
const client = getClient(clientId);
if (!client) {
  console.error(`Fehler: Klient "${clientId}" existiert nicht.`);
  process.exit(1);
}

const read = (rel) => {
  const p = path.join(repo, rel);
  return existsSync(p) ? readFileSync(p, 'utf-8') : null;
};

// ── Fact base + templates ────────────────────────────────────────────────────
function importText(rel, column, label) {
  const text = read(rel);
  if (text == null) { log(`${label}: ${rel} nicht gefunden, übersprungen.`); return; }
  if (client[column] && client[column].trim() && !force) {
    log(`${label}: bereits vorhanden, übersprungen (--force zum Überschreiben).`);
    return;
  }
  updateClient(clientId, { [column]: text });
  log(`${label} übernommen ✓ (${rel})`);
}

importText('profil.md', 'factbase_md', 'Faktenbasis');
importText('bewerbung/lebenslauf.md', 'cv_template_md', 'Vorlage Lebenslauf');
importText('bewerbung/anschreiben.md', 'cover_template_md', 'Vorlage Anschreiben');

// ── Images ───────────────────────────────────────────────────────────────────
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
for (const name of ['foto', 'unterschrift']) {
  const file = Object.keys(MIME).map(ext => path.join(repo, 'bewerbung', name + ext)).find(existsSync);
  if (!file) { log(`Bild "${name}": nicht gefunden, übersprungen.`); continue; }
  if (getClientAsset(clientId, name) && !force) {
    log(`Bild "${name}": bereits vorhanden, übersprungen (--force zum Überschreiben).`);
    continue;
  }
  setClientAsset(clientId, name, MIME[path.extname(file).toLowerCase()], readFileSync(file));
  log(`Bild "${name}" übernommen ✓`);
}

// ── Application log ──────────────────────────────────────────────────────────
const STATUS = {
  'beworben': 'applied', 'eingang bestätigt': 'applied', 'gespräch': 'interview',
  'zusage': 'offer', 'absage': 'rejected', 'zurückgezogen': 'rejected',
};

// Table rows of log/index.md: | Datum | Firma | Stelle | Dokumente | Status | Notiz |
function parseIndex(md) {
  const rows = [];
  // The file documents its format with an example row inside an HTML comment.
  for (const line of md.replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    if (!/^\|\s*\d{4}-\d{2}-\d{2}\s*\|/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    const [date, company, title, docs = '', status = '', note = ''] = cells;
    const links = [...docs.matchAll(/\(([^)]+\.md)\)/g)].map(m => m[1]);
    rows.push({ date, company, title, links, status, note });
  }
  return rows;
}

const index = read('log/index.md');
if (!index) {
  log('log/index.md nicht gefunden, keine Bewerbungen importiert.');
} else {
  let imported = 0;
  for (const row of parseIndex(index)) {
    const base = row.links[0] ? path.basename(row.links[0]).replace(/_(Lebenslauf|Anschreiben)\.md$/, '') : `${row.date}_${row.company}`;
    const jobId = `import:${base}`;
    if (getJobById(clientId, jobId)) { log(`Bewerbung "${row.company}" bereits importiert, übersprungen.`); continue; }

    const at = new Date(`${row.date}T12:00:00`).toISOString();
    createManualJob(clientId, {
      id: jobId, title: row.title, company: row.company, scraped_at: at,
      description: row.note ? `Notiz aus dem Bewerbungs-Log: ${row.note}` : '',
    });
    setApplicationStatus(clientId, jobId, STATUS[row.status.toLowerCase()] || 'applied', at);

    for (const link of row.links) {
      const markdown = read(path.join('log', link));
      if (!markdown) { log(`  ${link} fehlt, übersprungen.`); continue; }
      const kind = /_Anschreiben\.md$/.test(link) ? 'cover' : 'cv';
      // Snapshots that only differ from the template by frontmatter still count.
      if (!splitFrontmatter(markdown).body.trim()) continue;
      createDocument(clientId, { job_id: jobId, kind, markdown, created_at: at, humanized: true });
    }
    imported++;
    log(`Bewerbung übernommen ✓ ${row.date} · ${row.company} · ${row.title}`);
  }
  log(`${imported} Bewerbung(en) aus dem Log übernommen.`);
}

log('Fertig. Prüfe Faktenbasis und Vorlagen im Profil-Tab (Bewerbungsunterlagen).');
