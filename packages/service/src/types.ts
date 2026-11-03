/**
 * The normalized vocabulary of the session-graph seam: what a caller may ask, what a store must
 * answer, and what an indexer must report.
 *
 * Everything here is provider-neutral. A store ranges over one SQLite file today, but nothing in
 * these types says so: `indexRoot` is an opaque directory the store claims, and a future store could
 * serve it from anywhere. The seam therefore never exposes SQL, never exposes a schema version, and
 * never exposes a path to a table — only sessions, entries, and search hits.
 * @module dsh-plugin-sessiongraph-service/types
 */

import type { SessiongraphIndexerId, SessiongraphSessionId, SessiongraphStoreId } from './brand.ts'

/** Every query operation the seam answers. */
export const SESSIONGRAPH_OPERATIONS = ['search', 'session', 'timeline', 'workspaces', 'status'] as const

/** One query operation. */
export type SessiongraphOperation = (typeof SESSIONGRAPH_OPERATIONS)[number]

/**
 * What a searchable entry is, from the reader's point of view.
 *
 * `user` is text a human actually typed; `assistant` is the model's visible reply (never its
 * reasoning); `tool` is a tool invocation (its name and arguments, never the result body); `title`
 * is a session title, kept as its own kind so a title match is recognizable in the hit list.
 */
export const SESSIONGRAPH_ENTRY_KINDS = ['user', 'assistant', 'tool', 'title'] as const

/** One entry kind. */
export type SessiongraphEntryKind = (typeof SESSIONGRAPH_ENTRY_KINDS)[number]

/** Error codes the seam raises, so a consumer can distinguish "no index" from "bad request". */
export type SessiongraphErrorCode =
  | 'SESSIONGRAPH_UNAVAILABLE'
  | 'SESSIONGRAPH_CONFLICT'
  | 'SESSIONGRAPH_INVALID_PROVIDER'
  | 'SESSIONGRAPH_INVALID_REQUEST'
  | 'SESSIONGRAPH_NOT_FOUND'
  | 'SESSIONGRAPH_CORRUPT'
  | 'SESSIONGRAPH_IO'

/** The single error type crossing the seam. */
export class SessiongraphError extends Error {
  /**
   * @param message - human-readable diagnosis.
   * @param code - machine-readable category.
   */
  constructor(
    message: string,
    readonly code: SessiongraphErrorCode,
  ) {
    super(message)
    this.name = 'SessiongraphError'
  }
}

/** Fields every query request carries. */
export interface SessiongraphRequestBase {
  /** Directory holding the index this request targets. The seam routes on it; a store claims it. */
  indexRoot: string
}

/** Full-text search across indexed conversation history. */
export interface SessiongraphSearchRequest extends SessiongraphRequestBase {
  operation: 'search'
  /** Query text. Chinese is matched by character bigram, so a two-character term works. */
  query: string
  /** Restrict to one workspace (exact `cwd`), or a path prefix when it ends without a trailing slash. */
  workspace?: string
  /** Only entries at or after this epoch-millisecond timestamp. */
  after?: number
  /** Only entries at or before this epoch-millisecond timestamp. */
  before?: number
  /** Restrict to these entry kinds. Absent means every kind. */
  kinds?: readonly SessiongraphEntryKind[]
  /** Maximum hits to return. */
  limit: number
  /** Hits to skip, for paging. */
  offset?: number
}

/** One matched entry, with enough context to recognize it without a second query. */
export interface SessiongraphHit {
  sessionId: SessiongraphSessionId
  /** Session title, when the session ever produced one. */
  title: string | undefined
  /** The session's working directory. */
  workspace: string
  /** Entry timestamp, epoch milliseconds. */
  time: number
  /** What matched. */
  kind: SessiongraphEntryKind
  /** Event sequence number inside the session. */
  seq: number
  /** Turn number inside the session, when the entry belongs to a turn. */
  turn: number | undefined
  /** Matched text with the matched span wrapped in `[` `]`, truncated around the first match. */
  snippet: string
  /** Total characters in the indexed entry, so a caller can tell a clip from the whole. */
  length: number
}

/** Answer to a search request. */
export interface SessiongraphSearchResult {
  operation: 'search'
  hits: SessiongraphHit[]
  /** Total entries matching the query across the whole store, before `limit`/`offset`. */
  total: number
  /** True when `total` exceeded `limit + offset`, or when a snippet was clipped. */
  truncated: boolean
}

/** A session's metadata, as the timeline and session operations report it. */
export interface SessiongraphSessionSummary {
  sessionId: SessiongraphSessionId
  title: string | undefined
  workspace: string
  /** Epoch milliseconds of the session's first event. */
  createdAt: number
  /** Epoch milliseconds of the session's last event. */
  lastAt: number
  /** Number of turns the session contains. */
  turns: number
  /** Number of indexed entries the session contributes. */
  entries: number
  /** Parent session id, when this session was delegated from another. */
  parentSession: string | undefined
  /** Session origin label (`user`, `subagent`, …), when the log records one. */
  origin: string | undefined
  /** Agent preset the session ran under, when recorded. */
  agentPreset: string | undefined
}

