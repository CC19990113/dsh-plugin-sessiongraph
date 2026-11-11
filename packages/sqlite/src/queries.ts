/**
 * The seven seam operations against one open index database. Every function here is synchronous:
 * `node:sqlite` is a synchronous binding, so a query either completes within one turn or throws, and
 * the store's async surface exists for the seam's contract rather than for I/O interleaving.
 *
 * `event` and `trace` are the two operations that leave the index and read a session's source log:
 * the index stores *semantic text*, clipped to a per-entry cap and only for the entry kinds a search
 * can match, while an event read must return the original log line — including the events the index
 * never stores. Everything else here answers from `index.db` alone.
 *
 * User-supplied strings never reach a statement as SQL text. Every filter is a `?` binding; the only
 * text shaped from input is a `LIKE` pattern, and its wildcard characters are escaped so a workspace
 * path containing `%` or `_` still matches literally.
 * @module dsh-plugin-sessiongraph-sqlite/queries
 */

import { statSync } from 'node:fs'
import { isAbsolute, normalize, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  META_INDEXED_AT,
  SessiongraphError,
  SessiongraphSessionId,
  highlightTerms,
  matchExpression,
} from 'dsh-plugin-sessiongraph-service'
import type {
  SessiongraphEntry,
  SessiongraphEntryKind,
  SessiongraphEventRequest,
  SessiongraphEventResult,
  SessiongraphEventTraceResult,
  SessiongraphHit,
  SessiongraphSearchRequest,
  SessiongraphSearchResult,
  SessiongraphSessionRequest,
  SessiongraphSessionResult,
  SessiongraphSessionSummary,
  SessiongraphSessionTraceResult,
  SessiongraphStatusResult,
  SessiongraphTimelineRequest,
  SessiongraphTimelineResult,
  SessiongraphTouchedEntry,
  SessiongraphTouchedRequest,
  SessiongraphTouchedResult,
  SessiongraphTraceNode,
  SessiongraphTraceRequest,
  SessiongraphTraceResult,
  SessiongraphWorkspaceStat,
  SessiongraphWorkspacesRequest,
  SessiongraphWorkspacesResult,
} from 'dsh-plugin-sessiongraph-service'
import { isLiveSource, rawEventWindow, readRawEvents, traceRawEvent } from 'dsh-plugin-sessiongraph-sessions'
import type { RawSessionLog } from 'dsh-plugin-sessiongraph-sessions'
import { databasePath } from './database.ts'
import type { IndexPool } from './database.ts'
import type { IndexRow } from './rows.ts'
import {
  toEntry,
  toHitSubject,
  toRawEvent,
  toRawEventSummary,
  toSessionSummary,
  toWorkspaceStat,
} from './rows.ts'

/** Every `session` column the summary projection reads. */
const SESSION_COLUMNS = [
  'id',
  'source',
  'workspace',
  'title',
  'created_at',
  'last_at',
  'parent_session',
  'origin',
  'agent_preset',
  'turns',
  'entries',
].join(', ')

/** The one `entry` row shape every query below selects, so the projection never drifts by query. */
const ENTRY_COLUMNS = 'seq, time, kind, turn, text, clipped'

/**
 * The same projection, qualified with the `s` alias. A lineage CTE also carries `id`/`parent_session`,
 * so an unqualified projection would be ambiguous there.
 */
const SESSION_COLUMNS_S = [
  'id',
  'source',
  'workspace',
  'title',
  'created_at',
  'last_at',
  'parent_session',
  'origin',
  'agent_preset',
  'turns',
  'entries',
]
  .map(column => `s.${column} AS ${column}`)
  .join(', ')

/**
 * `source_path` prefix the indexer writes for a conversation that is still running, before its log
 * exists on disk. Spelled out here as a predicate instead of imported: it is a value shared through
 * the on-disk format, not through code. A session ends and is re-indexed from a real path, at which
 * point its row no longer matches.
 */
const LIVE_SOURCE_LIKE = 'live://%'

/**
 * Ranking weight per entry kind, **divided** into the FTS5 `bm25` score.
 *
 * FTS5's `bm25` is negative and *more* negative means a better match, so the weight is a penalty: a
 * larger weight pushes that kind further down the list. Dividing — never multiplying — is the whole
 * point. `bm25 * 1.5` would make a `tool` hit *better*, which is the opposite of what this table
 * means: on a real index it turned every top-20 result for 广告 into a tool call. With `bm25 / 1.5`
 * the order is the one the table reads as: a human's message (`user`, 1.0) outranks everything, a
 * title slightly less, a reply less again, and a tool invocation last.
 *
 * The table is deliberately shared vocabulary with the native kernel. Both engines must rank one
 * query the same way, or a machine that has the Rust build would answer differently from one that
 * does not — the kernel's task carries the same numbers and the same division.
 */
const KIND_WEIGHTS: Readonly<Record<SessiongraphEntryKind, number>> = {
  user: 1.0,
  title: 1.1,
  assistant: 1.2,
  tool: 1.5,
}

/** The one `entry` projection a search hit needs, shared by the deduped and plain queries. */
const HIT_COLUMNS = `e.session_id AS session_id, s.source AS source, s.title AS title, s.workspace AS workspace,
       e.time AS time, e.kind AS kind, e.seq AS seq, e.turn AS turn, e.text AS text`

/**
 * Ceiling on one session-lineage walk, in levels.
 *
 * `depth` is caller-controlled and the log is not trusted to be acyclic, so the recursive CTE needs a
 * bound of its own. 64 is far beyond any real delegation tree (the harness nests a handful of
 * levels); the number exists to terminate, not to limit.
 */
const MAX_LINEAGE_DEPTH = 64

