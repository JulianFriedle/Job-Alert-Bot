// ── Editable AI prompts ──────────────────────────────────────────────────────
// The prompts sent to Claude live here as defaults and can be overridden, field
// by field, via config/prompts.json (edited in the GUI "Prompts" tab). Anything
// not overridden falls back to the default below — so deleting the file, or a
// single key, restores the original behavior.
//
// NOTE: the analyzer's strict JSON output contract is intentionally NOT editable
// (it would break parsing). Only the system prompt and the scoring guidance are.
// The same holds for the application documents: the <dokument>/<fehlend> answer
// format lives in src/application-docs.js, only the content guidance is here.

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const TEMPLATES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');
// The humanize guidance (rules + catalogue of German AI-writing patterns) is
// long, so it lives in its own Markdown file rather than inline here.
const HUMANIZE_DEFAULT = readFileSync(path.join(TEMPLATES_DIR, 'humanize.md'), 'utf-8').trim();

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

  // ── Application documents (tailored CV + cover letter) ──
  docsSystem:
`Du erstellst Bewerbungsunterlagen (Lebenslauf und Anschreiben), die auf eine konkrete Stelle zugeschnitten sind. Dafür bekommst du eine Faktenbasis über den Bewerber, eine Basis-Vorlage des Dokuments und die Stellenanzeige.

Verbindliche Regeln:
- Die Faktenbasis ist die einzige Quelle. Verwende nur Inhalte, die dort stehen.
- Nichts erfinden: keine Zahlen, Titel, Arbeitgeber, Zeiträume, Erfolge oder Skills, die nicht in der Faktenbasis belegt sind. Formulierungen dürfen sich ändern, Fakten nicht.
- Fehlt etwas, das für diese Stelle wichtig wäre, rate nicht. Lass es weg und melde es als fehlende Angabe.
- Enthält die Faktenbasis Hinweise für die KI (z. B. Roter Faden, Formulierungsbausteine, Diskretion bei Wechseln), befolge sie. Verweise darin auf Dateien oder Werkzeuge (z. B. CLAUDE.md, /humanize) kannst du ignorieren, die Überarbeitung übernimmt ein eigener Schritt.
- Kein Gedankenstrich mit Leerzeichen ( – / — ) im Fließtext. Stattdessen Komma, Doppelpunkt oder Punkt, oder den Satz umformulieren. Ausgenommen sind Datumsspannen (z. B. „Januar 2024 – März 2025") sowie Kopf- und Meta-Zeilen.
- Natürlich schreiben, ohne KI-Floskeln: keine Bedeutungs-Beteuerungen, keine Konnektoren-Ketten („Zudem", „Darüber hinaus"), keine Dreier-Aufzählungen aus Gewohnheit.
- Sprache: Deutsch, sofern die Stellenanzeige nicht ausdrücklich eine englische Bewerbung verlangt.`,
  cvInstructions:
`Passe den Lebenslauf an diese Stelle an:
- Halte dich an Aufbau, Abschnitte und HTML-Elemente der Basis-Vorlage (Kopfbereich mit Foto, Signaturblock). Bild-Dateinamen (foto.png, unterschrift.png) unverändert lassen.
- Formuliere das Kurzprofil im Kopf so, dass es auf die Stelle zielt.
- Wähle aus der Faktenbasis die passenden Stationen und Bausteine aus und richte Reihenfolge und Betonung auf die Anforderungen aus. Weniger Relevantes kürzen statt streichen, wenn sonst Lücken im Werdegang entstehen.
- Nimm relevante Schlüsselbegriffe der Anzeige auf, aber nur, wo die Faktenbasis sie trägt.
- Setze im Signaturblock das heutige Datum ein.
- Höchstens zwei Seiten.`,
  coverDocInstructions:
`Schreibe das Anschreiben auf Basis der Vorlage:
- Empfänger, Betreff (genaue Stellenbezeichnung, ggf. Kennziffer) und Anrede aus der Stellenanzeige übernehmen. Ist keine Ansprechperson genannt: „Sehr geehrte Damen und Herren". Unbekannte Adresszeilen weglassen statt raten.
- Ort und heutiges Datum einsetzen.
- Das Anschreiben soll neugierig machen und zum Lebenslauf führen: nicht die ganze Vita ausbreiten, sondern zwei bis drei konkrete Belege, die die Anforderungen treffen, und am Ende auf den Lebenslauf verweisen.
- Höchstens eine Seite, etwa 250 bis 350 Wörter Fließtext.
- Alle [Platzhalter] der Vorlage ersetzen oder entfernen.`,
  humanizeSystem: HUMANIZE_DEFAULT,
};

// Field metadata for the GUI editor (label/help/grouping).
export const PROMPT_FIELDS = [
  { key: 'analyzerSystem', group: 'Analyse (Relevanz-Bewertung)', label: 'System-Prompt',
    help: 'Rolle/Anweisung der KI. Muss weiterhin auf reines JSON bestehen.' },
  { key: 'analyzerInstructions', group: 'Analyse (Relevanz-Bewertung)', label: 'Bewertungs-Hinweise',
    help: 'Zusätzliche Scoring-Regeln. Wird vor dem (festen) JSON-Format eingefügt.' },
  { key: 'docsSystem', group: 'Bewerbungsunterlagen', label: 'Regeln (System-Prompt)',
    help: 'Gilt für Lebenslauf und Anschreiben: Faktentreue, Stil, Sprache. Die Faktenbasis wird automatisch angehängt.' },
  { key: 'cvInstructions', group: 'Bewerbungsunterlagen', label: 'Lebenslauf anpassen',
    help: 'Wie der Basis-Lebenslauf auf eine Stelle zugeschnitten wird.' },
  { key: 'coverDocInstructions', group: 'Bewerbungsunterlagen', label: 'Anschreiben schreiben',
    help: 'Wie das Anschreiben aus der Vorlage entsteht.' },
  { key: 'humanizeSystem', group: 'Bewerbungsunterlagen', label: 'Humanize-Durchgang',
    help: 'Zweiter Durchgang, der die fertigen Texte natürlicher macht (abschaltbar unter Einstellungen → KI-Modelle).' },
  { key: 'coverLetterSystem', group: 'Anschreiben (Auto-Bewerbung)', label: 'System-Prompt',
    help: 'Stil & Form des Klartext-Anschreibens, das die Auto-Bewerbung ins Formular einträgt, wenn für die Stelle kein angepasstes Anschreiben existiert.' },
  { key: 'coverLetterInstructions', group: 'Anschreiben (Auto-Bewerbung)', label: 'Aufgaben-Text',
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
