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

/**
 * Every query operation the seam answers.
 *
 * `event` and `trace` were added when the model-facing surface collapsed from two tools into one:
 * the built-in session tools could read a single unabridged event and follow replacement/citation
 * relationships, and a replacement that dropped those answers would be a downgrade rather than a
 * swap. An index run is deliberately **not** here — it writes, so the tool routes it through
 * `Sessiongraph.index()` instead of pretending a query provider can build an index.
 */
export const SESSIONGRAPH_OPERATIONS = ['search', 'session', 'event', 'trace', 'timeline', 'workspaces', 'status'] as const

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

/**
 * Which agent harness wrote a session log.
 *
 * `dsh` is this host's own store under `~/.dsh/sessions`; `codex` is OpenAI Codex's rollout log
 * under `~/.codex`. The value is stored per session, not per index, because one index deliberately
 * holds both and a hit that cannot say where it came from makes a caller read the wrong file. It is
 * a closed set rather than a free-form string: an unknown origin is a bug in the indexer, and
 * widening this list is how a new harness becomes queryable.
 */
export const SESSIONGRAPH_SOURCES = ['dsh', 'codex'] as const

/** One session source. */
export type SessiongraphSource = (typeof SESSIONGRAPH_SOURCES)[number]

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
  /**
   * Restrict to sessions one harness wrote.
   *
   * An index holds DSH's own logs and Codex's rollout logs side by side, and the two answer different
   * questions: "what did I ask DSH about this repo" and "what did I ask Codex about it". Absent means
   * every source, which is the right default for a cross-harness sweep.
   */
  source?: SessiongraphSource
  /** Only entries at or after this epoch-millisecond timestamp. */
  after?: number
  /** Only entries at or before this epoch-millisecond timestamp. */
  before?: number
  /** Restrict to these entry kinds. Absent means every kind. */
  kinds?: readonly SessiongraphEntryKind[]
  /**
   * Restrict the search to one session: a full id, or a prefix long enough to identify exactly one.
   *
   * A prefix that matches several sessions raises `SESSIONGRAPH_INVALID_REQUEST` rather than
   * guessing — a search silently answered from the wrong conversation is worse than a refusal. This
   * is what replaces the built-in `session_event_search`, which needed its own tool for it.
   */
  sessionId?: string
  /**
   * Return at most one hit per session (the strongest), default `true`.
   *
   * The built-in cross-session search answered one hit per session, and a caller paging through a
   * verbatim log usually wants breadth across conversations, not ten matches from one. Callers that
   * want every entry (a single-session sweep) turn it off.
   */
  dedupeBySession?: boolean
  /** Maximum hits to return. */
  limit: number
  /** Hits to skip, for paging. */
  offset?: number
}

/** One matched entry, with enough context to recognize it without a second query. */
export interface SessiongraphHit {
  sessionId: SessiongraphSessionId
  /** Which harness wrote the session this hit belongs to. */
  source: SessiongraphSource
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
  /**
   * How many results matched before `limit`/`offset` — counted in the same unit the hits use.
   *
   * With `dedupeBySession` on (the default) that is **sessions**, because the hits are one per
   * session; counting entries there would make `truncated` permanently true and paging incoherent.
   * With it off, it is entries.
   */
  total: number
  /** True when `total` exceeded `limit + offset`, or when a snippet was clipped. */
  truncated: boolean
}

/** A session's metadata, as the timeline and session operations report it. */
export interface SessiongraphSessionSummary {
  sessionId: SessiongraphSessionId
  /** Which harness wrote this session's log. */
  source: SessiongraphSource
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
  /** Restrict to one harness's sessions. Absent means every source. */
  source?: SessiongraphSource
  /** Only sessions whose last event is at or after this epoch-millisecond timestamp. */
  after?: number
  /** Only sessions whose first event is at or before this epoch-millisecond timestamp. */
  before?: number
  /** Maximum sessions to return, newest first. */
  limit: number
  /** Sessions to skip, for paging; follows the timeline's newest-first order. */
  offset?: number
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
  /** Restrict the census to one harness's sessions. Absent means every source. */
  source?: SessiongraphSource
  /** Maximum workspaces to return, most recently active first. */
  limit: number
  /** Workspaces to skip, for paging; follows the most-recently-active-first order. */
  offset?: number
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
  /**
   * Sessions whose source is the synthetic `live://<session-id>` marker rather than a log file:
   * conversations that are still running and have not been written to disk yet. The count drops back
   * to zero once each one ends and is re-indexed from its log. A store that cannot distinguish live
   * sources omits the field; one that can always reports a number, `0` when every session is on disk.
   */
  liveSessions?: number
  /** Searchable entries in the index. */
  entries: number
  /** Distinct workspaces in the index. */
  workspaces: number
  /** Epoch milliseconds of the last successful index run, or undefined when never run. */
  indexedAt: number | undefined
  /** Bytes the index file occupies on disk. */
  bytes: number
}

/**
 * One raw event, reduced to the fields that let a reader orient around a target.
 *
 * The window around an event is answered as summaries rather than full payloads: a caller asking
 * "what came before this" wants the shape of the conversation, not megabytes of tool output.
 */
