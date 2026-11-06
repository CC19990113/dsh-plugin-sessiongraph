/**
 * Lazy incremental refresh: a query should not answer from an index that is hours old when the
 * machine has been writing session logs all along.
 *
 * The indexer refreshes in the background when a *new session* is created, which leaves one gap: the
 * session currently being written has no successor yet, so the model asking "what did we just say"
 * would search an index that predates the current conversation. This module closes that gap on the
 * query path — but only when the sidecar says the index is older than `freshnessThresholdMs`, and
 * never at the price of the query itself: a refresh that fails or is handed to a background job is
 * logged/skipped and the answer is served from the index as it stands.
 *
 * Two rules shape the implementation:
 *
 * - The decision reads `<indexRoot>/status.json`, the same synchronous sidecar prompt assembly reads.
 *   Opening SQLite to ask "how old are you" would put a database on every query's critical path.
 * - One incremental run per index root at a time. A model that fires two queries in parallel joins
 *   the in-flight run instead of starting a second one; a burst must not turn into a rebuild storm.
 * @module dsh-plugin-sessiongraph-tool/refresh
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { INDEX_RELATIVE_PATH } from 'dsh-plugin-sessiongraph-service'
import type { SessiongraphIndexOptions, SessiongraphIndexReport } from 'dsh-plugin-sessiongraph-service'
import { readIndexStatus } from './status-hint.ts'

/**
 * The options a lazy refresh sends, and the one it deliberately does not.
 *
 * A job-capable indexer reads the owning session id from a runtime extension of the seam's options
 * (`owner`); it hands the run to the host's background-job registry only when that extension is
 * present. Omitting it is therefore how this call asks for a synchronous report — the whole point,
 * because the query must answer with the refreshed index, not with a promise about one. A run that
 * some indexer still delegates is detected by its `jobId` (see {@link isCompletedReport}) and skipped:
 * the query answers from the previous index, and the job makes the next call fresh.
 */
export type SynchronousIndexOptions = SessiongraphIndexOptions

/** What one `ensureFresh` call decided and did, for the renderer's staleness note. */
export interface RefreshOutcome {
  /** True when this call actually ran an incremental index (and got a report back). */
  readonly refreshed: boolean
  /** True when the answer is served from an index that may predate the conversation. */
  readonly stale: boolean
}

/** The outcome of a call that decided to leave the index alone. */
const IDLE: RefreshOutcome = { refreshed: false, stale: false }

/** Dependencies a {@link LazyIndexRefresher} needs; all injected so the decision stays testable. */
export interface LazyRefreshDeps {
  /** Absolute directory holding the index and its sidecar. */
  readonly indexRoot: string
  /**
   * Age at which the index counts as stale, milliseconds. `0` disables lazy refresh entirely — the
   * query then trusts the indexer's own schedule and never spends a query budget on indexing.
   */
  readonly freshnessThresholdMs: number
  /**
   * Run one incremental index. Resolves with the seam's report, or with whatever a job-capable
   * indexer returned instead; rejecting is expected and handled.
   * @param options - an incremental scope with no owning-session extension, so the run stays
   *   synchronous.
   * @param signal - aborts the run.
   */
  readonly index: (options: SynchronousIndexOptions, signal?: AbortSignal) => Promise<unknown>
  /** Clock, injected so a test can place the sidecar on either side of the threshold. */
  readonly now?: () => number
  /** Sink for the single explanatory line a failed refresh logs (default `console.error`). */
  readonly logError?: (message: string) => void
}

/**
 * Refresh one index root lazily, at most once at a time.
 *
 * The instance is process-local state (one per plugin registration), which is exactly the scope the
 * requirement names: a second query in the same process joins the run already in flight, while a
 * second DSH process is a separate writer the indexer's own atomic rename already handles.
 */
export class LazyIndexRefresher {
  private inFlight: Promise<void> | undefined
  private lastOutcome: RefreshOutcome = IDLE

  /**
   * @param deps - the root, threshold, index runner, and optional clock/logger.
   */
  constructor(private readonly deps: LazyRefreshDeps) {}

