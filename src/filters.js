// ── Pre-filters: title and location (#34, #36) ──────────────────────────────
// Pure functions shared by the pipeline (src/scheduler.js) and the GUI's filter
// editor preview (POST /api/filters/preview). Unit-tested in
// test/filters.test.js.
// German postings routinely wedge a gender marker into the middle of the title
// ("Entwickler (m/w/d) für Embedded Systeme", "Ingenieur*in Fertigungstechnik"),
// which breaks the plain substring match the filters use — the first would miss a
// keyword like "entwickler für embedded" entirely. Drop the marker before matching
// so a keyword list stays a list of role names, not a list of spelling variants.
const foldTitle = (s) => String(s || '')
  .toLowerCase()
  .replace(/\(\s*[mwdfx*:/\s-]+\)/g, ' ')  // (m/w/d), (w/m/d), (m/w/x), (d/w/m) …
  .replace(/[*:]in\b/g, 'in')              // Referent*in / Referent:in → Referentin
  .replace(/\s+/g, ' ');

export function normalizeTitle(title) {
  return foldTitle(title).trim();
}

// Keywords go through the same folding as the title — lowercase, gender forms,
// whitespace — or "Praktikum" or "referent:in" could never match. Not trimmed:
// a padded keyword like " sap " (config/filters.json) matches a whole word.
const keywordList = (list) => (Array.isArray(list) ? list : [])
  .map(k => {
    const raw = String(k ?? '');
    let folded = foldTitle(raw);
    // Keep padding the user typed, drop padding the folding created
    // ("Ingenieur (m/w/d)" → "ingenieur", not "ingenieur ").
    if (!/^\s/.test(raw)) folded = folded.replace(/^\s+/, '');
    if (!/\s$/.test(raw)) folded = folded.replace(/\s+$/, '');
    return folded;
  })
  .filter(k => k.trim() !== '');

// Summary of a job dropped only because it matched no allowlist term. Unlike a
// blocklist drop this is undone: once the allowlist lets the title through
// (typo fixed, term added), the job goes back to the analysis queue.
export const NOT_ALLOWED_SUMMARY = 'Titel nicht in der Positivliste – nicht bewertet';
// At most this many such jobs go back per run: one broad new term could
// otherwise release thousands of detail-page fetches and Claude calls at once.
export const MAX_REOPEN_PER_RUN = 100;

// ── Location pre-filter (#36) ────────────────────────────────────────────────
// Large career pages list openings worldwide. With a location list set, a
// career-page job whose location contains none of its terms never reaches
// Claude. Deliberately lenient: a job without a location, a remote job, and
// every job-board result (those searches carry their own location + radius,
// so "Stuttgart" would wrongly drop "Esslingen") always pass.
export const WRONG_LOCATION_SUMMARY = 'Ort nicht in der Ortsliste – nicht bewertet';

// Lowercase, no accents, umlauts and ß folded the same way on both sides, so
// "München", "Muenchen" and "Munchen" (or "Düsseldorf"/"Duesseldorf") match.
const foldPlace = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/ß/g, 'ss').replace(/([aou])e/g, '$1')
  .replace(/\s+/g, ' ').trim();

// Locations that name no place to filter by: kept, like a missing location.
const ALWAYS_OK_LOCATIONS = ['remote', 'homeoffice', 'home office', 'home-office', 'mobiles arbeiten',
  'deutschlandweit', 'bundesweit', 'mehrere standorte', 'diverse standorte', 'verschiedene standorte',
  'flexibel', 'flexible', 'hybrid', 'anywhere', 'weltweit', 'global', 'multiple locations',
  'various locations'].map(foldPlace);

// Country names in German and English. A country term in the list keeps every
// job that names no OTHER country: "Berlin" passes "Deutschland", "Etowah,
// TN, United States" does not.
const COUNTRIES = {
  de: ['deutschland', 'germany'], at: ['österreich', 'austria'], ch: ['schweiz', 'switzerland'],
  fr: ['frankreich', 'france'], it: ['italien', 'italy'], es: ['spanien', 'spain'],
  pt: ['portugal'], nl: ['niederlande', 'netherlands', 'holland'], be: ['belgien', 'belgium'],
  lu: ['luxemburg', 'luxembourg'], pl: ['polen', 'poland', 'polska'], cz: ['tschechien', 'czech republic', 'czechia'],
  sk: ['slowakei', 'slovakia'], hu: ['ungarn', 'hungary'], ro: ['rumänien', 'romania'], bg: ['bulgarien', 'bulgaria'],
  hr: ['kroatien', 'croatia'], si: ['slowenien', 'slovenia'], rs: ['serbien', 'serbia'], gr: ['griechenland', 'greece'],
  tr: ['türkei', 'turkey', 'türkiye'], dk: ['dänemark', 'denmark'], se: ['schweden', 'sweden'], no: ['norwegen', 'norway'],
  fi: ['finnland', 'finland'], ie: ['irland', 'ireland'], gb: ['großbritannien', 'vereinigtes königreich', 'united kingdom', 'england', 'scotland', 'uk'],
  us: ['usa', 'vereinigte staaten', 'united states', 'u.s.'], ca: ['kanada', 'canada'], mx: ['mexiko', 'mexico'],
  br: ['brasilien', 'brazil', 'brasil'], ar: ['argentinien', 'argentina'], cl: ['chile'],
  cn: ['china', 'volksrepublik china'], jp: ['japan'], kr: ['südkorea', 'south korea', 'korea'], in: ['indien', 'india'],
  sg: ['singapur', 'singapore'], my: ['malaysia'], th: ['thailand'], vn: ['vietnam'], au: ['australien', 'australia'],
  za: ['südafrika', 'south africa'], ae: ['vereinigte arabische emirate', 'united arab emirates', 'uae'],
  il: ['israel'], ma: ['marokko', 'morocco'], tn: ['tunesien', 'tunisia'], eg: ['ägypten', 'egypt'], ua: ['ukraine'],
  ru: ['russland', 'russia'], ee: ['estland', 'estonia'], lv: ['lettland', 'latvia'], lt: ['litauen', 'lithuania'],
  ph: ['philippinen', 'philippines'], id: ['indonesien', 'indonesia'], tw: ['taiwan'], hk: ['hongkong', 'hong kong'],
  pk: ['pakistan'], bd: ['bangladesch', 'bangladesh'], nz: ['neuseeland', 'new zealand'],
  sa: ['saudi-arabien', 'saudi arabia'], qa: ['katar', 'qatar'], co: ['kolumbien', 'colombia'], pe: ['peru'],
  cr: ['costa rica'], ng: ['nigeria'], ke: ['kenia', 'kenya'],
};
const COUNTRY_RES = Object.entries(COUNTRIES).map(([code, names]) => ({
  code,
  re: new RegExp(`(^|[^\\p{L}])(${names.map(n => foldPlace(n).replace(/[.]/g, '\\.')).join('|')})(?=$|[^\\p{L}])`, 'u'),
}));
const countriesIn = (folded) => COUNTRY_RES.filter(c => c.re.test(folded)).map(c => c.code);

