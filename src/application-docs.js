// ── Tailored application documents (CV + cover letter) ───────────────────────
// Turns a client's Markdown fact base + base templates + a job posting into a
// CV and/or cover letter tailored to that job, then optionally runs a second
// "humanize" pass over each document. Results are stored as new rows in the
// `documents` table; the GUI renders them to HTML/PDF on demand.
//
// Cost: one Anthropic call per document plus one per humanize pass (so up to
// four for CV + cover letter). Only ever triggered by an explicit user action.

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { getClient, getJobById, createDocument, updateDocument, getLatestDocument } from './database.js';
import { getPrompts } from './client-config.js';
import { setFrontmatter, lintDocument } from './markdown-doc.js';

const TEMPLATES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');

// Same model setting as the cover letter; read at call time so a change in the
// settings tab applies without a restart.
const model = () => process.env.COVER_LETTER_MODEL || 'claude-opus-5';

export function humanizeEnabled() {
  return !['false', '0', 'off', 'no'].includes(String(process.env.DOCS_HUMANIZE ?? 'true').trim().toLowerCase());
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] [docs] ${msg}`);
}

// ── Templates / CSS ──────────────────────────────────────────────────────────

const TEMPLATE_FILES = { cv: 'lebenslauf.example.md', cover: 'anschreiben.example.md' };
const CSS_FILES = { cv: 'lebenslauf.css', cover: 'anschreiben.css' };
const TEMPLATE_COLUMN = { cv: 'cv_template_md', cover: 'cover_template_md' };

export function defaultTemplate(kind) {
  return readFileSync(path.join(TEMPLATES_DIR, TEMPLATE_FILES[kind]), 'utf-8');
}

export function documentCss(kind) {
  return readFileSync(path.join(TEMPLATES_DIR, CSS_FILES[kind]), 'utf-8');
}

// The client's own base template, or the anonymous example when none is saved.
export function getTemplate(clientOrId, kind) {
  const client = typeof clientOrId === 'string' ? getClient(clientOrId) : clientOrId;
  const own = client?.[TEMPLATE_COLUMN[kind]];
  return { markdown: own && own.trim() ? own : defaultTemplate(kind), isDefault: !(own && own.trim()) };
}

export { TEMPLATE_COLUMN };

// ── Prompt building (pure — exported for tests) ──────────────────────────────

const KIND_NAME = { cv: 'Lebenslauf', cover: 'Anschreiben' };

// The answer format is fixed (not an editable prompt): parsing depends on it.
const ANSWER_FORMAT = `Antworte ausschließlich in diesem Format, ohne Text davor oder danach:
<dokument>
(das vollständige Markdown-Dokument, inklusive Frontmatter, HTML-Elementen und Kommentaren der Vorlage)
</dokument>
<fehlend>
(eine Angabe pro Zeile, die für diese Stelle hilfreich wäre, aber in der Faktenbasis fehlt; leer lassen, wenn nichts fehlt)
</fehlend>`;

const HUMANIZE_FORMAT = `Du bekommst ein fertiges Dokument als Markdown mit Frontmatter und HTML-Elementen.
Überarbeite nur den Fließtext (Kurzprofil, Bullet-Points, Absätze). Unverändert bleiben: Frontmatter, HTML-Tags und ihre Attribute, Bild-Dateinamen, Überschriften, Namen, Kontaktdaten, Firmen, Orte, Datumsangaben, Noten und alle anderen Fakten. Füge nichts hinzu, was nicht schon im Text steht.

Antworte ausschließlich in diesem Format, ohne Text davor oder danach:
<dokument>
(das vollständige überarbeitete Dokument)
</dokument>`;

function formatDate(d = new Date()) {
  return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
}

function jobBlock(job) {
  return `Stellenanzeige:
