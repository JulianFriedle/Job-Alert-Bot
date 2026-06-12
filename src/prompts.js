// ── Editable AI prompts ──────────────────────────────────────────────────────
// The prompts sent to Claude live here as defaults and can be overridden, field
// by field, via config/prompts.json (edited in the GUI "Prompts" tab). Anything
// not overridden falls back to the default below — so deleting the file, or a
// single key, restores the original behavior.
//
// NOTE: the analyzer's strict JSON output contract is intentionally NOT editable
// (it would break parsing). Only the system prompt and the scoring guidance are.

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROMPTS_PATH = path.join(__dirname, '..', 'config', 'prompts.json');

export const DEFAULT_PROMPTS = {
  // ── Analyzer (relevance scoring) ──
  analyzerSystem:
    'You are a career advisor. Analyze job postings and decide if they match ' +
    "the candidate's profile. Respond ONLY with valid JSON.",
  analyzerInstructions:
    `Scoring priorities
- Initiativbewerbung / spontaneous application listings: score at least 7 if the candidate's profile is a plausible fit, even without a specific role description.
- PhD / Doktorand / Promotion / wissenschaftlicher Mitarbeiter positions: score at least 8 if topic area overlaps with candidate's background (additive manufacturing, lightweight design, materials, simulation, manufacturing IT).`,

  // ── Cover letter ──
  coverLetterSystem:
    'Du bist ein erfahrener Karriereberater und hilfst dabei, professionelle deutsche Anschreiben zu verfassen. ' +
    'Schreibe immer vollständige, formelle Anschreiben im DIN-5008-Stil auf Deutsch. Verwende als Trennzeichen kein -.' +
    'Gib nur den reinen Anschreiben-Text aus, ohne Erklärungen oder Kommentare.',
  coverLetterInstructions:
    'Schreibe ein vollständiges, überzeugendes Anschreiben für diese Stelle. Beziehe dich konkret auf die ' +
    'Anforderungen der Stellenanzeige und hebe die passenden Stärken und Erfahrungen des Kandidaten hervor. ' +
    'Verwende einen professionellen, aber persönlichen Ton.',
};

// Field metadata for the GUI editor (label/help/grouping).
export const PROMPT_FIELDS = [
  { key: 'analyzerSystem', group: 'Analyse (Relevanz-Bewertung)', label: 'System-Prompt',
    help: 'Rolle/Anweisung der KI. Muss weiterhin auf reines JSON bestehen.' },
  { key: 'analyzerInstructions', group: 'Analyse (Relevanz-Bewertung)', label: 'Bewertungs-Hinweise',
    help: 'Zusätzliche Scoring-Regeln. Wird vor dem (festen) JSON-Format eingefügt.' },
  { key: 'coverLetterSystem', group: 'Anschreiben', label: 'System-Prompt',
    help: 'Stil & Form des Anschreibens.' },
  { key: 'coverLetterInstructions', group: 'Anschreiben', label: 'Aufgaben-Text',
    help: 'Konkrete Anweisung, wie das Anschreiben verfasst werden soll.' },
];

// Merge defaults with config/prompts.json. Read fresh each call so GUI edits
// take effect without restarting (volume is low — once per analysis/letter).
export function loadPrompts() {
  try {
    const f = JSON.parse(readFileSync(PROMPTS_PATH, 'utf-8'));
    const out = { ...DEFAULT_PROMPTS };
    for (const k of Object.keys(DEFAULT_PROMPTS)) {
      if (typeof f[k] === 'string' && f[k].trim() !== '') out[k] = f[k];
    }
    return out;
  } catch {
    return { ...DEFAULT_PROMPTS };
  }
}
