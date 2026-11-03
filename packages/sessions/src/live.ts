/**
 * Index the sessions the host still holds in memory.
 *
 * A session log is written when the session ends (or is checkpointed), so the conversation running
 * right now is invisible to a file scan: asking "where did I say X" mid-session would miss the very
 * words just typed. The host's `ctx.sessionQuery` can list live sessions and replay their event log,
 * which is the one thing a file scanner cannot see.
 *
 * This is a **supplement**, never a second path over the same data: file scanning, multi-frame
 * decompression and mtime-based incrementality stay the primary source, and this module only adds
 * the handful of sessions that are still moving. The host interface is declared structurally rather
 * than imported from a `@deepseek-ai/dsh-*` package — a host utility that exists in one DSH line and
 * not another turns into a load-time failure that removes the whole plugin.
 * @module dsh-plugin-sessiongraph-sessions/live
 */

import { parseSessionEvents } from './parse.ts'
import type { SessionParseLimits } from './parse.ts'
import type { IndexedSession } from './write.ts'

/**
 * Prefix of the synthetic source path a live session is recorded under. It is not a filesystem
 * path: the row is rebuilt from the in-memory log on every run, and the marker is what lets the
 * file scanner tell those rows apart from ones a vanished log should remove.
 */
export const LIVE_SOURCE_PREFIX = 'live://'

/**
 * The slice of the host's `sessionQuery` service this indexer uses.
 *
 * `listSessions` answers metadata only; `readSession` replays one session's event log, returning the
 * header, the count of events inherited from a parent context, and the events themselves — the same
 * shape the on-disk JSONL carries after its header line.
 */
export interface SessionQueryService {
  /**
   * List every session the host knows about, newest first, with a `live` flag on the in-memory ones.
   * @returns one entry per session.
   */
  listSessions(): Promise<readonly unknown[]>
  /**
   * Read one session's header and full event log.
   * @param sessionId - the session to replay.
   * @returns the session record, as the host assembles it.
   */
  readSession(sessionId: string): Promise<unknown>
}

/** One live session selected for indexing, before its log is replayed. */
interface LiveCandidate {
  readonly id: string
  readonly cwd: string
}

/** Bounds and filters the live pass shares with the file pass. */
export interface LiveIndexOptions {
  /** Most live sessions to rebuild in one run; the rest are reported as skipped. */
  readonly maxLiveSessions: number
  /** Entry-text bounds, identical to the file path's. */
  readonly limits: SessionParseLimits
  /**
   * Whether a session is in the run's scope. The same predicate the file path applies, so a scoped
   * index covers a live session and its later file under exactly the same rules.
   */
  readonly inScope: (workspace: string, sessionId: string) => boolean
}

/** What the live pass collected. */
export interface LiveIndexResult {
  /** Sessions to (re)write, already parsed. */
  readonly sessions: IndexedSession[]
  /** Live sessions left out because of {@link LiveIndexOptions.maxLiveSessions}. */
  readonly skipped: number
}

/**
 * Collect and parse the live sessions in scope.
 *
 * A live session has no stable version — its log grows with every step — so it is replayed in full
 * on every run rather than compared against a recorded mtime. That is cheap only because there are
 * normally one or two of them, which is why the cap exists: a host that reports dozens of live
 * sessions must not turn one index run into dozens of log replays.
 * @param query - the host's session-query service.
 * @param options - the cap, entry bounds, and scope predicate.
 * @returns the parsed sessions to write, and how many the cap left out.
 */
export async function collectLiveSessions(
  query: SessionQueryService,
  options: LiveIndexOptions,
): Promise<LiveIndexResult> {
  const listed = await query.listSessions()
  const candidates: LiveCandidate[] = []
  for (const entry of listed) {
    const record = asRecord(entry)
    if (record === undefined || record.live !== true) continue
    const header = asRecord(record.header)
    const id = stringField(header, 'id')
    if (id === undefined || id === '') continue
    const cwd = stringField(header, 'cwd') ?? ''
    if (!options.inScope(cwd, id)) continue
    candidates.push({ id, cwd })
  }

  // `listSessions` is documented newest-first; taking from the front keeps the most recent
  // conversations searchable when a host reports more live sessions than the cap allows.
  const chosen = candidates.slice(0, options.maxLiveSessions)
  const skipped = candidates.length - chosen.length

  const sessions: IndexedSession[] = []
  for (const candidate of chosen) {
    const record = asRecord(await query.readSession(candidate.id))
    const events = Array.isArray(record?.events) ? record.events : []
    const session = parseSessionEvents(record?.session, events, candidate.id, options.limits)
    sessions.push({
      session,
      sourcePath: liveSourcePath(candidate.id),
      // No version to compare: the live row is rebuilt every run, never skipped.
      mtime: 0,
      size: 0,
    })
  }
  return { sessions, skipped }
}

/**
 * The synthetic source path a live session is recorded under.
 * @param sessionId - the session id.
 * @returns the marker path.
 */
export function liveSourcePath(sessionId: string): string {
  return `${LIVE_SOURCE_PREFIX}${sessionId}`
}

/**
 * Narrow a value to a plain object.
 * @param value - candidate.
 * @returns the object, or undefined.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * Read a string field from a record.
 * @param record - the record, possibly absent.
 * @param key - field name.
 * @returns the string, or undefined when the field is absent or not a string.
 */
function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' ? value : undefined
}