Titel: ${job.title || 'k. A.'}
Unternehmen: ${job.company || 'k. A.'}
Standort: ${job.location || 'k. A.'}
URL: ${job.url || 'k. A.'}
Beschreibung:
${(job.description || '').trim() || 'k. A. (nur Titel und Unternehmen bekannt)'}`;
}

// System blocks: the rules, then the fact base. The fact base is the same for
// every job of this client, so it carries the cache breakpoint — the CV and the
// cover letter call (and the next job) reuse it.
export function buildSystem(prompts, factbase) {
  return [
    { type: 'text', text: prompts.docsSystem },
    { type: 'text', text: `Faktenbasis (einzige Quelle für Fakten über den Bewerber):\n\n${factbase}`, cache_control: { type: 'ephemeral' } },
  ];
}

export function buildDocumentPrompt({ kind, prompts, template, job, notes = '', cvMarkdown = '', today = new Date() }) {
  const parts = [
    `Heutiges Datum: ${formatDate(today)}`,
    jobBlock(job),
  ];
  if (kind === 'cover' && cvMarkdown) {
    parts.push(`Der für diese Stelle angepasste Lebenslauf (das Anschreiben soll dazu passen und darauf verweisen):\n\n${cvMarkdown}`);
  }
  parts.push(`Basis-Vorlage (${KIND_NAME[kind]}):\n\n${template}`);
  if (notes) parts.push(`Hinweise des Bewerbers für diese Bewerbung (unbedingt berücksichtigen):\n${notes}`);
  parts.push(`Aufgabe:\n${kind === 'cv' ? prompts.cvInstructions : prompts.coverDocInstructions}`);
  parts.push(ANSWER_FORMAT);
  return parts.join('\n\n---\n\n');
}

// Pull the document (and the list of missing facts) out of the model's answer.
// Tolerates a missing closing tag (truncation is caught separately) and a model
// that wrapped the document in a ```markdown fence.
export function parseDocumentAnswer(text) {
  const raw = String(text ?? '');
  const doc = raw.match(/<dokument>\s*([\s\S]*?)\s*(?:<\/dokument>|$)/i);
  if (!doc || !doc[1].trim()) throw new Error('Antwort der KI enthält kein Dokument.');
  let markdown = doc[1].trim();
  const fence = markdown.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) markdown = fence[1].trim();

  const miss = raw.match(/<fehlend>\s*([\s\S]*?)\s*<\/fehlend>/i);
  const missing = miss
    ? miss[1].split('\n').map(l => l.replace(/^\s*[-*•]\s*/, '').trim())
      .filter(l => l && !/^\(?(keine|nichts|leer)\b/i.test(l))
    : [];
  return { markdown: markdown + '\n', missing };
}

// ── Claude calls ─────────────────────────────────────────────────────────────

async function callClaude({ system, user }) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: model(),
    // Covers thinking + a two-page CV in Markdown with room to spare.
    max_tokens: 16000,
    system,
    messages: [{ role: 'user', content: user }],
  });
  if (response.stop_reason === 'refusal') throw new Error('Die KI hat die Anfrage abgelehnt.');
  if (response.stop_reason === 'max_tokens') throw new Error('Antwort der KI wurde abgeschnitten (max_tokens).');
  // Never index content[0]: a thinking block can come first.
  return response.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

async function writeDocument({ kind, prompts, factbase, template, job, notes, cvMarkdown }) {
  const text = await callClaude({
    system: buildSystem(prompts, factbase),
    user: buildDocumentPrompt({ kind, prompts, template, job, notes, cvMarkdown }),
  });
  return parseDocumentAnswer(text);
}

export async function humanizeMarkdown(markdown, prompts) {
  const text = await callClaude({
    system: [{ type: 'text', text: `${prompts.humanizeSystem}\n\n---\n\n${HUMANIZE_FORMAT}` }],
    user: markdown,
  });
  return parseDocumentAnswer(text).markdown;
}

