// Tailored application documents: Markdown helpers, prompt building/parsing and
// the DB layer. Offline — no API calls, no browser, throwaway DB.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.JOBS_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'jobbot-docs-')), 'test.db');

import test from 'node:test';
import assert from 'node:assert/strict';

const md = await import('../src/markdown-doc.js');
const docs = await import('../src/application-docs.js');
const db = await import('../src/database.js');
const { DEFAULT_PROMPTS } = await import('../src/prompts.js');

// ── Markdown helpers ─────────────────────────────────────────────────────────

test('setFrontmatter replaces keys, keeps comments, adds missing ones', () => {
  const src = '---\ntitel: Lebenslauf\nfirma: null      # Zielfirma\n---\n\n# Body\n';
  const out = md.setFrontmatter(src, { firma: 'ACME "Labs"', stelle: 'Ingenieur' });
  const { frontmatter, body } = md.splitFrontmatter(out);
  assert.match(frontmatter, /^titel: Lebenslauf$/m);
  assert.match(frontmatter, /^firma: "ACME \\"Labs\\""$/m);
  assert.match(frontmatter, /^stelle: "Ingenieur"$/m);
  assert.equal(body.trim(), '# Body');
  assert.match(md.setFrontmatter('# Ohne', { firma: null }), /^---\nfirma: null\n---\n/);
});

test('renderDocumentHtml embeds stored images and drops missing ones', () => {
  const src = '---\na: 1\n---\n<img class="foto" src="foto.png" alt="x">\n\n<img class="unterschrift" src="unterschrift.png">\n\n# Name';
  const html = md.renderDocumentHtml(src, {
    css: '.x{}', assets: { foto: { mime: 'image/png', data: Buffer.from('PNG') } },
  });
  assert.match(html, /<img class="foto" src="data:image\/png;base64,UE5H" alt="x">/);
  assert.doesNotMatch(html, /unterschrift/, 'image without asset is removed, not broken');
  assert.doesNotMatch(html, /a: 1/, 'frontmatter is not rendered');
  assert.match(html, /<h1[^>]*>Name<\/h1>/);
  assert.doesNotMatch(html, /@media screen/);
  assert.match(md.renderDocumentHtml('x', { screen: true }), /@media screen/);
});

test('lintDocument flags prose dashes and placeholders, not structure', () => {
  const src = [
    '---', 'firma: x', '---',
    '# Name – Titel',                                  // heading: structure
    'Firma · Ort · Januar 2024 – März 2025',            // meta line: structure
    '- Plane Versuche – und werte sie aus.',            // prose dash → flagged
    '- Repair Café – Konstruktion von Ersatzteilen',    // short list label → ok
    '- **Bachelorarbeit – HPE** (2023): Analyse.',      // bold label → ok
    'Seit 2019 – heute aktiv.',                         // date range → ok
    'Ich freue mich [Datum] auf [Ihre Antwort](https://x.de).', // placeholder + link
    '<!-- Kommentar – mit [Platzhalter] -->',
    '<!-- mehrzeilig',
    'noch – im Kommentar [x]',
    '-->',
  ].join('\n');
  const f = md.lintDocument(src);
  assert.deepEqual(f.map(x => x.rule), ['dash', 'placeholder']);
  assert.equal(f[0].line, 6, 'line numbers count the frontmatter');
  assert.equal(f[1].text, '[Datum]');
  assert.deepEqual(md.lintDocument('---\na: 1\n---\n  \n'), [{ rule: 'empty', line: 0, text: '' }]);
});

test('documentFileName follows YYYY-MM-DD_firmenslug_Typ', () => {
  assert.equal(
    md.documentFileName({ date: '2026-08-13T12:00:00Z', company: 'Müller & Söhne GmbH', kind: 'cv' }),
    '2026-08-13_mueller-soehne-gmbh_Lebenslauf.pdf');
  assert.equal(md.documentFileName({ date: '2026-08-13', company: '', kind: 'cover', ext: 'md' }),
    '2026-08-13_firma_Anschreiben.md');
  assert.equal(md.slugify('BECKER + PARTNER (B2B-Großhandel)'), 'becker-partner-b2b-grosshandel');
});

