import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getJobById } from './database.js';
import { loadPrompts } from './prompts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_PATH = path.join(__dirname, '..', 'config', 'profile.json');
// Read at call time so changes from the GUI settings tab apply without a restart.
const model = () => process.env.COVER_LETTER_MODEL || 'claude-sonnet-4-6';

function buildUserPrompt(profile, job, instructions, notes) {
  const notesBlock = notes
    ? `\n\nBesondere Hinweise des Bewerbers für dieses Anschreiben (unbedingt berücksichtigen):
${notes}`
    : '';
  return `Kandidatenprofil:
${JSON.stringify(profile, null, 2)}

Stellenanzeige:
Titel: ${job.title || 'k.A.'}
Unternehmen: ${job.company || 'k.A.'}
Standort: ${job.location || 'k.A.'}
Beschreibung:
${(job.description || 'k.A.').slice(0, 4000)}${notesBlock}

Aufgabe:
${instructions}`;
}

// Generate a tailored German cover letter for a job row. Returns the letter text.
// `notes` is optional free-text guidance from the user for this specific letter.
export async function generateCoverLetter(job, notes = '') {
  const profile = JSON.parse(await readFile(PROFILE_PATH, 'utf-8'));
  const prompts = loadPrompts();   // read fresh so GUI edits apply without restart
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: model(),
    max_tokens: 1500,
    system: prompts.coverLetterSystem,
    messages: [{ role: 'user', content: buildUserPrompt(profile, job, prompts.coverLetterInstructions, notes) }],
  });

  return response.content[0]?.text ?? '';
}

// ── CLI: npm run cover-letter -- <job_id> ────────────────────────────────────
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [,, jobId] = process.argv;

  if (!jobId) {
    console.error('Fehler: Job-ID fehlt.\n  Verwendung: npm run cover-letter -- <job_id>');
    process.exit(1);
  }

  const job = getJobById(jobId);
  if (!job) {
    console.error(`Fehler: kein Job mit ID "${jobId}" gefunden.`);
    process.exit(1);
  }

  console.error(`Generiere Anschreiben für: ${job.title} @ ${job.company || job.source} ...\n`);
  const text = await generateCoverLetter(job);
  console.log(text);
}
