// ── Learn a site's job-URL pattern from the page itself ──────────────────────
// Some listings link their postings under paths no default selector knows
// (Stellenwerk: /stuttgart/werkstudent-marketing-…-261113-279979). The
// `jobUrlPattern` source field covers them — when it is set. When page 1
// yields nothing, the links themselves can tell: an anchor whose text carries a
// gender marker ("(m/w/d)") is a job title, and the other postings share its
// URL shape. Two such anchors with the same shape make a pattern.
//
// Shape of a URL: host + parent path, plus the last path segment with letter
// runs folded to `a` and digit runs to `9` ("…-261113-279979" → "a-9-9").
// Only shapes whose last segment holds a digit run of 3+ (a posting ID) count,
// so "/stuttgart/events" or "/karriere" never become patterns.
//
// Pure — unit-tested in test/job-url-pattern.test.js.

import { GENDER_MARKER } from './link-filter.js';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function shapeOf(href) {
  let u;
  try { u = new URL(href); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const segs = u.pathname.replace(/\/+$/, '').split('/');
  const last = segs.pop() || '';
  if (!/\d{3,}/.test(decodeURIComponent(last))) return null;
  const tail = last.replace(/\d+/g, '9').replace(/[^\d9\-_.]+/g, 'a').replace(/a(?:[-_.]a)+/g, 'a');
  return { key: `${u.host}${segs.join('/')}/${tail}`, host: u.host, dir: segs.join('/'), tail };
}

function regexFor({ host, dir, tail }) {
  const body = tail.split(/(a|9)/).filter(Boolean)
    .map(t => (t === 'a' ? '[^/?#]*?' : t === '9' ? '\\d+' : escapeRe(t))).join('');
  return `^https?://${escapeRe(host)}${escapeRe(dir)}/${body}/?(?:[?#].*)?$`;
}

// anchors: [{ href, text }] → a regex source string, or null.
export function learnJobUrlPattern(anchors) {
  const byShape = new Map();
  for (const a of anchors || []) {
    if (!GENDER_MARKER.test(String(a?.text || '').toLowerCase())) continue;
    const shape = shapeOf(a.href);
    if (!shape) continue;
    const entry = byShape.get(shape.key) || { shape, urls: new Set() };
    entry.urls.add(a.href);
    byShape.set(shape.key, entry);
  }
  const best = [...byShape.values()].filter(e => e.urls.size >= 2).sort((x, y) => y.urls.size - x.urls.size)[0];
  return best ? regexFor(best.shape) : null;
}