export interface SessiongraphRawEventSummary {
  /** Event sequence number inside its session. */
  seq: number
  /** Event timestamp, epoch milliseconds. */
  time: number
  /** Event type as the log records it (`tool/call`, `assistant/message`, …). */
  type: string
}

/** One event exactly as the session log holds it, with no clipping applied. */
export interface SessiongraphRawEvent {
  /** Event sequence number inside its session. */
  seq: number
  /** Event timestamp, epoch milliseconds. */
  time: number
  /** Event type as the log records it. */
  type: string
  /**
   * The event's own `data` payload, verbatim. Opaque to this seam on purpose: the log's event
   * vocabulary belongs to `dsh-session`, and re-declaring it here would drift.
   */
  data: unknown
}

/**
 * Read one unabridged event, plus an optional window of neighbouring events.
 *
 * This is what replaces the built-in `session_event_read`. It reads the source log directly rather
 * than the index, because the index stores semantic text clipped to a per-entry cap and this answer
 * must be the original bytes.
 */
export interface SessiongraphEventRequest extends SessiongraphRequestBase {
  operation: 'event'
  /** Full session id, or a prefix long enough to identify exactly one session. */
  sessionId: string
  /** Sequence number of the target event. */
  seq: number
  /** Raw events to include immediately before the target. Omitted means none. */
  windowBefore?: number
  /** Raw events to include immediately after the target. Omitted means none. */
  windowAfter?: number
}

/** Answer to an event request. */
export interface SessiongraphEventResult {
  operation: 'event'
  session: SessiongraphSessionSummary
  /** The target event, unabridged. */
  event: SessiongraphRawEvent
  /** Neighbours before the target, oldest first. */
  before: SessiongraphRawEventSummary[]
  /** Neighbours after the target, oldest first. */
  after: SessiongraphRawEventSummary[]
}

/** One node of a recursive descendant tree. */
export interface SessiongraphTraceNode {
  session: SessiongraphSessionSummary
  descendants: SessiongraphTraceNode[]
}

/**
 * Follow session lineage, or one event's replacement and citation relationships.
 *
 * `seq` selects the shape: present means "trace this event", absent means "trace this session".
 * Both live in one operation because they share the only other input (`sessionId`) and because a
 * second tool would cost permanent schema tokens for a question asked rarely.
 */
export interface SessiongraphTraceRequest extends SessiongraphRequestBase {
  operation: 'trace'
  /** Full session id, or a prefix long enough to identify exactly one session. */
  sessionId: string
  /** Given → trace one event inside the session; omitted → trace the session's lineage. */
  seq?: number
  /** Maximum descendant depth to walk. Omitted means the whole tree. */
  depth?: number
}

/** A session's ancestor chain and descendant tree. */
export interface SessiongraphSessionTraceResult {
  operation: 'trace'
  kind: 'session'
  target: SessiongraphSessionSummary
  /** Ancestors, nearest first. */
  ancestors: SessiongraphSessionSummary[]
  descendants: SessiongraphTraceNode[]
  /**
   * False when the walk stopped early — a depth limit was hit, or a parent the index does not hold.
   * A caller must be able to tell "this is the root" from "I gave up looking".
   */
  complete: boolean
}

/** One event's positional replacements and the source events it cites. */
export interface SessiongraphEventTraceResult {
  operation: 'trace'
  kind: 'event'
  session: SessiongraphSessionSummary
  /** The target event, reduced to its identity. */
  event: SessiongraphRawEventSummary
  /** Sequence numbers that replaced this event, following the chain outward. */
  replacedBy: number[]
  /** Sequence numbers this event shadowed. */
  shadowedSeqs: number[]
  /** Sequence numbers this event cites as sources (a tool result citing its call, for instance). */
  sourceEventSeqs: number[]
}

/** Either trace shape, discriminated on `kind`. */
export type SessiongraphTraceResult = SessiongraphSessionTraceResult | SessiongraphEventTraceResult

/** Every request the seam accepts, discriminated on `operation`. */
export type SessiongraphRequest =
  | SessiongraphSearchRequest
  | SessiongraphSessionRequest
  | SessiongraphEventRequest
  | SessiongraphTraceRequest
  | SessiongraphTimelineRequest
  | SessiongraphWorkspacesRequest
  | SessiongraphStatusRequest

/** The result type a given request produces. */
export type SessiongraphResultFor<R extends SessiongraphRequest> = R extends SessiongraphSearchRequest
  ? SessiongraphSearchResult
  : R extends SessiongraphSessionRequest
    ? SessiongraphSessionResult
    : R extends SessiongraphEventRequest
      ? SessiongraphEventResult
      : R extends SessiongraphTraceRequest
        ? SessiongraphTraceResult
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
  | SessiongraphEventResult
  | SessiongraphTraceResult
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
  /**
   * Engine that produced this run's totals: the native Rust kernel or the TypeScript indexer. Absent
   * on reports from a build that predates engine selection.
   */
  engine?: 'native' | 'typescript'
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
