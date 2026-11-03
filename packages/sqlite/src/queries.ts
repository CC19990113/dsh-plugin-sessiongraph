/**
 * The five seam operations against one open index database. Every function here is synchronous:
 * `node:sqlite` is a synchronous binding, so a query either completes within one turn or throws, and
 * the store's async surface exists for the seam's contract rather than for I/O interleaving.
 *
 * User-supplied strings never reach a statement as SQL text. Every filter is a `?` binding; the only
 * text shaped from input is a `LIKE` pattern, and its wildcard characters are escaped so a workspace
 * path containing `%` or `_` still matches literally.
 * @module dsh-plugin-sessiongraph-sqlite/queries
 */

import { statSync } from 'node:fs'
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
  SessiongraphHit,
  SessiongraphSearchRequest,
  SessiongraphSearchResult,
  SessiongraphSessionRequest,
  SessiongraphSessionResult,
  SessiongraphStatusResult,
  SessiongraphTimelineRequest,
  SessiongraphTimelineResult,
  SessiongraphWorkspaceStat,
  SessiongraphWorkspacesRequest,
  SessiongraphWorkspacesResult,
} from 'dsh-plugin-sessiongraph-service'
import { databasePath } from './database.ts'
import type { IndexPool } from './database.ts'
import type { IndexRow } from './rows.ts'
import { toEntry, toHitSubject, toSessionSummary, toWorkspaceStat } from './rows.ts'

/** Every `session` column the summary projection reads. */
const SESSION_COLUMNS = [
  'id',
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
 * `source_path` prefix the indexer writes for a conversation that is still running, before its log
 * exists on disk. Spelled out here instead of imported from the indexer package: a store depends only
 * on the seam, and this is a value shared through the on-disk format, not through code. A session
 * ends and is re-indexed from a real path, at which point its row no longer matches.
 */
const LIVE_SOURCE_LIKE = 'live://%'

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
 * Ordering is `bm25`, then newest, then entry id. `bm25` is chosen over plain recency because a
 * search result list is read top-down and the caller wants the best match first, not merely the most
 * recent one. Ranking alone is NOT a total order: equally scored rows (extremely common for short
 * entries and bigram queries) come back in whatever order the scan produced, which would make
 * `LIMIT`/`OFFSET` paging skip and duplicate rows between pages. Appending `e.time DESC, e.id ASC`
 * supplies a deterministic total order without displacing relevance, since `entry.id` is unique and
 * UNIQUE breaks every remaining tie. That is also why this is the one operation whose page order is
 * stable across requests against an unchanged index.
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
  if (request.kinds !== undefined) {
    filters.push(`e.kind IN (${request.kinds.map(() => '?').join(', ')})`)
    params.push(...request.kinds)
  }
  const workspace = workspaceClause('s.workspace', request.workspace)
  if (workspace !== undefined) {
    filters.push(workspace.clause)
    params.push(...workspace.params)
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
  const total = count(db, `SELECT count(*) AS total ${from}`, params)
  const limit = bound(request.limit)
  const offset = bound(request.offset)
  if (limit === 0) {
    return { operation: 'search', hits: [], total, truncated: total > offset }
  }
  const found = rows(
    db,
    `SELECT e.session_id AS session_id, s.title AS title, s.workspace AS workspace,
            e.time AS time, e.kind AS kind, e.seq AS seq, e.turn AS turn, e.text AS text
       ${from}
      ORDER BY bm25(entry_fts), e.time DESC, e.id ASC
      LIMIT ? OFFSET ?`,
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
 * Read one session's metadata, a page of its entries in the session's own chronological order, and
 * the sessions delegated from it.
 * @param db - the open index connection.
 * @param request - the session query.
 * @returns the session summary, entry page, children, and whether more entries exist.
 */
export function session(db: DatabaseSync, request: SessiongraphSessionRequest): SessiongraphSessionResult {
  const id = resolveSessionId(db, request.sessionId)
  const summaryRow = rows(db, `SELECT ${SESSION_COLUMNS} FROM session WHERE id = ?`, [id])[0]
  if (summaryRow === undefined) {
    // Unreachable unless the index is being rewritten between two statements; report it as a miss
    // rather than fabricating a summary.
    throw new SessiongraphError(`no indexed session matches "${request.sessionId}"`, 'SESSIONGRAPH_NOT_FOUND')
  }
  const summary = toSessionSummary(summaryRow)
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
  // count query.
  const found = rows(
    db,
    `SELECT ${SESSION_COLUMNS} FROM session s ${where} ORDER BY s.last_at DESC, s.id ASC LIMIT ?`,
    [...params, limit + 1],
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
  const total = count(db, 'SELECT count(DISTINCT workspace) AS total FROM session')
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
      GROUP BY workspace
      ORDER BY max(last_at) DESC, workspace ASC
      LIMIT ?`,
    [limit],
  ).map(toWorkspaceStat)
  return { operation: 'workspaces', workspaces: found, total }
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
