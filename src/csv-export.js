// CSV export of the job list shown in the "Jobs" tab.
//
// Two concerns live here, both pure (no DB, no fs) so they can be unit-tested:
//   1. `filterJobs` — mirrors the client-side filtering/sorting of the Jobs tab,
//      so the export contains exactly the rows the operator sees, not more.
//   2. `buildJobsCsv` — turns those rows into an Excel-friendly CSV.
//
// Excel-friendly means: UTF-8 BOM (otherwise German umlauts arrive as mojibake
// on a double-click), semicolon as the separator (what Excel expects in a
// German/European locale) and CRLF line endings per RFC 4180.

export const DELIMITER = ';';
export const BOM = '﻿';

const STATUS_LABELS = {
  de: { applied: 'Beworben', interview: 'Interview', offer: 'Angebot', rejected: 'Abgelehnt' },
  en: { applied: 'Applied', interview: 'Interview', offer: 'Offer', rejected: 'Rejected' },
};

// Application-queue states (src/apply-worker.js state machine) → readable label.
const AP_STATE_LABELS = {
  de: {
    queued: 'In Warteschlange', preparing: 'Wird vorbereitet', awaiting_answers: 'Fragen offen',
    ready_for_review: 'Bereit zur Freigabe', approved: 'Freigegeben', submitting: 'Wird gesendet',
    submitted: 'Gesendet', failed: 'Fehlgeschlagen', discarded: 'Verworfen',
  },
  en: {
    queued: 'Queued', preparing: 'Preparing', awaiting_answers: 'Questions open',
    ready_for_review: 'Ready for review', approved: 'Approved', submitting: 'Submitting',
    submitted: 'Submitted', failed: 'Failed', discarded: 'Discarded',
  },
};

const BOOL_LABELS = { de: { yes: 'Ja', no: 'Nein' }, en: { yes: 'Yes', no: 'No' } };

function lang(l) { return l === 'en' ? 'en' : 'de'; }

// Local-time timestamp, formatted for the target locale. Kept explicit (rather
// than toLocaleString) so the output is stable regardless of the host's ICU data.
export function formatDateTime(iso, l = 'de') {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  const [y, mo, da, h, mi] = [d.getFullYear(), p(d.getMonth() + 1), p(d.getDate()), p(d.getHours()), p(d.getMinutes())];
  return lang(l) === 'en' ? `${y}-${mo}-${da} ${h}:${mi}` : `${da}.${mo}.${y} ${h}:${mi}`;
}

// Column definitions — order is the column order in the file. `value` receives
// the raw DB row plus the resolved language.
export const COLUMNS = [
  { key: 'title',            header: { de: 'Jobbezeichnung',    en: 'Job title' },        value: (j) => j.title },
  { key: 'company',          header: { de: 'Firma',             en: 'Company' },          value: (j) => j.company },
  { key: 'location',         header: { de: 'Ort',               en: 'Location' },         value: (j) => j.location },
  { key: 'score',            header: { de: 'Score',             en: 'Score' },            value: (j) => j.score ?? '' },
  { key: 'status',           header: { de: 'Status',            en: 'Status' },           value: (j, l) => STATUS_LABELS[l][j.status] || '' },
  { key: 'applied',          header: { de: 'Beworben',          en: 'Applied' },          value: (j, l) => (j.applied ? BOOL_LABELS[l].yes : BOOL_LABELS[l].no) },
  { key: 'applied_at',       header: { de: 'Beworben am',       en: 'Applied at' },       value: (j, l) => formatDateTime(j.applied_at, l) },
  { key: 'source',           header: { de: 'Quelle',            en: 'Source' },           value: (j) => j.source },
  { key: 'platform',         header: { de: 'Plattform',         en: 'Platform' },         value: (j) => j.platform },
  { key: 'easy_apply',       header: { de: 'Einfach bewerben',  en: 'Easy apply' },       value: (j, l) => (j.easy_apply ? BOOL_LABELS[l].yes : BOOL_LABELS[l].no) },
  { key: 'application_state',header: { de: 'Auto-Bewerbung',    en: 'Auto-application' }, value: (j, l) => AP_STATE_LABELS[l][j.application_state] || '' },
  { key: 'scraped_at',       header: { de: 'Gefunden am',       en: 'Found at' },         value: (j, l) => formatDateTime(j.scraped_at, l) },
  { key: 'analyzed_at',      header: { de: 'Analysiert am',     en: 'Analyzed at' },      value: (j, l) => formatDateTime(j.analyzed_at, l) },
  { key: 'last_seen_at',     header: { de: 'Zuletzt gesehen',   en: 'Last seen' },        value: (j, l) => formatDateTime(j.last_seen_at, l) },
  { key: 'expired',          header: { de: 'Abgelaufen',        en: 'Expired' },          value: (j, l) => (j.expired ? BOOL_LABELS[l].yes : BOOL_LABELS[l].no) },
  { key: 'summary',          header: { de: 'Zusammenfassung',   en: 'Summary' },          value: (j) => j.summary },
  { key: 'url',              header: { de: 'URL',               en: 'URL' },              value: (j) => j.url },
  { key: 'id',               header: { de: 'ID',                en: 'ID' },               value: (j) => j.id },
  { key: 'description',      header: { de: 'Beschreibung',      en: 'Description' },      value: (j) => j.description },
];

