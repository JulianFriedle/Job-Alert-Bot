// ── When to stop paginating a career page (#41) ──────────────────────────────
// Without a brake, one misbehaving site holds the whole scrape phase: Diehl
// paginated past page 40 with 30-second timeouts, Liebherr reset every
// connection from page 3 on. The guard counts pages, empty pages, failures and
// refused connections and says when to stop — and whether stopping means the
// source's result is incomplete (a problem worth showing in the run overview,
// and a reason not to expire jobs that simply weren't reached).
// Pure, unit-tested in test/pagination-guard.test.js.

export const DEFAULT_MAX_PAGES = 50;

// Errors that mean "the host refuses us", not "this page is broken".
const REFUSED = /ERR_CONNECTION_(RESET|REFUSED|CLOSED|ABORTED)|ERR_EMPTY_RESPONSE|ERR_HTTP2_PROTOCOL_ERROR|ECONNRESET|ECONNREFUSED|socket hang up/i;

export function createPaginationGuard({ maxPages = DEFAULT_MAX_PAGES, maxEmpty = 3, maxErrors = 3, maxRefused = 2 } = {}) {
  let pages = 1;        // page 1 is already done when pagination starts
  let emptyStreak = 0;
  let errorStreak = 0;
  let refused = 0;
  let stopReason = null;
  let problem = null;   // set when stopping leaves the result incomplete

  const stop = (reason, isProblem = false) => {
    stopReason ||= reason;
    if (isProblem) problem ||= reason;
  };

  return {
    get stopReason() { return stopReason; },
    get problem() { return problem; },
    get pages() { return pages; },

    // Ask before each further page.
    canFetch() {
      if (stopReason) return false;
      if (pages >= maxPages) { stop(`Seitenlimit erreicht (${maxPages})`); return false; }
      return true;
    },

    // A page was read; `added` = new jobs it contributed.
    page(added) {
      pages++;
      errorStreak = 0;
      if (added > 0) emptyStreak = 0;
      else if (++emptyStreak >= maxEmpty) stop(`${maxEmpty} Seiten in Folge ohne neue Stellen`);
    },

    // A page failed.
    error(err) {
      pages++;
      const msg = String(err?.message ?? err ?? '');
      const code = msg.match(REFUSED)?.[0];
      if (code && ++refused >= maxRefused) {
        stop(`Host bricht Verbindungen ab (${code}) – Paginierung nach Seite ${pages} gestoppt`, true);
      } else if (++errorStreak >= maxErrors) {
        stop(`${maxErrors} Seiten in Folge fehlgeschlagen – Paginierung nach Seite ${pages} gestoppt`, true);
      }
    },
  };
}
