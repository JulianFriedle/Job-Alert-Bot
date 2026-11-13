// Problem reports for sources that failed or came back empty during a run.
//
// The GUI offers a "report a problem" button for every such source. It opens a
// pre-filled GitHub issue form (.github/ISSUE_TEMPLATE/scraper-problem.yml) in the
// user's browser — nothing is sent from the server, and the user reviews and
// submits the issue themselves. Because the target repo is public, the report
// carries only what's needed to reproduce the scrape: no profile, no client name,
// no job titles, and no platform search terms (those are the user's job search).
import { PLATFORM_TYPES } from './scrapers/index.js';

export const DEFAULT_ISSUE_REPO = 'JulianFriedle/Job-Alert-Bot';
export const ISSUE_TEMPLATE = 'scraper-problem.yml';
export const ISSUE_LABEL = 'scraper';

// GitHub rejects very long "new issue" URLs; stay well below its limit.
const MAX_URL_LENGTH = 7500;

// Scraper-tuning fields of a career-page source that help reproduce the scrape.
// Everything else on a source (search terms, credentials, ...) stays local.
const SAFE_CONFIG_KEYS = [
  'paginationMode', 'paginationParam', 'paginationStep', 'jobUrlPattern',
  'allowExternalLinks', 'extraWait', 'apiOnly', 'apiUrl',
];

const PROBLEM_LABELS = {
  error:   'Fehler beim Scrapen',
  blocked: 'Blockiert (Challenge/Ablehnung)',
  empty:   '0 Stellen gefunden',
};

// Why a source looks broken this run, or null when it's fine. An exception wins
// over a block, a block over an empty result. Zero jobs always counts: a career
// page with genuinely no openings is rare, a broken selector is not.
export function classifySourceProblem({ found = 0, blocked = false, error = null } = {}) {
  if (error) return 'error';
  if (blocked) return 'blocked';
  if (!(Number(found) > 0)) return 'empty';
  return null;
}

export function issueRepo(env = process.env) {
  const repo = String(env.ISSUE_REPO || '').trim();
  return /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : DEFAULT_ISSUE_REPO;
}

// Origin + path only: query strings and fragments can carry search terms,
// session ids or tracking tokens; userinfo can carry credentials.
export function sanitizeUrl(raw) {
  try {
    const u = new URL(String(raw));
    if (!/^https?:$/.test(u.protocol)) return '';
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '';
  }
}

// Error messages often quote the URL that failed (with its query) and local paths.
export function sanitizeText(text) {
  return String(text ?? '')
    .replace(/https?:\/\/[^\s"'<>)\]]+/g, (m) => sanitizeUrl(m) || '[URL]')
    .replace(/(\/home|\/Users)\/[^/\s]+/g, '~')
    .replace(/[A-Z]:\\Users\\[^\\\s]+/gi, '~')
    .replace(/`/g, "'");
}

const cell = (v) => sanitizeText(v).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

// source  — the source config object (from getSources), may be undefined if it
//           was removed since the run
// row     — the run_stats row ({ source, found, siteTotal, problem, error })
// run     — { id, ranAt }
// history — [{ ranAt, found, problem }] newest first, this source only
export function buildSourceReport({ source, row, run, history = [], version = '', nodeVersion = process.version }) {
  const isPlatform = Boolean(source && PLATFORM_TYPES.includes(source.type));
  // A platform source's name usually is the search ("LinkedIn – PM München"),
  // so it is replaced by the platform type.
  const label = isPlatform ? source.type : (row?.source || source?.name || '?');
  const problem = row?.problem || 'empty';
  const problemText = PROBLEM_LABELS[problem] || problem;

  const lines = [
    '| Feld | Wert |',
    '|---|---|',
    `| Quelle | ${cell(label)} |`,
    `| Typ | ${isPlatform ? `Plattform (${source.type})` : 'Karriereseite'} |`,
  ];
  if (!isPlatform) lines.push(`| URL | ${cell(sanitizeUrl(source?.url) || '(unbekannt)')} |`);
  lines.push(`| Problem | ${problemText} |`);
  if (row?.error) lines.push(`| Fehlermeldung | ${cell(row.error).slice(0, 500)} |`);
  lines.push(`| Gefunden | ${row?.found ?? 0}${row?.siteTotal != null ? ` (Website meldet ${row.siteTotal})` : ''} |`);
  if (run?.ranAt) lines.push(`| Lauf | ${cell(run.ranAt)} |`);
  if (version) lines.push(`| Version | ${cell(version)} |`);
  lines.push(`| Node | ${cell(nodeVersion)} |`);

  if (history.length) {
    const trail = history
      .map(h => (h.problem && h.problem !== 'empty' ? `${h.found}!` : String(h.found)))
      .join(' ← ');
    lines.push('', `**Gefundene Stellen, letzte ${history.length} Läufe (neueste links, ! = Fehler/blockiert):** ${trail}`);
  }

  if (!isPlatform && source) {
    const cfg = SAFE_CONFIG_KEYS
      .filter(k => source[k] !== undefined && source[k] !== null && source[k] !== '')
      .map(k => `- \`${k}\`: ${cell(k === 'apiUrl' ? sanitizeUrl(source[k]) : JSON.stringify(source[k]))}`);
    if (cfg.length) lines.push('', '**Quell-Konfiguration:**', ...cfg);
  }

  return {
    title: `[Scraper] ${label}: ${problemText}`,
    fields: { source: label, diagnose: lines.join('\n') },
  };
}

// Pre-filled "new issue" URL. Issue forms accept field values by field id as
// query parameters. The diagnose block is trimmed if the URL would get too long.
export function buildIssueUrl(repo, { title, fields }) {
  const make = (f) => {
    const u = new URL(`https://github.com/${repo}/issues/new`);
    u.searchParams.set('template', ISSUE_TEMPLATE);
    u.searchParams.set('labels', ISSUE_LABEL);
    u.searchParams.set('title', title);
    for (const [k, v] of Object.entries(f)) if (v) u.searchParams.set(k, v);
    return u.toString();
  };
  let url = make(fields);
  if (url.length > MAX_URL_LENGTH && fields.diagnose) {
    const over = url.length - MAX_URL_LENGTH;
    // Encoded length ≥ raw length, so cutting `over` raw chars plus a margin is enough.
    const keep = Math.max(0, fields.diagnose.length - over * 3 - 50);
    url = make({ ...fields, diagnose: `${fields.diagnose.slice(0, keep)}\n…(gekürzt)` });
  }
  return url;
}