/**
 * Render the kind-penalty `CASE` for one column.
 *
 * The kinds and weights come from {@link KIND_WEIGHTS}, a closed compile-time table, so this is not
 * user input reaching a statement — no caller string can appear here.
 * @param column - the already-trusted SQL column holding an entry kind.
 * @returns a `CASE` expression yielding that kind's weight, to divide a negative `bm25` by.
 */
function weightExpression(column: string): string {
  const arms = Object.entries(KIND_WEIGHTS)
    .map(([kind, weight]) => `WHEN '${kind}' THEN ${weight.toFixed(1)}`)
    .join(' ')
  return `CASE ${column} ${arms} ELSE 1.0 END`
}

/** Run a statement and return its rows already typed as raw records. */
function rows(db: DatabaseSync, sql: string, params: readonly unknown[] = []): IndexRow[] {
  return db.prepare(sql).all(...(params as never[]))
}

/** Read a `count(*) AS total` aggregate; an empty table yields 0, not undefined. */
function count(db: DatabaseSync, sql: string, params: readonly unknown[] = []): number {
  const row = db.prepare(sql).get(...(params as never[])) as IndexRow | undefined
  const value = row?.['total']
  return typeof value === 'number' ? value : 0
}

/**
 * Coerce a request bound into a non-negative integer. A caller-supplied `limit`/`offset` is not
 * trusted to be well formed — `LIMIT -1` would mean "no limit" in SQLite, which is exactly the
 * unbounded answer the seam's `limit` exists to prevent.
 * @param value - the requested bound.
 * @returns the bound as a non-negative integer.
 */
