import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getJobById } from './database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_PATH = path.join(__dirname, '..', 'config', 'profile.json');
// Read at call time so changes from the GUI settings tab apply without a restart.
const model = () => process.env.COVER_LETTER_MODEL || 'claude-sonnet-4-6';

const SYSTEM_PROMPT =
  'Du bist ein erfahrener Karriereberater und hilfst dabei, professionelle deutsche Anschreiben zu verfassen. ' +
  'Schreibe immer vollständige, formelle Anschreiben im DIN-5008-Stil auf Deutsch. Verwende als Trennzeichen kein -.' +
  'Gib nur den reinen Anschreiben-Text aus, ohne Erklärungen oder Kommentare.';

function buildUserPrompt(profile, job) {
  return `Kandidatenprofil:
${JSON.stringify(profile, null, 2)}

Stellenanzeige:
Titel: ${job.title || 'k.A.'}
Unternehmen: ${job.company || 'k.A.'}
Standort: ${job.location || 'k.A.'}
Beschreibung:
${(job.description || 'k.A.').slice(0, 4000)}

Aufgabe:
Schreibe ein vollständiges, überzeugendes Anschreiben für diese Stelle. Beziehe dich konkret auf die Anforderungen der Stellenanzeige und hebe die passenden Stärken und Erfahrungen des Kandidaten hervor. Verwende einen professionellen, aber persönlichen Ton.`;
}

// Generate a tailored German cover letter for a job row. Returns the letter text.
export async function generateCoverLetter(job) {
  const profile = JSON.parse(await readFile(PROFILE_PATH, 'utf-8'));
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: model(),
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(profile, job) }],
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