/** One indexed entry, as the session operation reports it. */
export interface SessiongraphEntry {
  seq: number
  time: number
  kind: SessiongraphEntryKind
  turn: number | undefined
  /** Entry text, already bounded by the indexer's per-entry cap. */
  text: string
  /** True when the indexer stored a clipped prefix instead of the whole entry. */
  clipped: boolean
}

/** Read one session, by full id or by an unambiguous prefix. */
export interface SessiongraphSessionRequest extends SessiongraphRequestBase {
  operation: 'session'
  /** Full session id, or a prefix long enough to identify exactly one session. */
  sessionId: string
  /** Maximum entries to return. */
  limit: number
  /** Entries to skip, for paging; follows the session's own chronological order. */
  offset?: number
}

/** Answer to a session request. */
export interface SessiongraphSessionResult {
  operation: 'session'
  session: SessiongraphSessionSummary
  entries: SessiongraphEntry[]
  /** Sessions delegated from this one, oldest first. */
  children: SessiongraphSessionId[]
  /** True when the session holds more entries than `limit + offset`. */
  truncated: boolean
}

/** List sessions by time. */
export interface SessiongraphTimelineRequest extends SessiongraphRequestBase {
  operation: 'timeline'
  /** Restrict to one workspace, or a path prefix when it ends without a trailing slash. */
  workspace?: string
  /** Only sessions whose last event is at or after this epoch-millisecond timestamp. */
  after?: number
  /** Only sessions whose first event is at or before this epoch-millisecond timestamp. */
  before?: number
  /** Maximum sessions to return, newest first. */
  limit: number
}

/** Answer to a timeline request. */
export interface SessiongraphTimelineResult {
  operation: 'timeline'
  sessions: SessiongraphSessionSummary[]
  /** True when more sessions match than were returned. */
  truncated: boolean
}

/** Enumerate the workspaces the index covers. */
export interface SessiongraphWorkspacesRequest extends SessiongraphRequestBase {
  operation: 'workspaces'
  /** Maximum workspaces to return, most recently active first. */
  limit: number
}

/** One workspace's coverage. */
export interface SessiongraphWorkspaceStat {
  workspace: string
  sessions: number
  entries: number
  /** Epoch milliseconds of the oldest session in this workspace. */
  firstAt: number
  /** Epoch milliseconds of the newest session in this workspace. */
  lastAt: number
}

/** Answer to a workspaces request. */
export interface SessiongraphWorkspacesResult {
  operation: 'workspaces'
  workspaces: SessiongraphWorkspaceStat[]
  /** Total workspaces in the index, before `limit`. */
  total: number
}

/** Report the index's own state. Unlike every other operation, this one answers even when no index exists. */
export interface SessiongraphStatusRequest extends SessiongraphRequestBase {
  operation: 'status'
}

/** Answer to a status request. */
export interface SessiongraphStatusResult {
  operation: 'status'
  /** False when `indexRoot` holds no index at all; every other field is then zero/empty. */
  indexed: boolean
  /** Absolute path of the index file, for a caller that wants to inspect it directly. */
  indexPath: string
  /** Sessions in the index. */
  sessions: number
  /** Searchable entries in the index. */
  entries: number
  /** Distinct workspaces in the index. */
  workspaces: number
  /** Epoch milliseconds of the last successful index run, or undefined when never run. */
  indexedAt: number | undefined
  /** Bytes the index file occupies on disk. */
  bytes: number
}

/** Every request the seam accepts, discriminated on `operation`. */
export type SessiongraphRequest =
  | SessiongraphSearchRequest
  | SessiongraphSessionRequest
  | SessiongraphTimelineRequest
  | SessiongraphWorkspacesRequest
  | SessiongraphStatusRequest

/** The result type a given request produces. */
export type SessiongraphResultFor<R extends SessiongraphRequest> = R extends SessiongraphSearchRequest
  ? SessiongraphSearchResult
  : R extends SessiongraphSessionRequest
    ? SessiongraphSessionResult
    : R extends SessiongraphTimelineRequest
      ? SessiongraphTimelineResult
      : R extends SessiongraphWorkspacesRequest
        ? SessiongraphWorkspacesResult
        : R extends SessiongraphStatusRequest
          ? SessiongraphStatusResult
          : never

/** Every result the seam produces. */
export type SessiongraphResult =
  | SessiongraphSearchResult
  | SessiongraphSessionResult
  | SessiongraphTimelineResult
  | SessiongraphWorkspacesResult
  | SessiongraphStatusResult