function bound(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

/** Escape the wildcard characters in a string that becomes a `LIKE` pattern. */
function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

/**
 * Build the workspace predicate for one side of a query.
 *
 * A path that ends with `/` is a PREFIX filter ("everything under this directory"); any other value
 * is an exact `cwd` match. That distinction is the wrong way round from most APIs, and it is
 * deliberate: a caller filtering on an exact workspace usually has the exact path already, while a
 * prefix filter is the one that needs a marker to say "this is not a full path".
 * @param column - the already-trusted SQL column reference (`s.workspace`).
 * @param workspace - the requested workspace filter.
 * @returns the clause and its bindings, or undefined when the filter is absent.
 */
function workspaceClause(
  column: string,
  workspace: string | undefined,
): { clause: string; params: unknown[] } | undefined {
  if (workspace === undefined || workspace === '') return undefined
  if (workspace.endsWith('/')) {
    return { clause: `${column} LIKE ? ESCAPE '\\'`, params: [`${escapeLike(workspace)}%`] }
  }
  return { clause: `${column} = ?`, params: [workspace] }
}

/** One character span in a string, used to bracket matched terms. */
interface Span {
  readonly start: number
  readonly end: number
}

/** Escape a literal string for `RegExp`, so a query token is never read as a pattern. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Every case-insensitive occurrence of one term in one string. Case folding is done by the regex
 * engine rather than by lowercasing the text: lowercasing can change a string's length, and the
 * indices here are used to slice the ORIGINAL text.
 * @param haystack - text to search.
 * @param term - literal term to find.
 * @returns non-overlapping spans in document order.
 */
function findSpans(haystack: string, term: string): Span[] {
  if (term === '') return []
  const spans: Span[] = []
  for (const match of haystack.matchAll(new RegExp(escapeRegExp(term), 'gi'))) {
    const start = match.index ?? 0
    spans.push({ start, end: start + match[0].length })
  }
  return spans
}

/**
 * Sort spans and merge the ones that touch, so adjacent matched terms render as one bracketed run
 * (`[广告SDK]`) instead of a run of abutting brackets.
 * @param spans - unmerged spans.
 * @returns merged, ordered, non-overlapping spans.
 */
function mergeSpans(spans: readonly Span[]): Span[] {
  const ordered = [...spans].sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: Span[] = []
  for (const span of ordered) {
    const last = merged[merged.length - 1]
    if (last !== undefined && span.start <= last.end) {
      if (span.end > last.end) merged[merged.length - 1] = { start: last.start, end: span.end }
      continue
    }
    merged.push(span)
  }
  return merged
}

/**
 * The span the snippet window centres on: the longest query token that actually occurs in the entry,
 * at its first occurrence. `highlightTerms` returns tokens longest-first, so the first term with a
 * match is that longest term.
 * @param text - the indexed entry text.
 * @param terms - highlight terms, longest first.
 * @returns the anchor span, or undefined when no term occurs literally.
 */
function anchorSpan(text: string, terms: readonly string[]): Span | undefined {
  for (const term of terms) {
    const [first] = findSpans(text, term)
    if (first !== undefined) return first
  }
  return undefined
}

/**
 * Cut a bounded excerpt around the first match and bracket every matched term inside it.
 *
 * The excerpt itself is at most `maxChars`; the brackets are added afterwards (and are not counted
 * against the cap, so they never shorten what the caller sees). `clipped` reports that the excerpt
 * is a window onto a longer entry, which is what the result's `truncated` flag needs to know.
 * @param text - the full indexed entry text.
 * @param terms - highlight terms, longest first.
 * @param maxChars - largest excerpt length, in code units.
 * @returns the rendered snippet and whether it was clipped.
 */
function renderSnippet(
  text: string,
  terms: readonly string[],
  maxChars: number,
): { snippet: string; clipped: boolean } {
  const cap = Math.max(1, Math.floor(maxChars))
  const anchor = anchorSpan(text, terms)
  const anchorLength = anchor === undefined ? 0 : anchor.end - anchor.start
  // Centre the window on the match, then pull it back inside the string; both clamps matter when the
  // match is near either edge.
  let start = anchor === undefined ? 0 : anchor.start - Math.floor((cap - Math.min(anchorLength, cap)) / 2)
  start = Math.max(0, Math.min(start, Math.max(0, text.length - cap)))
  let end = Math.min(text.length, start + cap)
  // A match longer than the cap (a long Latin token) cannot fit whole: show its start rather than a
  // tail slice the caller would not connect to the query.
  if (anchor !== undefined && anchor.end > end) {
    start = anchor.start
    end = Math.min(text.length, anchor.start + cap)
  }
  const excerpt = text.slice(start, end)
  const spans = mergeSpans(terms.flatMap(term => findSpans(excerpt, term)))
  let snippet = ''
  let cursor = 0
  for (const span of spans) {
    snippet += `${excerpt.slice(cursor, span.start)}[${excerpt.slice(span.start, span.end)}]`
    cursor = span.end
  }
  snippet += excerpt.slice(cursor)
  return { snippet, clipped: start > 0 || end < text.length }
}

/**
 * Full-text search across indexed history.
 *
 * Ordering is the kind-penalized `bm25` score (`bm25 / weight`), then newest, then entry id. `bm25` is chosen over plain
 * recency because a search result list is read top-down and the caller wants the best match first,
 * not merely the most recent one. Ranking alone is NOT a total order: equally scored rows (extremely
 * common for short entries and bigram queries) come back in whatever order the scan produced, which
 * would make `LIMIT`/`OFFSET` paging skip and duplicate rows between pages. Appending
 * `time DESC, entry_id ASC` supplies a deterministic total order without displacing relevance, since
 * `entry.id` is unique and breaks every remaining tie.
 *
 * `dedupeBySession` (default true) keeps the single strongest entry per session, which is the shape
 * of the question "which conversation did I talk about this in". When it is on, `total` counts the
 * sessions that matched rather than the entries: a total counted over a set the page cannot page
 * through would make `truncated` permanently true and paging incoherent.
 * @param db - the open index connection.
 * @param request - the search query.
 * @param maxSnippetChars - largest excerpt the plugin will render per hit.
 * @returns the page of hits, the pre-pagination total, and whether anything was cut.
 */
export function search(
  db: DatabaseSync,
  request: SessiongraphSearchRequest,
  maxSnippetChars: number,
): SessiongraphSearchResult {
  const match = matchExpression(request.query)
  // A query with no searchable token cannot match anything, and `entry_fts MATCH ''` is a syntax
  // error rather than "zero rows"; the empty answer is the honest one.
  if (match === undefined) return { operation: 'search', hits: [], total: 0, truncated: false }
  // An explicitly empty `kinds` list means "none of them", not "no filter": SQL `IN ()` is a syntax
  // error, so the empty answer is also the only correct one.
  if (request.kinds !== undefined && request.kinds.length === 0) {
    return { operation: 'search', hits: [], total: 0, truncated: false }
  }

  const filters = ['entry_fts MATCH ?']
  const params: unknown[] = [match]
  if (request.sessionId !== undefined) {
    // Resolving here (rather than trusting the caller's string) is what turns a prefix into the one
    // session it names, and what refuses a prefix that names several.
    filters.push('e.session_id = ?')
    params.push(resolveSearchedSession(db, request.sessionId))
  }
  if (request.kinds !== undefined) {
    filters.push(`e.kind IN (${request.kinds.map(() => '?').join(', ')})`)
    params.push(...request.kinds)
  }
  const workspace = workspaceClause('s.workspace', request.workspace)
  if (workspace !== undefined) {
    filters.push(workspace.clause)
    params.push(...workspace.params)
  }
  if (request.source !== undefined) {
    filters.push('s.source = ?')
    params.push(request.source)
  }
  if (request.after !== undefined) {
    filters.push('e.time >= ?')
    params.push(request.after)
  }
  if (request.before !== undefined) {
    filters.push('e.time <= ?')
    params.push(request.before)
  }
  const from = `FROM entry_fts
    JOIN entry e ON e.id = entry_fts.rowid
    JOIN session s ON s.id = e.session_id
    WHERE ${filters.join(' AND ')}`
  const dedupe = request.dedupeBySession !== false
  const total = dedupe
    ? count(db, `SELECT count(DISTINCT e.session_id) AS total ${from}`, params)
    : count(db, `SELECT count(*) AS total ${from}`, params)
  const limit = bound(request.limit)
  const offset = bound(request.offset)
  if (limit === 0) {
    return { operation: 'search', hits: [], total, truncated: total > offset }
  }
  const found = rows(
    db,
    `${dedupe ? dedupedPageSql(from) : plainPageSql(from)} LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  )
  const terms = highlightTerms(request.query)
  let clipped = false
  const hits: SessiongraphHit[] = found.map((row) => {
    const value = row['text']
    if (typeof value !== 'string') {
      throw new SessiongraphError('an indexed entry has a non-text "text"', 'SESSIONGRAPH_CORRUPT')
    }
    const rendered = renderSnippet(value, terms, maxSnippetChars)
    if (rendered.clipped) clipped = true
    return { ...toHitSubject(row), snippet: rendered.snippet, length: value.length }
  })
  return { operation: 'search', hits, total, truncated: total > offset + hits.length || clipped }
}

/**
 * One page of hits, one per session: the strongest match inside each session, ranked across sessions.
 *
 * The window function runs in its own CTE because the outer statement has to filter on its result
 * (`session_rank = 1`) before ordering; SQLite will not accept a window function in `WHERE`.
 * @param from - the shared `FROM … WHERE …` tail of the search.
 * @returns the statement up to, but not including, `LIMIT`.
 */
function dedupedPageSql(from: string): string {
  return `WITH matched AS (
    SELECT ${HIT_COLUMNS}, e.id AS entry_id, bm25(entry_fts) AS score
    ${from}
  ), ranked AS (
    SELECT *, ROW_NUMBER() OVER (
      PARTITION BY session_id ORDER BY score, time DESC, entry_id
    ) AS session_rank
      FROM matched
  )
  SELECT session_id, source, title, workspace, time, kind, seq, turn, text
    FROM ranked
   WHERE session_rank = 1
   ORDER BY score / ${weightExpression('kind')}, time DESC, seq ASC, entry_id ASC`
}

/**
 * One page of hits, every matching entry eligible. The un-deduped shape, for a single-session sweep.
 * @param from - the shared `FROM … WHERE …` tail of the search.
 * @returns the statement up to, but not including, `LIMIT`.
 */
function plainPageSql(from: string): string {
  return `SELECT ${HIT_COLUMNS}
    ${from}
   ORDER BY bm25(entry_fts) / ${weightExpression('e.kind')}, e.time DESC, e.id ASC`
}

/** Read a `session.id` column, refusing anything that is not text. */
function sessionIdOf(row: IndexRow): SessiongraphSessionId {
  const value = row['id']
  if (typeof value !== 'string') {
    throw new SessiongraphError('an indexed session has a non-text "id"', 'SESSIONGRAPH_CORRUPT')
  }
  return SessiongraphSessionId(value)
}

/**
 * Resolve a full session id or an unambiguous prefix.
 *
 * An exact id always wins, even when it is also a prefix of another id, so a caller holding the real
 * id is never told it is ambiguous. A prefix that matches several sessions raises
 * `SESSIONGRAPH_NOT_FOUND` with the candidates listed: the seam has no "ambiguous" code, the
 * caller's remedy is the same as for a miss (narrow the reference), and the message carries the
 * information needed to do that.
 * @param db - the open index connection.
 * @param wanted - the requested id or prefix.
 * @returns the one session id it names.
 */
function resolveSessionId(db: DatabaseSync, wanted: string): SessiongraphSessionId {
  const reference = wanted.trim()
  if (reference === '') {
    throw new SessiongraphError('a session id must be a non-empty string', 'SESSIONGRAPH_NOT_FOUND')
  }
  const exact = rows(db, 'SELECT id FROM session WHERE id = ?', [reference])[0]
  if (exact !== undefined) return sessionIdOf(exact)
  const candidates = rows(
    db,
    `SELECT id FROM session WHERE id LIKE ? ESCAPE '\\' ORDER BY last_at DESC, id ASC LIMIT 8`,
    [`${escapeLike(reference)}%`],
  )
  if (candidates.length === 0) {
    throw new SessiongraphError(`no indexed session matches "${reference}"`, 'SESSIONGRAPH_NOT_FOUND')
  }
  const [only] = candidates
  if (only !== undefined && candidates.length === 1) return sessionIdOf(only)
  const listing = candidates.map(row => sessionIdOf(row)).join(', ')
  throw new SessiongraphError(
    `session prefix "${reference}" is ambiguous; it matches several sessions: ${listing}`,
    'SESSIONGRAPH_NOT_FOUND',
  )
}

/**
 * Resolve the session a search is restricted to.
 *
 * Same resolution as {@link resolveSessionId}, with one deliberate difference: a prefix naming several
 * sessions is a **bad request**, not a miss. A search silently answered from the wrong conversation is
 * worse than a refusal, and the caller's remedy is to narrow the reference — which the error says.
 * @param db - the open index connection.
 * @param wanted - the requested id or prefix.
 * @returns the one session id it names.
 */
function resolveSearchedSession(db: DatabaseSync, wanted: string): SessiongraphSessionId {
  const reference = wanted.trim()
  if (reference === '') {
    throw new SessiongraphError('a session id filter must be a non-empty string', 'SESSIONGRAPH_INVALID_REQUEST')
  }
  const exact = rows(db, 'SELECT id FROM session WHERE id = ?', [reference])[0]
  if (exact !== undefined) return sessionIdOf(exact)
  const candidates = rows(
    db,
    `SELECT id FROM session WHERE id LIKE ? ESCAPE '\\' ORDER BY last_at DESC, id ASC LIMIT 8`,
    [`${escapeLike(reference)}%`],
  )
  const [only] = candidates
  if (only === undefined) {
    throw new SessiongraphError(`no indexed session matches "${reference}"`, 'SESSIONGRAPH_NOT_FOUND')
  }
  if (candidates.length === 1) return sessionIdOf(only)
  const listing = candidates.map(row => sessionIdOf(row)).join(', ')
  throw new SessiongraphError(
    `session id filter "${reference}" is ambiguous; it matches several sessions: ${listing}`,
    'SESSIONGRAPH_INVALID_REQUEST',
  )
}

/**
 * Read one session's full summary projection.
 * @param db - the open index connection.
 * @param id - the resolved session id.
 * @returns the raw `session` row.
 */
function sessionSummaryRow(db: DatabaseSync, id: SessiongraphSessionId): IndexRow {
  const row = rows(db, `SELECT ${SESSION_COLUMNS} FROM session WHERE id = ?`, [id])[0]
  if (row === undefined) {
    // Unreachable unless the index is being rewritten between two statements; report it as a miss
    // rather than fabricating a summary.
    throw new SessiongraphError(`no indexed session matches "${id}"`, 'SESSIONGRAPH_NOT_FOUND')
  }
  return row
}

/**
 * Read one session's metadata, a page of its entries in the session's own chronological order, and
 * the sessions delegated from it.
 * @param db - the open index connection.
 * @param request - the session query.
 * @returns the session summary, entry page, children, and whether more entries exist.
 */
export function session(db: DatabaseSync, request: SessiongraphSessionRequest): SessiongraphSessionResult {
  const id = resolveSessionId(db, request.sessionId)
  const summary = toSessionSummary(sessionSummaryRow(db, id))
  const limit = bound(request.limit)
  const offset = bound(request.offset)
  const total = count(db, 'SELECT count(*) AS total FROM entry WHERE session_id = ?', [id])
  const entries: SessiongraphEntry[] =
    limit === 0
      ? []
      : rows(
          db,
          `SELECT ${ENTRY_COLUMNS} FROM entry WHERE session_id = ? ORDER BY seq ASC LIMIT ? OFFSET ?`,
          [id, limit, offset],
        ).map(toEntry)
  const children = rows(
    db,
    'SELECT id FROM session WHERE parent_session = ? ORDER BY created_at ASC, id ASC',
    [id],
  ).map(row => sessionIdOf(row))
  return {
    operation: 'session',
    session: summary,
    entries,
    children,
    truncated: total > offset + entries.length,
  }
}

/**
 * Read one event's original log line, plus a window of its neighbours.
 *
 * The index cannot answer this: it stores semantic text, clipped, and only for four entry kinds. So
 * this is the one query that reads a source log directly, and it is the only place the store performs
 * I/O beyond `index.db`.
 * @param db - the open index connection.
 * @param request - the event query.
 * @returns the session summary, the unabridged target event, and its neighbours.
 */
export function event(db: DatabaseSync, request: SessiongraphEventRequest): SessiongraphEventResult {
  const id = resolveSessionId(db, request.sessionId)
  const summary = toSessionSummary(sessionSummaryRow(db, id))
  const log = readRawLog(db, id)
  const window = rawEventWindow(log, request.seq, bound(request.windowBefore), bound(request.windowAfter))
  if (window === undefined) {
    throw new SessiongraphError(`session "${id}" has no event at seq ${request.seq}`, 'SESSIONGRAPH_NOT_FOUND')
  }
  return {
    operation: 'event',
    session: summary,
    event: toRawEvent(window.event),
    before: window.before.map(toRawEventSummary),
    after: window.after.map(toRawEventSummary),
  }
}

/**
 * Follow a session's lineage, or one event's replacement and citation relationships.
 *
 * `seq` selects the shape — present traces one event inside the session, absent traces the session
 * itself — because both ask the same question of the same input and a second operation would cost
 * permanent schema tokens for a question asked rarely.
 * @param db - the open index connection.
 * @param request - the trace query.
 * @returns the session lineage or the event relationship graph.
 */
export function trace(db: DatabaseSync, request: SessiongraphTraceRequest): SessiongraphTraceResult {
  const id = resolveSessionId(db, request.sessionId)
  if (request.seq !== undefined) return traceEvent(db, id, request.seq)
  return traceSessionChain(db, id, request.depth)
}

/**
 * Trace one event: which surface events replaced it, which it replaced, and what it cites.
 * @param db - the open index connection.
 * @param id - the resolved session id.
 * @param seq - the target event's sequence number.
 * @returns the event trace.
 */
function traceEvent(
  db: DatabaseSync,
  id: SessiongraphSessionId,
  seq: number,
): SessiongraphEventTraceResult {
  const summary = toSessionSummary(sessionSummaryRow(db, id))
  const log = readRawLog(db, id)
  const traced = traceRawEvent(log, seq)
  if (traced === undefined) {
    throw new SessiongraphError(`session "${id}" has no event at seq ${seq}`, 'SESSIONGRAPH_NOT_FOUND')
  }
  return {
    operation: 'trace',
    kind: 'event',
    session: summary,
    event: toRawEventSummary(traced.event),
    replacedBy: [...traced.replacedBy],
    shadowedSeqs: [...traced.shadowedSeqs],
    sourceEventSeqs: [...traced.sourceEventSeqs],
  }
}

/**
 * Trace one session: its ancestor chain and its descendant tree.
 *
 * Two recursive CTEs over `parent_session`, one upward and one downward. `complete` is the answer the
 * caller actually needs: a session whose parent is not indexed and a session whose delegation tree was
 * cut by `depth` both produce a shorter tree than reality, and "this is the root" must not be
 * confused with "the walk gave up".
 * @param db - the open index connection.
 * @param id - the resolved session id.
 * @param requestedDepth - maximum descendant depth, or undefined for the whole tree.
 * @returns the target, its ancestors nearest first, its descendant tree, and whether the walk was
 * complete.
 */
function traceSessionChain(
  db: DatabaseSync,
  id: SessiongraphSessionId,
  requestedDepth: number | undefined,
): SessiongraphSessionTraceResult {
  const target = toSessionSummary(sessionSummaryRow(db, id))
  const depth = requestedDepth === undefined ? MAX_LINEAGE_DEPTH : Math.min(bound(requestedDepth), MAX_LINEAGE_DEPTH)

  const ancestorRows = rows(
    db,
    `WITH RECURSIVE ancestry(id, parent_session, depth) AS (
       SELECT id, parent_session, 0 FROM session WHERE id = ?
       UNION ALL
       SELECT s.id, s.parent_session, a.depth + 1
         FROM session s JOIN ancestry a ON s.id = a.parent_session
        WHERE a.depth < ?
     )
     SELECT ${SESSION_COLUMNS_S}, a.depth AS depth
       FROM session s JOIN ancestry a ON a.id = s.id
      WHERE a.depth > 0
      ORDER BY a.depth ASC`,
    [id, MAX_LINEAGE_DEPTH],
  )
  const ancestors: SessiongraphSessionSummary[] = []
  const seenAncestors = new Set<string>()
  let ancestorsComplete = true
  for (const row of ancestorRows) {
    const ancestor = toSessionSummary(row)
    if (seenAncestors.has(ancestor.sessionId)) {
      // A cycle in the log's lineage links: stop where it closes instead of listing a session twice.
      ancestorsComplete = false
      break
    }
    seenAncestors.add(ancestor.sessionId)
    ancestors.push(ancestor)
  }
  // The chain is complete only when the deepest ancestor it reached is itself a root. A held
  // `parent_session` that is not in the index — on the target or on the deepest ancestor — means the
  // parent exists somewhere this store cannot see, so "no ancestors" must not read as "this is a root".
  if (target.parentSession !== undefined) {
    // `nearest` is absent exactly when the walk found no parent row at all, which is the missing-parent
    // case; the chain is only complete when it ended on a row that is itself a root.
    const nearest = ancestors[ancestors.length - 1]
    ancestorsComplete = nearest !== undefined && nearest.parentSession === undefined
  }

  const descendantRows = rows(
    db,
    `WITH RECURSIVE lineage(id, depth) AS (
       SELECT id, 0 FROM session WHERE id = ?
       UNION ALL
       SELECT s.id, l.depth + 1
         FROM session s JOIN lineage l ON s.parent_session = l.id
        WHERE l.depth < ?
     )
     SELECT ${SESSION_COLUMNS_S}, l.depth AS depth
       FROM session s JOIN lineage l ON l.id = s.id
      WHERE l.depth > 0
      ORDER BY l.depth ASC, s.created_at ASC, s.id ASC`,
    [id, depth],
  )
  const descendants: SessiongraphTraceNode[] = []
  const nodesById = new Map<string, SessiongraphTraceNode>()
  const seenDescendants = new Set<string>([id])
  let deepest = 0
  let descendantsComplete = true
  for (const row of descendantRows) {
    const summary = toSessionSummary(row)
    // A cyclic lineage can walk back onto an already-seen session; keep the first (shallowest) copy.
    if (seenDescendants.has(summary.sessionId)) {
      descendantsComplete = false
      continue
    }
    seenDescendants.add(summary.sessionId)
    const node: SessiongraphTraceNode = { session: summary, descendants: [] }
    nodesById.set(summary.sessionId, node)
    const parentId = summary.parentSession
    const parent = parentId === undefined ? undefined : nodesById.get(parentId)
    if (parent === undefined) descendants.push(node)
    else parent.descendants.push(node)
    const rowDepth = row['depth']
    if (typeof rowDepth === 'number' && rowDepth > deepest) deepest = rowDepth
  }
  // A walk that reached its bound may have stopped short: ask whether anything hangs below the
  // deepest level it returned. One bounded query is cheaper and more honest than always reporting
  // `complete: false` for a depth-limited walk that happened to see everything.
  //
  // `depth: 0` has no returned level to inspect, so its frontier is the target itself — without that
  // case a request that asked for zero levels would claim the target has no descendants.
  const frontier = depth === 0 ? [id as string] : deepest >= depth ? [...nodesById.keys()] : []
  if (frontier.length > 0) {
    const placeholders = frontier.map(() => '?').join(', ')
    const below = count(
      db,
      `SELECT count(*) AS total FROM session WHERE parent_session IN (${placeholders})`,
      frontier,
    )
    if (below > 0) descendantsComplete = false
  }

  return {
    operation: 'trace',
    kind: 'session',
    target,
    ancestors,
    descendants,
    complete: ancestorsComplete && descendantsComplete,
  }
}

/**
 * Read the source log an indexed session came from.
 *
 * A live session (`live://` source) has no log yet; that is a real state, not corruption, so it is
 * reported as `SESSIONGRAPH_IO` with the reason rather than as a missing session.
 * @param db - the open index connection.
 * @param id - the resolved session id.
 * @returns the parsed raw log.
 */
function readRawLog(db: DatabaseSync, id: SessiongraphSessionId): RawSessionLog {
  const row = rows(db, 'SELECT source_path FROM session WHERE id = ?', [id])[0]
  if (row === undefined) {
    throw new SessiongraphError(`no indexed session matches "${id}"`, 'SESSIONGRAPH_NOT_FOUND')
  }
  const sourcePath = row['source_path']
  if (typeof sourcePath !== 'string') {
    throw new SessiongraphError(`indexed session "${id}" has a non-text "source_path"`, 'SESSIONGRAPH_CORRUPT')
  }
  if (isLiveSource(sourcePath)) {
    throw new SessiongraphError(
      `session "${id}" is still running: its log is not on disk yet, so its raw events cannot be read`,
      'SESSIONGRAPH_IO',
    )
  }
  try {
    const log = readRawEvents(sourcePath)
    if (log === undefined) {
      throw new SessiongraphError(`session "${id}" has no readable source log`, 'SESSIONGRAPH_IO')
    }
    return log
  } catch (error) {
    if (error instanceof SessiongraphError) throw error
    throw new SessiongraphError(
      `cannot read the source log of session "${id}" (${describeError(error)})`,
      'SESSIONGRAPH_IO',
    )
  }
}

/** One diagnostic line from a caught value, without assuming it is an Error. */
function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * List sessions newest-first by last activity.
 * @param db - the open index connection.
 * @param request - the timeline query.
 * @returns the page of session summaries and whether more exist.
 */
export function timeline(db: DatabaseSync, request: SessiongraphTimelineRequest): SessiongraphTimelineResult {
  const limit = bound(request.limit)
  if (limit === 0) return { operation: 'timeline', sessions: [], truncated: false }
  const filters: string[] = []
  const params: unknown[] = []
  const workspace = workspaceClause('s.workspace', request.workspace)
  if (workspace !== undefined) {
    filters.push(workspace.clause)
    params.push(...workspace.params)
  }
  if (request.source !== undefined) {
    filters.push('s.source = ?')
    params.push(request.source)
  }
  // `after`/`before` describe the session's span, not an entry's time: `after` is "still active at or
  // after", `before` is "already started at or before", so a call can ask for sessions alive in a
  // window without knowing their internal event ordering.
  if (request.after !== undefined) {
    filters.push('s.last_at >= ?')
    params.push(request.after)
  }
  if (request.before !== undefined) {
    filters.push('s.created_at <= ?')
    params.push(request.before)
  }
  const where = filters.length === 0 ? '' : `WHERE ${filters.join(' AND ')}`
  // One extra row distinguishes "exactly `limit` sessions" from "there are more" without a second
  // count query; `offset` skips whole sessions, so a second page neither repeats nor drops one.
  const found = rows(
    db,
    `SELECT ${SESSION_COLUMNS} FROM session s ${where} ORDER BY s.last_at DESC, s.id ASC LIMIT ? OFFSET ?`,
    [...params, limit + 1, bound(request.offset)],
  )
  const truncated = found.length > limit
  return {
    operation: 'timeline',
    sessions: (truncated ? found.slice(0, limit) : found).map(toSessionSummary),
    truncated,
  }
}

/**
 * Enumerate indexed workspaces, most recently active first.
 * @param db - the open index connection.
 * @param request - the workspaces query.
 * @returns the page of workspace statistics and the pre-limit total.
 */
export function workspaces(
  db: DatabaseSync,
  request: SessiongraphWorkspacesRequest,
): SessiongraphWorkspacesResult {
  // The census answers "which directories does this index cover", so a source filter narrows both
  // halves consistently: a total counted over every session beside a page filtered to one harness
  // would make `truncated` meaningless.
  const where = request.source === undefined ? '' : 'WHERE source = ?'
  const params = request.source === undefined ? [] : [request.source]
  const total = count(db, `SELECT count(DISTINCT workspace) AS total FROM session ${where}`, params)
  const limit = bound(request.limit)
  if (limit === 0) return { operation: 'workspaces', workspaces: [], total }
  const found: SessiongraphWorkspaceStat[] = rows(
    db,
    `SELECT workspace,
            count(*) AS sessions,
            COALESCE(sum(entries), 0) AS entries,
            min(created_at) AS first_at,
            max(last_at) AS last_at
       FROM session
      ${where}
      GROUP BY workspace
      ORDER BY max(last_at) DESC, workspace ASC
      LIMIT ? OFFSET ?`,
    [...params, limit, bound(request.offset)],
  ).map(toWorkspaceStat)
  return { operation: 'workspaces', workspaces: found, total }
}

/**
 * Tools whose arguments name exactly one filesystem path, and the argument field holding it.
 *
 * The table is the whole whitelist, and it is matched case-sensitively against the tool name the log
 * recorded. `read`/`edit`/`write`/`read_image` name a file they were pointed at; `grep`/`glob` name a
 * tree they were run over. Everything else is ignored — most importantly `bash`, which is the
 * largest single kind of tool call and whose command line is free text, so reading a path out of it
 * would be guessing rather than reporting.
 */
const TOUCHED_PATH_FIELDS: Readonly<Record<string, { readonly field: string; readonly dir: boolean }>> = {
  read: { field: 'file_path', dir: false },
  edit: { field: 'file_path', dir: false },
  write: { field: 'file_path', dir: false },
  read_image: { field: 'file_path', dir: false },
  grep: { field: 'path', dir: true },
  glob: { field: 'path', dir: true },
}

/**
 * What one `tool` entry contributes to a touched answer.
 *
 * Three outcomes, not two: a call by a tool that names no path is `ignore` (it is not a parse
 * failure), while a whitelisted call whose arguments cannot be read is `unparsed` and is counted. A
 * caller must be able to tell "this session touched two files" from "this session touched two files
 * out of forty calls this store could not read".
 */
type TouchedCall =
  | { readonly outcome: 'resource'; readonly tool: string; readonly path: string; readonly dir: boolean }
  | { readonly outcome: 'ignore' }
  | { readonly outcome: 'unparsed' }

/**
 * Read the one filesystem path a tool entry names.
 *
 * `entry.text` is `<tool name> <json arguments>`; the tool name never contains a space, so the first
 * space is the boundary. An entry with no space at all is a call with no arguments and contributes
 * nothing. A clipped entry is `unparsed` without even attempting the parse: the indexer cut the JSON
 * at its per-entry cap, and a truncated JSON is never guessed at.
 * @param entry - one validated `tool` entry from the session.
 * @param workspace - the session's recorded cwd, the anchor for a relative path.
 * @returns the normalised path and how to classify it, or why the call contributed nothing.
 */
function touchedCall(entry: SessiongraphEntry, workspace: string): TouchedCall {
  const space = entry.text.indexOf(' ')
  if (space <= 0) return { outcome: 'ignore' }
  const tool = entry.text.slice(0, space)
  const spec = TOUCHED_PATH_FIELDS[tool]
  if (spec === undefined) return { outcome: 'ignore' }
  if (entry.clipped) return { outcome: 'unparsed' }
  let args: unknown
  try {
    args = JSON.parse(entry.text.slice(space + 1))
  } catch {
    return { outcome: 'unparsed' }
  }
  if (typeof args !== 'object' || args === null) return { outcome: 'unparsed' }
  const named = (args as Record<string, unknown>)[spec.field]
  if (typeof named !== 'string' || named.trim() === '') return { outcome: 'unparsed' }
  // An absolute path is normalised as given; a relative one is anchored to the session's own cwd. The
  // filesystem is never consulted and symlinks are never resolved: the file may be long gone, and the
  // question is what the call named, not what it would point at today.
  let path: string
  if (isAbsolute(named)) path = normalize(named)
  else if (workspace.trim() === '') return { outcome: 'unparsed' }
  else path = resolve(workspace, named)
  // A trailing separator must not split one directory into two resources: `normalize` keeps it while
  // `resolve` drops it, so the same tree named by an absolute and by a relative path would otherwise
  // land in two rows. The filesystem root keeps its single slash. Whether it is a directory is
  // decided separately, from what the call itself wrote.
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  // A grep/glob target is a tree by construction; anything else is a directory only when the call
  // wrote it with a trailing separator.
  return { outcome: 'resource', tool, path, dir: spec.dir || named.endsWith('/') }
}

/** One resource's running totals while a session's tool entries are walked. */
interface TouchedTotals {
  dir: boolean
  mentions: number
  firstSeq: number
  lastSeq: number
  firstAt: number
  lastAt: number
  tools: Set<string>
}

/**
 * List the filesystem resources one session's tool calls referenced.
 *
 * Answered from the index's own `tool` entries rather than an edge table: a session holds around a
 * hundred tool calls, so a full walk costs milliseconds, while a materialised table would cost a
 * schema version, a rebuild of every index on the machine, and a second implementation in the native
 * kernel — for a relationship that can always be recomputed from `entry.text`.
 * @param db - the open index connection.
 * @param request - the touched query.
 * @returns the page of resources, the pre-paging total, and how many calls could not be read.
 */
export function touched(db: DatabaseSync, request: SessiongraphTouchedRequest): SessiongraphTouchedResult {
  const id = resolveSessionId(db, request.sessionId)
  // The session's workspace is the anchor every relative path is resolved against, so a corrupt row
  // must fail here rather than silently resolve against an empty directory.
  const workspace = toSessionSummary(sessionSummaryRow(db, id)).workspace
  const toolEntries = rows(
    db,
    `SELECT ${ENTRY_COLUMNS} FROM entry WHERE session_id = ? AND kind = 'tool' ORDER BY seq ASC`,
    [id],
  ).map(toEntry)
  const totals = new Map<string, TouchedTotals>()
  let unparsed = 0
  for (const entry of toolEntries) {
    const call = touchedCall(entry, workspace)
    if (call.outcome === 'ignore') continue
    if (call.outcome === 'unparsed') {
      unparsed += 1
      continue
    }
    const running = totals.get(call.path)
    if (running === undefined) {
      totals.set(call.path, {
        dir: call.dir,
        mentions: 1,
        firstSeq: entry.seq,
        lastSeq: entry.seq,
        firstAt: entry.time,
        lastAt: entry.time,
        tools: new Set([call.tool]),
      })
      continue
    }
    // One path reached through several calls is one resource: the counts and the span accumulate, and
    // a single call that named it as a tree is enough to report it as one.
    running.dir = running.dir || call.dir
    running.mentions += 1
    running.firstSeq = Math.min(running.firstSeq, entry.seq)
    running.lastSeq = Math.max(running.lastSeq, entry.seq)
    running.firstAt = Math.min(running.firstAt, entry.time)
    running.lastAt = Math.max(running.lastAt, entry.time)
    running.tools.add(call.tool)
  }
  const merged: SessiongraphTouchedEntry[] = [...totals.entries()]
    .map(([path, running]): SessiongraphTouchedEntry => ({
      path,
      kind: running.dir ? 'dir' : 'file',
      mentions: running.mentions,
      firstSeq: running.firstSeq,
      lastSeq: running.lastSeq,
      firstAt: running.firstAt,
      lastAt: running.lastAt,
      tools: [...running.tools].sort(),
    }))
    // Most-referenced first, then most recently touched, then path. The third key makes the order
    // total, so paging cannot repeat or skip a resource whose first two keys tie.
    .sort(
      (a, b) =>
        b.mentions - a.mentions
        || b.lastAt - a.lastAt
        || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    )
  const limit = bound(request.limit)
  const offset = bound(request.offset)
  return {
    operation: 'touched',
    sessionId: id,
    resources: merged.slice(offset, offset + limit),
    total: merged.length,
    truncated: merged.length > limit + offset,
    unparsed,
  }
}

/**
 * Report the index's own state.
 *
 * This is the one operation that answers when no index exists: a caller that never indexed anything
 * needs to learn that fact, and every other operation fails loud instead of pretending the store is
 * empty. A file that exists but cannot be read is still `SESSIONGRAPH_CORRUPT` — `indexes()` already
 * claimed the root, so quietly downgrading it to "not indexed" would hide a damaged index.
 * @param pool - the store's connection pool.
 * @param indexRoot - directory the seam routed the request to.
 * @returns the index summary, or the zero result for a root that holds no index.
 */
export function status(pool: IndexPool, indexRoot: string): SessiongraphStatusResult {
  const indexPath = databasePath(indexRoot)
  let bytes = 0
  try {
    bytes = statSync(indexPath).size
  } catch {
    return {
      operation: 'status',
      indexed: false,
      indexPath,
      sessions: 0,
      liveSessions: 0,
      entries: 0,
      workspaces: 0,
      indexedAt: undefined,
      bytes: 0,
    }
  }
  const db = pool.acquire(indexRoot)
  const indexedAtRow = rows(db, 'SELECT value FROM meta WHERE key = ?', [META_INDEXED_AT])[0]
  const raw = indexedAtRow?.['value']
  const parsed = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN
  return {
    operation: 'status',
    indexed: true,
    indexPath,
    sessions: count(db, 'SELECT count(*) AS total FROM session'),
    liveSessions: count(db, `SELECT count(*) AS total FROM session WHERE source_path LIKE '${LIVE_SOURCE_LIKE}'`),
    entries: count(db, 'SELECT count(*) AS total FROM entry'),
    workspaces: count(db, 'SELECT count(DISTINCT workspace) AS total FROM session'),
    // Epoch milliseconds fit a double, so a valid `indexed_at` never loses precision here; a missing
    // or non-numeric stamp reads as "never run" rather than as 0 (i.e. 1970).
    indexedAt: Number.isFinite(parsed) ? parsed : undefined,
    bytes,
  }
}
