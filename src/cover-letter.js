import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { fileURLToPath } from 'url';
import { getJobById, DEFAULT_CLIENT_ID } from './database.js';
import { getClientConfig } from './client-config.js';

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
// Profile/prompts are resolved from the job's client (or DEFAULT_CLIENT_ID).
export async function generateCoverLetter(job, notes = '') {
  const { profile, prompts } = getClientConfig(job.client_id || DEFAULT_CLIENT_ID);
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

  const job = getJobById(DEFAULT_CLIENT_ID, jobId);
  if (!job) {
    console.error(`Fehler: kein Job mit ID "${jobId}" gefunden.`);
    process.exit(1);
  }

  console.error(`Generiere Anschreiben für: ${job.title} @ ${job.company || job.source} ...\n`);
  const text = await generateCoverLetter(job);
  console.log(text);
}
