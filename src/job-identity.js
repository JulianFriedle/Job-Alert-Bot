// ── Same posting, two URLs ───────────────────────────────────────────────────
// The generic scraper reads a listing twice: anchors in the DOM and job arrays
// in intercepted JSON responses. Usually both carry the same detail URL, but
// some APIs point elsewhere — Rolls-Royce's API gives the Workday apply link
// (…/Head-of-Component-Engineering_JR6162978-1/apply) while the page links
// /de/stellenangebote/head-of-component-engineering/JR6162978. URL dedup can't
// see that, so every posting was kept twice: twice the detail fetches and
// twice the Claude calls.
//
// What both URLs share is the posting's ID. An ID token here is a run of
// letters/digits with at least four digits ("JR6162978", "2090415"). A token
// only counts as an ID while it occurs in exactly one URL of its channel: a
// tenant or site ID that appears in every apply link is not a posting ID.
// Matching is only ever across channels — two DOM links are never merged by
// token, only by URL.
//
// Pure, no DOM — unit-tested in test/job-identity.test.js.

export function idTokens(url) {
  let u;
  try { u = new URL(url); } catch { return []; }
  const parts = [u.pathname, ...u.searchParams.values()].join('/');
  const tokens = parts.split(/[^A-Za-z0-9]+/).filter(t => t.length >= 5 && /\d{4,}/.test(t));
  return [...new Set(tokens)];
}

export function createCrossChannelDedup() {
  // channel → token → number of accepted URLs in that channel carrying it
  const counts = { dom: new Map(), api: new Map() };

  // True when `url` from `channel` carries an ID token that exactly one URL of
  // the other channel carries too (and no other URL of its own channel).
  // Otherwise the URL is recorded and false is returned.
  return function isCrossChannelDuplicate(url, channel) {
    const own = counts[channel];
    const other = counts[channel === 'api' ? 'dom' : 'api'];
    const tokens = idTokens(url);
    const dup = tokens.some(t => other.get(t) === 1 && !own.has(t));
    if (!dup) for (const t of tokens) own.set(t, (own.get(t) || 0) + 1);
    return dup;
  };
}
