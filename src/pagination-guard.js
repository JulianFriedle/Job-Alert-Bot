// ── When to stop paginating a career page (#41) ──────────────────────────────
// Without a brake, one misbehaving site holds the whole scrape phase: Diehl
// paginated past page 40 with 30-second timeouts, Liebherr reset every
// connection from page 3 on. The guard counts pages, empty pages, failures and
// refused connections and says when to stop.
//
// Stopping must not quietly cost jobs: there is no new default page limit (the
// strategies keep their built-in caps; `maxPages` only applies when a source
// sets it), and an "empty" page is one that yielded no jobs at all (a page of
// already-seen jobs is not empty). When failures end the pagination — the
// host refusing connections, or a streak of failed pages — pages are known to
// be unread: that is a `problem`, the result is incomplete, and the run must
// not expire jobs that simply weren't reached. A single failure the walk
// recovers from, and the normal end of a list, are not.
// Pure, unit-tested in test/pagination-guard.test.js.

// Errors that mean "the host refuses us", not "this page is broken".
const REFUSED = /ERR_CONNECTION_(RESET|REFUSED|CLOSED|ABORTED)|ERR_EMPTY_RESPONSE|ERR_HTTP2_PROTOCOL_ERROR|ECONNRESET|ECONNREFUSED|socket hang up/i;

export function createPaginationGuard({ maxPages = Infinity, maxEmpty = 3, maxErrors = 3, maxRefused = 2 } = {}) {
  let pages = 1;        // page 1 is already done when pagination starts
  let emptyStreak = 0;
  let errorStreak = 0;
  let refused = 0;
  let stopReason = null;
  let problem = null;   // pagination ended by failures: the result is incomplete
  let lastFailed = false;

  const stop = (reason, isProblem = false) => {
    stopReason ||= reason;
    if (isProblem) problem ||= reason;
  };

  return {
    get stopReason() { return stopReason; },
    get problem() { return problem; },
    get pages() { return pages; },
    // The most recent page failed — if the walk ends here, that page is unread.
    get trailingFailure() { return lastFailed; },

    // A failure the caller can't continue after (one loop gives up on it).
    giveUp(reason) { stop(reason, true); },

    // Ask before each further page.
    canFetch() {
      if (stopReason) return false;
      if (pages >= maxPages) { stop(`Seitenlimit der Quelle erreicht (${maxPages})`); return false; }
      return true;
    },

    // A page was read. `extracted` = jobs found on it (null: don't judge
    // emptiness — load-more re-reads the whole list and has its own end rule).
    page(added, extracted = added) {
      pages++;
      errorStreak = 0;
      lastFailed = false;
      if (extracted == null) return;
      if (extracted > 0) emptyStreak = 0;
      else if (++emptyStreak >= maxEmpty) stop(`${maxEmpty} Seiten in Folge ohne Stellen`);
    },

    // A page failed.
    error(err) {
      pages++;
      lastFailed = true;
      const msg = String(err?.message ?? err ?? '');
      const code = msg.match(REFUSED)?.[0];
      if (code && ++refused >= maxRefused) {
        stop(`Host bricht Verbindungen ab (${code}) – Paginierung nach Seite ${pages} abgebrochen`, true);
      } else if (++errorStreak >= maxErrors) {
        stop(`${maxErrors} Seiten in Folge fehlgeschlagen – Paginierung nach Seite ${pages} abgebrochen`, true);
      }
    },
  };
}
