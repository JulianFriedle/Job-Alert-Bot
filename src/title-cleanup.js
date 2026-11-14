// ── Job titles with surrounding card text ────────────────────────────────────
// Career pages often put the date, a "Neu" badge, the location or portal
// metadata into the same link as the title, and the scraper reads it all as
// one string: "30. September 2026Betreuer Lieferantenqualität",
// "…CoordinatorLocationUnited States | Etowah, TNPosted on09.11.2026",
// "…Einsatzorte: Karlsruhe Unternehmen: … Arbeitszeiten: Vollzeit".
// That breaks the title filters and clutters the GUI and the Excel export.
//
// cleanJobTitle strips only patterns that cannot be part of a real title and
// hands back what it found (location, date) so it can fill the job's own
// fields. When in doubt it keeps the text: a cleaned title that would end up
// shorter than two words is discarded in favour of the original.
// Pure function, unit-tested in test/title-cleanup.test.js.

const MONTHS = 'januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember|' +
  'jan|feb|mär|mrz|apr|jun|jul|aug|sep|sept|okt|nov|dez|' +
  'january|february|march|may|june|july|october|december|mar|oct|dec';

// A date at the very start, glued to the title or separated by punctuation.
const LEADING_DATE = new RegExp(
  '^(' +
    `\\d{1,2}\\.\\s?(?:${MONTHS})\\.?\\s?\\d{4}` +          // 30. September 2026
    '|\\d{1,2}\\.\\d{1,2}\\.\\d{2,4}' +                     // 30.09.2026
    '|\\d{4}-\\d{2}-\\d{2}' +                               // 2026-09-30
    `|(?:${MONTHS})\\.?\\s\\d{1,2},?\\s\\d{4}` +            // September 30, 2026
  ')\\s*[-–|·:,]?\\s*', 'i');

// A "Neu"/"New" badge: glued to the next word ("NeuTeamassistenz") or set off
// by punctuation/brackets ("Neu: …", "[Neu] …"). The glued form is matched
// case-sensitively — with /i the capital lookahead would also eat "Neubau…".
// Glued means the next word starts right after it, capital then lowercase:
// "NeuTeamassistenz", "NEUTeamassistenz" — but not "NEWSLETTER", "NEUBAU",
// "NEUE STELLE" (all-caps words), and a date may follow ("NEU30.09.2026").
const GLUED_BADGE = /^(?:Neu|NEU|New|NEW)(?=[A-ZÄÖÜ][a-zäöüß])|^(?:Neu|NEU)(?=\d)/;
// A badge in its own element reads "NEU Teamassistenz …". Only the all-caps
// form: "Neu Isenburg", "New Business Manager", "NEW YORK …" are real text.
const SPACED_BADGE = /^(?:NEU|NEW)\s+(?=[A-ZÄÖÜ][a-zäöüß])/;
// "Posted on 12.12.2026 Software Engineer"
const LEADING_POSTED = /^posted on\s*\S+\s*/i;
const MARKED_BADGE = /^(?:\[(?:neu|new)\]\s*|(?:neu|new)\s*[:!–-]\s+)/i;

// "…CoordinatorLocationUnited States of America | Etowah, TNPosted on09.11.2026"
const LOCATION_POSTED = /(?<=[\p{Ll})])\s*Location\s*(.+?)\s*Posted on\s*(\S*)\s*$/u;
const POSTED_ON = /(?<=[\p{L})])\s*Posted on\s*(\S+)\s*$/u;

// Labelled metadata after the title ("Einsatzorte: Karlsruhe Unternehmen: …").
const LABELS = 'Einsatzorte?|Einsatzorte\\(e\\)|Standorte?|Arbeitsorte?|Dienstorte?|Unternehmen|Arbeitszeiten?|' +
  'Befristung|Eintrittsdatum|Startdatum|Beginn|Veröffentlicht(?: am)?|Bewerbungsfrist|Vertragsart|' +
  'Anstellungsart|Beschäftigungsart|Job-ID|Referenznummer|Kennziffer|Stellen-ID';
const LABEL_RE = new RegExp(`\\s*(?<![\\p{L}-])(${LABELS})\\s*:\\s*`, 'giu');
const LOCATION_LABEL = /^(einsatzort|standort|arbeitsort|dienstort)/i;

// A dd.mm.yyyy date in the middle starts portal metadata ("… 13.11.2026
// Sonstige Überlingen") — unless the title itself talks about a date.
const INLINE_DATE = /\s+(\d{1,2}\.\d{1,2}\.\d{4})\b(.*)$/;
const DATE_IS_PART_OF_TITLE = /\b(ab|bis|zum|vom|von|seit|from|until|starting|start|befristet|frühestens|spätestens|beginn|eintritt|frist|bewerbungsfrist|stichtag)\s*$/i;

const words = (s) => s.split(/\s+/).filter(Boolean).length;
const tidy = (s) => s.replace(/\s+/g, ' ').replace(/^[\s\-–|·:,]+|[\s\-–|·:,]+$/g, '').trim();

export function cleanJobTitle(raw) {
  const original = tidy(String(raw ?? ''));
  let title = original;
  let location = '';
  let postedDate = '';

  // Leading date and badge, in either order ("Neu 30.09.2026 …").
  for (let i = 0; i < 2; i++) {
    const d = title.match(LEADING_DATE);
    if (d && words(title.slice(d[0].length)) >= 2) { postedDate ||= d[1]; title = title.slice(d[0].length); }
    const b = title.match(GLUED_BADGE) || title.match(SPACED_BADGE) || title.match(MARKED_BADGE);
    if (b && words(title.slice(b[0].length)) >= 2) title = title.slice(b[0].length);
    const p = title.match(LEADING_POSTED);
    if (p && words(title.slice(p[0].length)) >= 2) { postedDate ||= p[0].replace(/^posted on\s*/i, '').trim(); title = title.slice(p[0].length); }
  }

  const lp = title.match(LOCATION_POSTED);
  if (lp) {
    location ||= tidy(lp[1]);
    postedDate ||= lp[2] || '';
    title = title.slice(0, lp.index);
  } else {
    const po = title.match(POSTED_ON);
    if (po) { postedDate ||= po[1]; title = title.slice(0, po.index); }
  }

  // Labelled metadata: cut at the first label, pick the location out of it.
  const labels = [...title.matchAll(LABEL_RE)].filter(m => m.index > 0);
  if (labels.length > 0) {
    labels.forEach((m, i) => {
      const end = i + 1 < labels.length ? labels[i + 1].index : title.length;
      const value = tidy(title.slice(m.index + m[0].length, end));
      if (!location && LOCATION_LABEL.test(m[1]) && value) location = value;
    });
    title = title.slice(0, labels[0].index);
  }

  const inline = title.match(INLINE_DATE);
  // Metadata follows such a date; a lone "(m/w/d)" or nothing after it means
  // the date belongs to the title ("Ausbildung … 01.09.2027 (m/w/d)").
  const tailIsMeta = inline && !/^\s*(\([^)]*\))?\s*$/.test(inline[2]);
  if (inline && tailIsMeta && !DATE_IS_PART_OF_TITLE.test(title.slice(0, inline.index))) {
    postedDate ||= inline[1];
    title = title.slice(0, inline.index);
  }

  title = tidy(title);
  // Never trade a real title for a fragment (what was found still counts).
  if (words(title) < 2 && words(original) >= 2) return { title: original, location, postedDate };
  return { title, location, postedDate };
}