test('toPlainText strips markup for form fields', () => {
  const src = '---\na: 1\n---\n# Max\nStraße 1\n\n> Ort, 1. Januar\n\n## Bewerbung als **X**\n\nText mit [Link](https://x.de) und *Betonung*.\\\nZeile\n\n<img src="unterschrift.png">\n\n<!-- weg -->\nMax';
  const out = md.toPlainText(src);
  assert.equal(out, 'Max\nStraße 1\n\nOrt, 1. Januar\n\nBewerbung als X\n\nText mit Link und Betonung.\nZeile\n\nMax');
});

// ── Prompt building / answer parsing ─────────────────────────────────────────

test('buildSystem puts the fact base behind a cache breakpoint', () => {
  const sys = docs.buildSystem(DEFAULT_PROMPTS, 'FAKTEN');
  assert.equal(sys.length, 2);
  assert.equal(sys[0].text, DEFAULT_PROMPTS.docsSystem);
  assert.match(sys[1].text, /FAKTEN$/);
  assert.deepEqual(sys[1].cache_control, { type: 'ephemeral' });
});

test('buildDocumentPrompt carries job, template, notes and the CV for the letter', () => {
  const job = { title: 'Ingenieur', company: 'ACME', location: 'Berlin', url: 'https://x', description: 'Lange Beschreibung' };
  const cv = docs.buildDocumentPrompt({ kind: 'cv', prompts: DEFAULT_PROMPTS, template: 'TPL', job, notes: 'NOTIZ', today: new Date('2026-11-13') });
  assert.match(cv, /Heutiges Datum: 13\. November 2026/);
  assert.match(cv, /Lange Beschreibung/);
  assert.match(cv, /TPL/);
  assert.match(cv, /NOTIZ/);
  assert.ok(cv.includes(DEFAULT_PROMPTS.cvInstructions));
  assert.match(cv, /<dokument>[\s\S]*<fehlend>/);

  const cover = docs.buildDocumentPrompt({ kind: 'cover', prompts: DEFAULT_PROMPTS, template: 'TPL', job, cvMarkdown: 'MEIN CV' });
  assert.ok(cover.includes(DEFAULT_PROMPTS.coverDocInstructions));
  assert.match(cover, /MEIN CV/);
  assert.doesNotMatch(cover, /Hinweise des Bewerbers/, 'no notes block without notes');
});

test('parseDocumentAnswer extracts the document and missing facts', () => {
  const a = docs.parseDocumentAnswer('Vorrede\n<dokument>\n```markdown\n# CV\n```\n</dokument>\n<fehlend>\n- Gehaltswunsch\n* Führerschein\n</fehlend>');
  assert.equal(a.markdown, '# CV\n');
  assert.deepEqual(a.missing, ['Gehaltswunsch', 'Führerschein']);
  assert.deepEqual(docs.parseDocumentAnswer('<dokument>X</dokument><fehlend>(keine)</fehlend>').missing, []);
  assert.deepEqual(docs.parseDocumentAnswer('<dokument>X</dokument>').missing, []);
  assert.throws(() => docs.parseDocumentAnswer('nur Text'), /kein Dokument/);
});

test('default templates have no placeholders the CV prompt would leave behind', () => {
  // The example CV only keeps the [Datum] placeholder the AI fills in.
  const f = md.lintDocument(docs.defaultTemplate('cv'));
  assert.deepEqual(f.map(x => x.text), ['[Datum]']);
  assert.match(docs.documentCss('cv'), /@page/);
  assert.match(DEFAULT_PROMPTS.humanizeSystem, /Katalog der KI-Muster/);
});

// ── DB layer ─────────────────────────────────────────────────────────────────

test('templates fall back to the example until the client saves its own', () => {
  assert.equal(docs.getTemplate('default', 'cover').isDefault, true);
  db.updateClient('default', { cover_template_md: '# Eigene Vorlage' });
  const own = docs.getTemplate('default', 'cover');
  assert.deepEqual(own, { markdown: '# Eigene Vorlage', isDefault: false });
  db.updateClient('default', { cover_template_md: null });
});