// ── Generation jobs (in-memory status, polled by the GUI) ─────────────────────
// A full CV + cover letter run takes a minute or more — longer than a reverse
// proxy will hold a request open. So POST starts it and returns at once; the
// GUI polls the documents endpoint, which reports this status.

const running = new Map(); // `${clientId}\u0000${jobId}` → { kinds, step, startedAt, error }
const key = (clientId, jobId) => `${clientId}\u0000${jobId}`;

export function getGenerationStatus(clientId, jobId) {
  return running.get(key(clientId, jobId)) || null;
}

// Throws synchronously for problems the user can fix (no fact base, unknown
// job); everything after that runs in the background.
export function startGeneration(clientId, jobId, { kinds = ['cv', 'cover'], notes = '' } = {}) {
  const client = getClient(clientId);
  const job = getJobById(clientId, jobId);
  if (!client || !job) throw Object.assign(new Error('Job nicht gefunden'), { status: 404 });
  if (!client.factbase_md || !client.factbase_md.trim())
    throw Object.assign(new Error('Keine Faktenbasis hinterlegt (Profil → Bewerbungsunterlagen).'), { status: 400 });
  if (!process.env.ANTHROPIC_API_KEY)
    throw Object.assign(new Error('ANTHROPIC_API_KEY ist nicht gesetzt.'), { status: 400 });
  const k = key(clientId, jobId);
  const current = running.get(k);
  if (current && !current.error && !current.done)
    throw Object.assign(new Error('Für diesen Job läuft bereits eine Erstellung.'), { status: 409 });

  const wanted = ['cv', 'cover'].filter(x => kinds.includes(x));
  if (!wanted.length) throw Object.assign(new Error('Kein Dokumenttyp gewählt.'), { status: 400 });

  const status = { kinds: wanted, step: 'start', startedAt: new Date().toISOString(), error: null, done: false };
  running.set(k, status);

  (async () => {
    const prompts = getPrompts(clientId);
    const doHumanize = humanizeEnabled();
    let cvMarkdown = '';
    for (const kind of wanted) {
      status.step = `${kind}:write`;
      log(`${KIND_NAME[kind]} für "${job.title}" (${job.company || job.source}) wird erstellt…`);
      // A cover letter written without a fresh CV still lines up with the
      // latest stored one, if any.
      if (kind === 'cover' && !cvMarkdown) cvMarkdown = getLatestDocument(clientId, jobId, 'cv')?.markdown || '';
      const { markdown, missing } = await writeDocument({
        kind, prompts, factbase: client.factbase_md, job, notes,
        template: getTemplate(client, kind).markdown, cvMarkdown,
      });
      let final = setFrontmatter(markdown, { firma: job.company || null, stelle: job.title || null });
      if (doHumanize) {
        status.step = `${kind}:humanize`;
        final = await humanizeMarkdown(final, prompts);
      }
      const doc = createDocument(clientId, { job_id: jobId, kind, markdown: final, missing, notes: notes || null, humanized: doHumanize });
      if (kind === 'cv') cvMarkdown = doc.markdown;
      const issues = lintDocument(final).length;
      log(`${KIND_NAME[kind]} erstellt ✓${issues ? ` (${issues} Stil-Hinweis(e))` : ''}`);
    }
    status.step = 'done';
    status.done = true;
  })().catch(err => {
    status.error = err.message;
    log(`FEHLER bei der Erstellung für "${job.title}": ${err.message}`);
  }).finally(() => {
    // Keep a finished/failed status around briefly so the polling GUI sees it.
    setTimeout(() => { if (running.get(k) === status) running.delete(k); }, 10 * 60 * 1000).unref?.();
  });

  return status;
}

// Re-run only the humanize pass on an existing document (e.g. after editing).
export async function rehumanizeDocument(clientId, doc) {
  const prompts = getPrompts(clientId);
  const markdown = await humanizeMarkdown(doc.markdown, prompts);
  return updateDocument(clientId, doc.id, { markdown, humanized: true });
}
