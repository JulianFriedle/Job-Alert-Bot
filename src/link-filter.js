// ── Non-job links on career pages ────────────────────────────────────────────
// The generic scraper collects every anchor inside a job-ish container, so it
// also picks up pagination, legal links, "save this job" buttons and marketing
// teasers. Each of those would get a detail-page fetch and a Claude call.
//
// Every pattern matches the WHOLE link text (after normalizing), never a part
// of it: "Datenschutz" is a footer link, "Referent Datenschutz (m/w/d)" is a job.
// Pure function, no DOM — unit-tested in test/link-filter.test.js.

const NON_JOB_PATTERNS = [
  // Pagination (a short parenthetical like "(aktuelle Seite)" may follow)
  /^(gehe zu |zur? )?seite \d+( von \d+)?( \(.{1,25}\))?$/,
  /^(go to )?page \d+( of \d+)?( \(.{1,25}\))?$/,
  /^(nächste|vorherige|letzte|erste) seite$/,
  /^(next|previous|last|first) page$/,

  // Legal / site chrome
  /^(impressum|rechtliche hinweise|datenschutz(erklärung|hinweise|einstellungen)?|cookie-?(einstellungen|richtlinie|hinweise?)|cookie (einstellungen|richtlinie|settings|policy)|cookies|privacy( policy| notice| statement)?|imprint|legal notice|terms of (use|service)|nutzungsbedingungen|agb|barrierefreiheit(serklärung)?|accessibility( statement)?|kontakt|contact( us)?|sitemap)( (und|&|and) (rechtliche hinweise|datenschutz|impressum|privacy( policy)?))?$/,

  // Per-job UI buttons
  /^(stellenanzeige|stellenangebot|stelle|job|anzeige) (merken|speichern|teilen|drucken)$/,
  /^(save|share|print) (this )?(job|position)$/,
  /^lokalisiere mich$/,
  /^(meinen )?standort (ermitteln|verwenden|bestimmen)$/,
  /^use my (current )?location$/,
  /^(alle )?filter (zurücksetzen|anwenden|löschen)$/,
  /^(reset|clear|apply) (all )?filters?$/,
  /^zurück zu(r|m)? (übersicht|suche|allen stellen|stellenübersicht|ergebnisliste|trefferliste)$/,
  /^back to (search|results|overview|all jobs)$/,
  /^(zur|zu den) (stellenübersicht|stellenbörse|jobbörse|übersicht|stellensuche)$/,
  /^job-?alert (erstellen|anlegen|einrichten|abonnieren)$/,

  // Career-site marketing and cross-links. Kept narrow on purpose: "Arbeiten
  // bei Bosch als Softwareentwickler" or "Weitere Stellen im Bereich Vertrieb"
  // could be a real listing, so only a short name / a "des … Konzerns" tail.
  /^(arbeiten|karriere) (bei|für) [^\s:]+( [^\s:]+){0,2}$/,
  /^folgen sie diesem link\b.*$/,
  /^(hier )?(alle |weitere )(attraktive |spannende |interessante )?(angebote|stellen|stellenangebote|jobs|offenen stellen)( (des|der|von|bei) [^\s:]+( [^\s:]+){0,3})?$/,
  /^(alle )?(stellen|jobs|stellenangebote) (anzeigen|ansehen|durchsuchen|entdecken)$/,
  /^(jetzt )?(ergreif(e)? die initiative|initiativbewerbung|initiativ bewerben)$/,
];

// A gender marker means a job title, whatever else the text looks like.
const GENDER_MARKER = /\(\s*[mwdfx](\s*[\/|,*:]\s*(div|[mwdfx]))+\s*\)|\b(all genders?|alle geschlechter)\b|\(gn\)/;

// Lowercase, collapse whitespace, drop surrounding quotes, arrows and trailing
// punctuation ("Seite 2 ›", "»Impressum«", "ERGREIF DIE INITIATIVE!").
export function normalizeLinkText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\u200b-\u200d\u2060\ufeff\u00ad]/g, '') // zero-width chars, soft hyphen
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'„“”‚‘’»«›‹<>→←\s]+/, '')
    .replace(/["'„“”‚‘’»«›‹<>→←.,:;!?…\s]+$/, '')
    .trim();
}

// True if a link text is navigation/UI chrome rather than a job title. A text
// that is nothing but the company's (source's) name is chrome too.
export function isNonJobLink(title, companyName = '') {
  const t = normalizeLinkText(title);
  if (!t) return true;
  if (GENDER_MARKER.test(t)) return false;
  const company = normalizeLinkText(companyName);
  if (company && t === company) return true;
  return NON_JOB_PATTERNS.some(re => re.test(t));
}