  /**
   * Make sure the index is fresh enough for one query, running an incremental index when needed.
   *
   * Never rejects: a refresh is an optimisation, and a failed one must leave the query free to
   * answer from the existing index. The returned outcome says whether this call refreshed and
   * whether the answer may be stale, which the renderer turns into one line of text.
   * @param signal - the query's cancellation signal, forwarded to the index run.
   * @returns what this call did.
   */
  async ensureFresh(signal?: AbortSignal): Promise<RefreshOutcome> {
    if (this.deps.freshnessThresholdMs <= 0) {
      this.lastOutcome = IDLE
      return IDLE
    }
    // A parallel call joins the run already in flight instead of starting a second one. It waits,
    // because the index it would otherwise read is the one being replaced right now.
    if (this.inFlight !== undefined) {
      await this.inFlight
      return this.lastOutcome
    }
    if (!this.shouldRefresh()) {
      this.lastOutcome = IDLE
      return IDLE
    }
    const run = this.refreshOnce(signal)
    this.inFlight = run
    try {
      await run
    } finally {
      this.inFlight = undefined
    }
    return this.lastOutcome
  }

  /**
   * Whether the sidecar places the index past the threshold.
   *
   * A missing sidecar beside an existing index means a run that predates the summary (or one whose
   * summary was lost), and the only way to learn its age is to refresh it — an incremental run is
   * cheap and self-heals the sidecar. A missing index file is different: building from nothing can
   * take minutes, which the tool's explicit `index` operation owns (and hands to a background job
   * when the index is large enough), so a query
   * leaves it alone and fails with the "no index" guidance instead.
   * @returns true when an incremental run should happen before the query.
   */
  private shouldRefresh(): boolean {
    const { indexRoot, freshnessThresholdMs } = this.deps
    // Without an index file there is nothing to refresh in place. Building one from nothing can take
    // minutes, and that decision belongs to the tool's explicit `index` operation — a query leaves
    // it alone and fails with the "no index" guidance instead.
    if (!existsSync(join(indexRoot, INDEX_RELATIVE_PATH))) return false
    const status = readIndexStatus(indexRoot)
    // An index with no sidecar is a run that predates the summary (or lost it). Its age cannot be
    // read, and the incremental run that answers the question is cheap and writes the sidecar back.
    if (status === undefined) return true
    const now = this.deps.now?.() ?? Date.now()
    return now - status.indexedAt >= freshnessThresholdMs
  }

  /**
   * Run one incremental index, swallowing every failure into the outcome.
   * @param signal - the query's cancellation signal.
   */
  private async refreshOnce(signal?: AbortSignal): Promise<void> {
    const { indexRoot } = this.deps
    try {
      // No `owner` extension on purpose: a job-capable indexer only delegates a run whose caller
      // named an owner, so this is the explicit request for a synchronous report.
      const result = await this.deps.index({ force: false }, signal)
      if (!isCompletedReport(result)) {
        // The indexer still handed the run to a background job: waiting would outlive this query,
        // and starting another would only duplicate it. Answer from the index as it stands; the job
        // will make the next call fresh.
        this.lastOutcome = { refreshed: false, stale: true }
        return
      }
      this.lastOutcome = { refreshed: true, stale: false }
    } catch (error) {
      this.lastOutcome = { refreshed: false, stale: true }
      // A cancelled query is not a failed refresh: the caller is gone, so a log line would only
      // report an abort as a defect.
      if (signal?.aborted === true) return
      // One line, once per failed attempt: the model still gets its answer, and a human reading the
      // log learns why the result may be behind. The default sink is `console.error`; a test (or a
      // host that routes tool diagnostics elsewhere) can replace it.
      const log = this.deps.logError ?? logToConsole
      log(
        `sessiongraph: incremental refresh of ${indexRoot} failed; answering from the existing index: ${describe(error)}`,
      )
    }
  }
}

/**
 * Whether a seam answer is a finished index report rather than a report about a delegated run.
 *
 * A job-capable indexer answers a delegated run with a full report shape plus a `jobId` (the seam's
 * return type cannot express the distinction), so the discriminator is the presence of that id — not
 * the report's other fields, which describe the index as it stood when the job started. Detected
 * structurally on purpose: this package depends on the seam, never on a particular indexer.
 * @param value - whatever `ctx.sessiongraph.index` resolved with.
 * @returns true when this call itself finished the work.
 */
function isCompletedReport(value: unknown): value is SessiongraphIndexReport {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (typeof record['jobId'] === 'string') return false
  return typeof record['indexPath'] === 'string'
    && typeof record['added'] === 'number'
    && typeof record['sessions'] === 'number'
}

/**
 * One line describing a thrown value, without a stack.
 * @param error - whatever the indexer threw.
 * @returns the message when there is one, else the string form.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The default sink for a failed refresh: one line on stderr, never a stack. A refresh failure is a
 * degraded state, not a query failure, so it must not look like a crash.
 * @param message - the already-composed diagnostic line.
 */
function logToConsole(message: string): void {
  console.error(message)
}