// RFC 4180 field escaping. Quotes are doubled; a field is quoted when it holds
// the delimiter, a quote or a line break. Leading "=", "+", "-" or "@" would be
// read as a formula by Excel/LibreOffice — prefix those with a tab so the cell
// stays plain text (CSV injection guard; the tab is invisible in the cell).
export function csvField(value) {
  let s = value === null || value === undefined ? '' : String(value);
  s = s.replace(/\r\n?/g, '\n');                    // normalize CR / CRLF inside cells
  if (/^[=+\-@]/.test(s)) s = `\t${s}`;
  return /["\n;,\t]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(values) {
  return values.map(csvField).join(DELIMITER);
}

// Full CSV document for the given job rows, BOM included.
export function buildJobsCsv(jobs, { lang: l = 'de' } = {}) {
  const L = lang(l);
  const lines = [csvRow(COLUMNS.map(c => c.header[L]))];
  for (const job of jobs) lines.push(csvRow(COLUMNS.map(c => c.value(job, L))));
  return BOM + lines.join('\r\n') + '\r\n';
}

// Same predicate + sort the Jobs tab applies client-side (see `filteredJobs` in
// public/app.js). Keep the two in sync — the export is only trustworthy if it
// reproduces the visible list exactly.
export function filterJobs(jobs, { q = '', source = '', status = '', minScore = 0, sort = 'default' } = {}) {
  const needle = String(q).trim().toLowerCase();
  const min = Number(minScore) || 0;
  const out = jobs.filter(j => {
    if (source && j.source !== source) return false;
    if ((j.score ?? 0) < min) return false;
    if (status === 'none' && j.status) return false;
    if (status && status !== 'none' && j.status !== status) return false;
    if (needle) {
      const hay = `${j.title ?? ''} ${j.company ?? ''} ${j.location ?? ''} ${j.source ?? ''}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
  // `scraped_at` is an ISO timestamp, so plain string comparison sorts correctly.
  // "default" keeps the order the database returned (relevance).
  if (sort === 'found-asc') out.sort((a, b) => (a.scraped_at || '').localeCompare(b.scraped_at || ''));
  else if (sort === 'found-desc') out.sort((a, b) => (b.scraped_at || '').localeCompare(a.scraped_at || ''));
  return out;
}

// data/jobs-2026-08-15.csv style name, with the client id folded in for
// multi-tenant installs so downloads don't overwrite each other.
export function csvFileName(clientId, defaultClientId, now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const slug = clientId && clientId !== defaultClientId
    ? '-' + String(clientId).replace(/[^A-Za-z0-9_-]/g, '_')
    : '';
  return `jobs${slug}-${stamp}.csv`;
}