export function createLocationFilter(list) {
  const terms = (Array.isArray(list) ? list : []).map(foldPlace).filter(Boolean);
  // A term that is nothing but a country name ("Deutschland") works per country.
  const listCountries = new Set(terms.flatMap(t => {
    const c = countriesIn(t);
    return c.length === 1 && COUNTRIES[c[0]].map(foldPlace).includes(t) ? c : [];
  }));
  const reject = (job) => {
    if (terms.length === 0 || job?.platform) return null;
    const loc = foldPlace(job?.location);
    if (!loc || ALWAYS_OK_LOCATIONS.some(t => loc.includes(t))) return null;
    if (terms.some(t => loc.includes(t))) return null;
    if (listCountries.size > 0) {
      const named = countriesIn(loc);
      // No country named at all ("Berlin"): a listed country may well be meant.
      if (named.length === 0 || named.some(c => listCountries.has(c))) return null;
    }
    return 'wrong-location';
  };
  return { reject, hasList: terms.length > 0 };
}

// The title pre-filters of one client. `reject(title)` says why a job never
// reaches Claude: 'blocked' (blocklist hit) or 'not-allowed' (an allowlist is
// set and the title matches none of it) — null means it goes on. An empty
// allowlist restricts nothing; a priority keyword counts as allowed; the
// blocklist always wins.
export function createTitleFilter({ titleBlocklist, priorityKeywords, titleAllowlist } = {}) {
  const block = keywordList(titleBlocklist);
  const prio = keywordList(priorityKeywords);
  const allow = keywordList(titleAllowlist);
  const hits = (title, list) => {
    const t = normalizeTitle(title);
    return list.some(kw => t.includes(kw));
  };
  const isBlocked = (title) => hits(title, block);
  const isPriority = (title) => hits(title, prio);
  const isAllowed = (title) => allow.length === 0 || hits(title, allow) || isPriority(title);
  const reject = (title) => (isBlocked(title) ? 'blocked' : isAllowed(title) ? null : 'not-allowed');
  return { isBlocked, isPriority, isAllowed, reject, hasAllowlist: allow.length > 0 };
}

// What a filter draft would do to a list of jobs: counts per reason and a few
// example titles for each, for the editor's "Testen" button.
export function previewFilters(filters, jobs, sampleSize = 8) {
  const title = createTitleFilter(filters);
  const location = createLocationFilter(filters?.locationAllowlist);
  const out = {
    total: jobs.length, kept: 0,
    dropped: { blocked: 0, 'not-allowed': 0, 'wrong-location': 0 },
    samples: { kept: [], blocked: [], 'not-allowed': [], 'wrong-location': [] },
  };
  for (const job of jobs) {
    const reason = title.reject(job.title) ?? location.reject(job);
    const bucket = reason ?? 'kept';
    if (reason) out.dropped[reason]++; else out.kept++;
    const label = job.location ? `${job.title} — ${job.location}` : job.title;
    if (out.samples[bucket].length < sampleSize && !out.samples[bucket].includes(label)) out.samples[bucket].push(label);
  }
  return out;
}

// Lines of a filter-list textarea → keywords. Not trimmed: a padded keyword
// like " hr " (shipped default) only matches the whole word — trimmed, "hr"
// would block "Fahrer", "Lehrer", "mehr". Blank lines and \r are dropped.
// The GUI (public/app.js filterLines, public/setup.js) applies the same rule.
export function keywordLines(value) {
  const lines = Array.isArray(value) ? value.map(x => String(x ?? '')) : String(value ?? '').split('\n');
  return lines.map(x => x.replace(/\r/g, '')).filter(x => x.trim() !== '');
}
