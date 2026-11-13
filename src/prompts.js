// ── Editable AI prompts ──────────────────────────────────────────────────────
// The prompts sent to Claude live here as defaults and can be overridden, field
// by field, via config/prompts.json (edited in the GUI "Prompts" tab). Anything
// not overridden falls back to the default below — so deleting the file, or a
// single key, restores the original behavior.
//
// NOTE: the analyzer's strict JSON output contract is intentionally NOT editable
// (it would break parsing). Only the system prompt and the scoring guidance are.

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

// Merge an overrides object (e.g. a client's prompts_json) onto the defaults.
// Anything missing/blank falls back to the default for that field.
export function mergePrompts(overrides) {
  const out = { ...DEFAULT_PROMPTS };
  if (overrides && typeof overrides === 'object') {
    for (const k of Object.keys(DEFAULT_PROMPTS)) {
      if (typeof overrides[k] === 'string' && overrides[k].trim() !== '') out[k] = overrides[k];
    }
  }
  return out;
}

// Keep only the fields that differ from the defaults, so persisted overrides stay
// minimal and future default changes still flow through for untouched fields.
export function minimizePromptOverrides(incoming) {
  const overrides = {};
  if (incoming && typeof incoming === 'object') {
    for (const key of Object.keys(DEFAULT_PROMPTS)) {
      const v = incoming[key];
      if (typeof v === 'string' && v.trim() !== '' && v !== DEFAULT_PROMPTS[key]) overrides[key] = v;
    }
  }
  return overrides;
}

// ── Output language ──────────────────────────────────────────────────────────
// A client may pick the language of AI-written text (profile
// preferences.outputLanguage, asked in the setup wizard). Unset means "as
// before": no directive is added, so existing prompts behave exactly as they did.
const LANGUAGE_NAMES = { de: { en: 'German', de: 'Deutsch' }, en: { en: 'English', de: 'Englisch' } };

export function outputLanguage(profile) {
  const v = profile?.preferences?.outputLanguage;
  return Object.hasOwn(LANGUAGE_NAMES, v) ? v : null;
}

// Appended to the analyzer's job block (English, like the rest of that prompt).
export function analyzerLanguageLine(profile) {
  const l = outputLanguage(profile);
  return l ? `Write "reasons", "concerns" and "summary" in ${LANGUAGE_NAMES[l].en}.` : '';
}

// Appended to the cover-letter task. It sits last in the user turn and says it
// wins, because the (editable) system prompt may still name another language.
export function coverLetterLanguageLine(profile) {
  const l = outputLanguage(profile);
  if (!l) return '';
  return l === 'en'
    ? 'Sprache: Verfasse das Anschreiben vollständig auf Englisch, als englischsprachigen Geschäftsbrief. ' +
      'Diese Vorgabe hat Vorrang vor allen anderen Sprachangaben.'
    : 'Sprache: Verfasse das Anschreiben vollständig auf Deutsch. Diese Vorgabe hat Vorrang vor allen anderen Sprachangaben.';
}
