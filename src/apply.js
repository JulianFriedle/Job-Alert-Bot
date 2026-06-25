import { setApplicationStatus, getJobById, getAppliedJobs, markIrrelevant, DEFAULT_CLIENT_ID } from './database.js';

// This CLI manages the single-user default client.
const CID = DEFAULT_CLIENT_ID;

const VALID_STATUSES = ['applied', 'interview', 'offer', 'rejected'];
const STATUS_LABELS  = { applied: 'Beworben', interview: 'Interview', offer: 'Angebot', rejected: 'Abgelehnt' };

const HELP = `
Usage:
  npm run apply -- <job_id> <status>   Bewerbungsstatus setzen
  npm run apply -- ignore <job_id>     Job als nicht relevant markieren
  npm run apply -- list                Alle Bewerbungen anzeigen
  npm run apply -- help                Diese Hilfe anzeigen

Statuses:
  applied    — Bewerbung abgeschickt
  interview  — Einladung zum Gespräch
  offer      — Angebot erhalten
  rejected   — Absage

Beispiele:
  npm run apply -- abc123def456 applied
  npm run apply -- abc123def456 interview
  npm run apply -- ignore abc123def456
`;

const [,, cmd, statusArg] = process.argv;

if (!cmd || cmd === 'help') {
  console.log(HELP);
  process.exit(0);
}

if (cmd === 'ignore') {
  const id = statusArg;
  if (!id) {
    console.error(`Fehler: Job-ID fehlt.\n  Verwendung: npm run apply -- ignore <job_id>`);
    process.exit(1);
  }
  const job = getJobById(CID, id);
  if (!job) {
    console.error(`Fehler: kein Job mit ID "${id}" gefunden.`);
    process.exit(1);
  }
  markIrrelevant(CID, id);
  console.log(`✓  Als nicht relevant markiert: ${job.title} @ ${job.company || job.source}`);
  process.exit(0);
}

if (cmd === 'list') {
  const jobs = getAppliedJobs(CID);
  if (jobs.length === 0) {
    console.log('Noch keine Bewerbungen getrackt.');
  } else {
    const C = { id: 18, status: 12, date: 12, score: 6 };
    console.log(`\n${'ID'.padEnd(C.id)} ${'Status'.padEnd(C.status)} ${'Datum'.padEnd(C.date)} ${'Score'.padEnd(C.score)} Firma – Stelle`);
    console.log('─'.repeat(100));
    for (const j of jobs) {
      const date   = j.applied_at ? new Date(j.applied_at).toLocaleDateString('de-DE') : '–';
      const status = STATUS_LABELS[j.status] || j.status || '–';
      const score  = String(j.score ?? '–');
      console.log(
        `${j.id.padEnd(C.id)} ${status.padEnd(C.status)} ${date.padEnd(C.date)} ${score.padEnd(C.score)} ${j.company || ''} – ${j.title || ''}`
      );
    }
    console.log('');
  }
  process.exit(0);
}

// cmd is a job ID
const id = cmd;

if (!statusArg) {
  console.error(`Fehler: Status fehlt.\n${HELP}`);
  process.exit(1);
}

if (!VALID_STATUSES.includes(statusArg)) {
  console.error(`Fehler: ungültiger Status "${statusArg}". Erlaubt: ${VALID_STATUSES.join(', ')}`);
  process.exit(1);
}

const job = getJobById(CID, id);
if (!job) {
  console.error(`Fehler: kein Job mit ID "${id}" gefunden.`);
  process.exit(1);
}

setApplicationStatus(CID, id, statusArg);
console.log(`✓  ${STATUS_LABELS[statusArg]}: ${job.title} @ ${job.company || job.source}`);