test('manual jobs are relevant, never analyzed, notified or expired', () => {
  const job = db.createManualJob('default', { title: 'Manuell', company: 'X', description: 'Text' });
  assert.match(job.id, /^manual:/);
  assert.equal(job.source, 'Manuell');
  assert.ok(db.getRelevantJobs('default').some(j => j.id === job.id));
  assert.ok(!db.getUnanalyzedJobs('default').some(j => j.id === job.id));
  assert.ok(!db.getRelevantUnnotifiedJobs('default').some(j => j.id === job.id));
  assert.ok(!db.getJobsToExpire('default', 0).some(j => j.id === job.id));
});

test('documents: versions newest first, scoped by client', () => {
  const other = db.createClient({ name: 'Andere' });
  db.createManualJob('default', { id: 'manual:doc', title: 'T' });
  const v1 = db.createDocument('default', { job_id: 'manual:doc', kind: 'cv', markdown: 'v1', created_at: '2026-01-01T00:00:00Z' });
  const v2 = db.createDocument('default', { job_id: 'manual:doc', kind: 'cv', markdown: 'v2', missing: ['A'] });
  db.createDocument('default', { job_id: 'manual:doc', kind: 'cover', markdown: 'c1' });

  assert.deepEqual(db.getDocumentsForJob('default', 'manual:doc').map(d => d.markdown), ['c1', 'v2', 'v1']);
  assert.equal(db.getLatestDocument('default', 'manual:doc', 'cv').id, v2.id);
  assert.deepEqual(JSON.parse(v2.missing_json), ['A']);
  assert.deepEqual(db.getDocumentKindsByJob('default')['manual:doc'].sort(), ['cover', 'cv']);

  // Another client can neither see nor touch them.
  assert.equal(db.getDocument(other.id, v1.id), undefined);
  assert.equal(db.getDocumentsForJob(other.id, 'manual:doc').length, 0);
  assert.equal(db.deleteDocument(other.id, v1.id), false);

  const edited = db.updateDocument('default', v1.id, { markdown: 'v1b', edited: true });
  assert.equal(edited.markdown, 'v1b');
  assert.equal(edited.edited, 1);
  assert.equal(db.updateDocument(other.id, v1.id, { markdown: 'hack' }), undefined);
  assert.equal(db.getDocument('default', v1.id).markdown, 'v1b');
  assert.equal(db.deleteDocument('default', v1.id), true);
  db.deleteClient(other.id);
});

test('client assets: upsert, list, delete, and removed with the client', () => {
  const c = db.createClient({ name: 'Bilder' });
  db.setClientAsset(c.id, 'foto', 'image/png', Buffer.from('a'));
  db.setClientAsset(c.id, 'foto', 'image/jpeg', Buffer.from('bb'));
  assert.deepEqual(db.listClientAssets(c.id).map(a => [a.name, a.mime, a.size]), [['foto', 'image/jpeg', 2]]);
  assert.equal(db.getClientAssets(c.id).foto.data.toString(), 'bb');
  assert.deepEqual(db.getClientAssets('default'), {});
  db.createDocument(c.id, { job_id: 'j', kind: 'cv', markdown: 'x' });
  db.deleteClient(c.id);
  assert.equal(db.getClientAsset(c.id, 'foto'), undefined);
  assert.equal(db.getDocumentsForJob(c.id, 'j').length, 0);
});

test('setApplicationStatus can backdate (log import)', () => {
  db.createManualJob('default', { id: 'manual:old', title: 'Alt' });
  db.setApplicationStatus('default', 'manual:old', 'interview', '2026-08-13T12:00:00.000Z');
  const j = db.getJobById('default', 'manual:old');
  assert.equal(j.status, 'interview');
  assert.equal(j.applied_at, '2026-08-13T12:00:00.000Z');
});

test('startGeneration refuses without a fact base (before any API call)', () => {
  db.createManualJob('default', { id: 'manual:gen', title: 'Gen' });
  assert.throws(() => docs.startGeneration('default', 'manual:gen'), /Faktenbasis/);
  assert.throws(() => docs.startGeneration('default', 'manual:nope'), /nicht gefunden/);
  assert.equal(docs.getGenerationStatus('default', 'manual:gen'), null);
});
