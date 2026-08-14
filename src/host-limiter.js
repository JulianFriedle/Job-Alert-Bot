// Per-host pacing for the scrape phases.
//
// What bot detection reacts to is requests-per-second *per host*, not our global
// throughput. Walking a job list in array order gets that backwards: the list is
// grouped by source, so every worker sits on the same company's site at once
// while all the other hosts idle — a burst on one server, then a burst on the
// next. Bucketing by host inverts it: each host serves `perHost` requests at a
// time with a jittered gap between them, and a free worker always takes the
// bucket that has been idle longest. The pool stays full across many hosts, and
// no single site sees more than one visitor.
//
// The knock-on effect is that global concurrency stops being the safety valve —
// the per-host gap is — so the pool can be widened without any site noticing.

// Bucket by registrable domain rather than by hostname: a shared applicant
// tracking system (`acme.jobs.personio.de`, `beta.jobs.personio.de`) is one
// operator behind many "companies", and it is the one most likely to rate-limit
// centrally. Grouping too coarsely only costs time; too finely costs a block.
const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk',
  'com.au', 'net.au', 'org.au', 'co.nz',
  'co.jp', 'ne.jp', 'or.jp', 'co.kr',
  'com.br', 'com.mx', 'com.tr', 'com.cn', 'co.in', 'co.za',
]);

export function registrableDomain(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    // Unparseable input gets its own bucket keyed by the raw string — better a
    // pointless bucket than one that silently merges unrelated hosts.
    return String(url ?? '').toLowerCase();
  }
  if (!hostname) return '';
  // IPv4/IPv6 literals have no registrable domain to strip back to.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) return hostname;

  const labels = hostname.split('.');
  if (labels.length <= 2) return hostname;
  const lastTwo = labels.slice(-2).join('.');
  return MULTI_PART_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// How often a worker re-checks for a free bucket when every remaining item
// belongs to a host that is currently busy.
const IDLE_POLL_MS = 25;

/**
 * Run `handler` over `items`, never exceeding `perHost` concurrent calls per
 * host and always leaving at least `minGapMs` (plus up to `jitterMs`) between
 * one call finishing and the next starting on that same host.
 *
 * Items are grouped by `keyOf` and served round-robin, least-recently-used
 * first, so the work interleaves across hosts instead of marching through them.
 * Handler rejections are collected rather than thrown, so one bad item cannot
 * strand the in-flight slot of its host or kill the pool.
 *
 * Returns { errors, hosts, largestHost }.
 */
export async function runHostLimited(items, handler, {
  keyOf = (item) => registrableDomain(item),
  concurrency = 8,
  perHost = 1,
  minGapMs = 1500,
  jitterMs = 1000,
} = {}) {
  const buckets = new Map();
  items.forEach((item, index) => {
    const key = keyOf(item, index) || '';
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { key, queue: [], inFlight: 0, readyAt: 0 };
      buckets.set(key, bucket);
    }
    bucket.queue.push({ item, index });
  });

  const all = [...buckets.values()];
  const errors = [];
  const largestHost = all.reduce((max, b) => Math.max(max, b.queue.length), 0);
  if (items.length === 0) return { errors, hosts: 0, largestHost: 0 };

  let pending = items.length;

  // Take the claimable bucket that has been idle longest. Skipping busy buckets
  // is what produces the interleaving; picking the smallest readyAt is what
  // keeps a host from being starved by louder neighbours.
  function claim() {
    let best = null;
    for (const bucket of all) {
      if (bucket.queue.length === 0 || bucket.inFlight >= perHost) continue;
      if (!best || bucket.readyAt < best.readyAt) best = bucket;
    }
    if (!best) return null;
    best.inFlight++;
    return { bucket: best, ...best.queue.shift() };
  }

  async function worker() {
    while (pending > 0) {
      const claimed = claim();
      if (!claimed) {
        await sleep(IDLE_POLL_MS);
        continue;
      }
      const { bucket, item, index } = claimed;
      // Held slot + wait: the bucket is reserved for us while we sit out its
      // cooldown, so no other worker can jump the gap we are honouring.
      const wait = bucket.readyAt - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        await handler(item, index, bucket.key);
      } catch (err) {
        errors.push(err);
      } finally {
        bucket.inFlight--;
        bucket.readyAt = Date.now() + minGapMs + Math.floor(Math.random() * (jitterMs + 1));
        pending--;
      }
    }
  }

  // More workers than the buckets can feed would only busy-poll.
  const workers = Math.max(1, Math.min(concurrency, items.length, all.length * perHost));
  await Promise.all(Array.from({ length: workers }, worker));

  return { errors, hosts: all.length, largestHost };
}
