// ── Sources: JSON export / import (#31) ──────────────────────────────────────
// Moving ~80 career pages between installations used to mean 80 manual
// entries, and the per-source fields the Quellen tab doesn't show
// (paginationParam, apiUrl, maxPages, personioFeed, …) were lost on the way.
// The export is jobs.json-compatible ({ "sources": [...] }) and keeps every
// field; the import validates like PUT /api/sources and merges or replaces.
//
// Pure functions: loaded in the browser as a module (it sets window.SourcesIO
// for app.js) and imported by test/sources-io.test.js in Node.

const PLATFORM_TYPES = ['linkedin', 'stepstone', 'indeed'];

// What makes two entries the same source: the career page URL (scheme, case
// of the host, trailing slash and #fragment don't count), or a job-board
// search's portal + keywords + location.
export function sourceKey(s) {
  if (PLATFORM_TYPES.includes(s?.type)) {
    const q = s.search || {};
    return `${s.type}|${String(q.keywords || '').trim().toLowerCase()}|${String(q.location || '').trim().toLowerCase()}`;
  }
  try {
    const u = new URL(String(s?.url || '').trim());
    const path = u.pathname.replace(/\/+$/, '');
    return `page|${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return `page|${String(s?.url || '').trim().toLowerCase()}`;
  }
}

// Why an entry can't be imported, or null. The same rules as PUT /api/sources.
export function sourceProblem(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return 'kein Objekt';
  if (typeof s.name !== 'string' || !s.name.trim()) return 'Name fehlt';
  if (PLATFORM_TYPES.includes(s.type)) {
    if (!s.search || typeof s.search.keywords !== 'string' || !s.search.keywords.trim()) return 'Suchbegriff fehlt';
    return null;
  }
  if (typeof s.url !== 'string' || !/^https?:\/\//i.test(s.url.trim())) return 'URL fehlt oder ist keine http(s)-Adresse';
  return null;
}

// Parse an export file (or a hand-made jobs.json / bare array). Throws on
// unreadable JSON; invalid entries are reported, not fatal.
export function parseSourcesFile(text) {
  let data;
  try { data = JSON.parse(String(text ?? '').replace(/^﻿/, '')); }
  catch (e) { throw new Error(`Keine gültige JSON-Datei: ${e.message}`); }
  const list = Array.isArray(data) ? data : data?.sources;
  if (!Array.isArray(list)) throw new Error('Erwarte { "sources": [ … ] } oder eine Liste von Quellen');
  const valid = [];
  const invalid = [];
  list.forEach((s, i) => {
    const problem = sourceProblem(s);
    if (problem) invalid.push({ index: i + 1, name: typeof s?.name === 'string' ? s.name : '', problem });
    else valid.push(s);
  });
  return { valid, invalid };
}

// `merge`: the current list plus every imported source it doesn't have yet
// (the current list is kept exactly as it is). `replace`: exactly the file —
// two entries with the same URL may be intentional (different jobUrlPattern …).
export function combineSources(current, imported, mode) {
  if (mode === 'replace') return { sources: [...imported], added: imported.length, skipped: 0 };
  const seen = new Set(current.map(sourceKey));
  const added = imported.filter(s => { const k = sourceKey(s); if (seen.has(k)) return false; seen.add(k); return true; });
  return { sources: [...current, ...added], added: added.length, skipped: imported.length - added.length };
}

// How many imported sources are new against the current list.
export function countNew(current, imported) {
  const have = new Set(current.map(sourceKey));
  return imported.filter(s => !have.has(sourceKey(s))).length;
}

export function exportFileName(clientName, date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  const slug = String(clientName || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `quellen${slug ? `-${slug}` : ''}-${day}.json`;
}

if (typeof window !== 'undefined') {
  window.SourcesIO = { sourceKey, sourceProblem, parseSourcesFile, combineSources, countNew, exportFileName };
}