/**
 * A read provider: answers queries from an index it claims.
 *
 * `indexes` is asked for every registered store on every query, so it must be cheap (a stat, not a
 * full open). Returning `false` is how a store declines a root it does not serve; a store never
 * silently answers for a root it did not claim.
 */
export interface SessiongraphStoreProvider {
  /** Stable identity, unique among registered stores. */
  readonly id: SessiongraphStoreId
  /**
   * Whether this store can answer for `indexRoot`.
   * @param indexRoot - directory the caller targeted.
   * @param signal - aborts the check.
   */
  indexes(indexRoot: string, signal?: AbortSignal): Promise<boolean>
  /**
   * Answer one query. The request's `operation` selects the shape; a store must answer every
   * operation it can, and raise {@link SessiongraphError} rather than guess.
   * @param request - the normalized request.
   * @param signal - aborts the query.
   */
  query<R extends SessiongraphRequest>(request: R, signal?: AbortSignal): Promise<SessiongraphResultFor<R>>
}

/** Options an indexer accepts for one run. */
export interface SessiongraphIndexOptions {
  /**
   * Rebuild every session from scratch. Without it a run skips sessions whose source file is
   * unchanged since the last run.
   */
  force?: boolean
  /** Index only sessions whose `cwd` matches this workspace (exact, or a prefix without a trailing slash). */
  workspace?: string
  /** Index only one session, by full id or unambiguous prefix. */
  sessionId?: string
}

/** What one index run did. */
export interface SessiongraphIndexReport {
  /** Absolute path of the index the run wrote. */
  indexPath: string
  /** Sessions added since the previous run. */
  added: number
  /** Sessions whose source changed and were re-written. */
  updated: number
  /** Sessions skipped because their source was unchanged. */
  skipped: number
  /** Sessions dropped because their source file disappeared. */
  removed: number
  /**
   * Sessions rebuilt from the host's live (still-running) view this run. They belong to no source
   * file yet, are replayed in full on every run rather than compared by version, and are therefore
   * not counted in `added`/`updated`/`skipped`.
   */
  liveSessions?: number
  /** Live sessions left out because they exceeded the indexer's configured cap. */
  liveSkipped?: number
  /** Sessions discovered in total across all source roots. */
  discovered: number
  /** Sessions that failed to parse, with a bounded reason. */
  failed: { path: string; reason: string }[]
  /** Searchable entries written. */
  entries: number
  /** Sessions in the index after the run. */
  sessions: number
  /** Distinct workspaces in the index after the run. */
  workspaces: number
  /** Bytes the index occupies after the run. */
  bytes: number
  /** Wall-clock duration of the run, milliseconds. */
  elapsedMs: number
}

/**
 * A write provider: parses session logs and builds the index a store reads.
 *
 * Indexing is never triggered from {@link SessiongraphService.query}. It is a caller-initiated,
 * potentially slow operation on its own timeout budget.
 */
export interface SessiongraphIndexer {
  /** Stable identity, unique among registered indexers. */
  readonly id: SessiongraphIndexerId
  /**
   * Whether this indexer can build an index under `indexRoot`.
   * @param indexRoot - directory the caller targeted.
   * @param signal - aborts the check.
   */
  canIndex(indexRoot: string, signal?: AbortSignal): Promise<boolean>
  /**
   * Build or refresh the index.
   * @param indexRoot - directory to write into.
   * @param options - scope and rebuild switches.
   * @param signal - aborts the run; a store must leave the previous index readable.
   */
  index(indexRoot: string, options: SessiongraphIndexOptions, signal?: AbortSignal): Promise<SessiongraphIndexReport>
}

/** The facade `ctx.sessiongraph` publishes. */
export interface SessiongraphService {
  /**
   * Register a read provider.
   * @param provider - the store to publish.
   * @returns a disposer that unregisters it.
   */
  registerStore(provider: SessiongraphStoreProvider): () => void
  /**
   * Register a write provider.
   * @param provider - the indexer to publish.
   * @returns a disposer that unregisters it.
   */
  registerIndexer(provider: SessiongraphIndexer): () => void
  /**
   * Whether any store can answer for `indexRoot`.
   * @param indexRoot - directory to test.
   * @param signal - aborts the check.
   */
  available(indexRoot: string, signal?: AbortSignal): Promise<boolean>
  /**
   * Answer one query through the single store claiming the request's `indexRoot`.
   * @param request - the normalized request.
   * @param signal - aborts the query.
   */
  query<R extends SessiongraphRequest>(request: R, signal?: AbortSignal): Promise<SessiongraphResultFor<R>>
  /**
   * Run the single indexer claiming `indexRoot`.
   * @param indexRoot - directory to build into.
   * @param options - scope and rebuild switches.
   * @param signal - aborts the run.
   */
  index(indexRoot: string, options?: SessiongraphIndexOptions, signal?: AbortSignal): Promise<SessiongraphIndexReport>
}
