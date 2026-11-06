/**
 * Durable-boundary mapping from SQLite rows to seam records. Every value crossing this module comes
 * from a file an independently versioned indexer wrote, so each field is checked before it becomes
 * a typed record; a row that violates the format fails loud as `SESSIONGRAPH_CORRUPT` rather than
 * reaching a consumer as a plausible-looking wrong value.
 *
 * Optional columns (`title`, `turn`, `parent_session`, `origin`, `agent_preset`) become `undefined`,
 * never `null`: the seam's contract is a TypeScript `string | number | undefined`, and a leaked
 * `null` would render as the literal text "null" one layer up.
 * @module dsh-plugin-sessiongraph-sqlite/rows
 */

import {
  SESSIONGRAPH_ENTRY_KINDS,
  SessiongraphError,
  SessiongraphSessionId,
} from 'dsh-plugin-sessiongraph-service'
import type {
  SessiongraphEntry,
  SessiongraphEntryKind,
  SessiongraphHit,
  SessiongraphRawEvent,
  SessiongraphRawEventSummary,
  SessiongraphSessionSummary,
  SessiongraphWorkspaceStat,
} from 'dsh-plugin-sessiongraph-service'
import type { RawSessionEvent } from 'dsh-plugin-sessiongraph-sessions'

/** One row as `node:sqlite` returns it, before validation. */
export type IndexRow = Record<string, unknown>

/**
 * Read a required text column.
 * @param row - the raw row.
 * @param column - the column name.
 * @param what - the record being built, for the failure message.
 * @returns the column's string value.
 */
function text(row: IndexRow, column: string, what: string): string {
  const value = row[column]
  if (typeof value !== 'string') {
    throw new SessiongraphError(`${what} has a non-text "${column}"`, 'SESSIONGRAPH_CORRUPT')
  }
  return value
}

/**
 * Read a required integer column.
 * @param row - the raw row.
 * @param column - the column name.
 * @param what - the record being built, for the failure message.
 * @returns the column's numeric value.
 */
function integer(row: IndexRow, column: string, what: string): number {
  const value = row[column]
  if (typeof value === 'number') return value
  // A stored INTEGER outside the safe range never reaches here: `node:sqlite` raises a RangeError
  // while reading the row, because this store opens connections without bigint reads.
  throw new SessiongraphError(`${what} has a non-integer "${column}"`, 'SESSIONGRAPH_CORRUPT')
}

/**
 * Read an optional text column, treating SQL NULL and the empty string alike as absent.
 * @param row - the raw row.
 * @param column - the column name.
 * @param what - the record being built, for the failure message.
 * @returns the column's string value, or undefined when absent.
 */
function optionalText(row: IndexRow, column: string, what: string): string | undefined {
  const value = row[column]
  if (value === null || value === undefined || value === '') return undefined
  if (typeof value !== 'string') {
    throw new SessiongraphError(`${what} has a non-text "${column}"`, 'SESSIONGRAPH_CORRUPT')
  }
  return value
}

/**
 * Read an optional integer column.
 * @param row - the raw row.
 * @param column - the column name.
 * @param what - the record being built, for the failure message.
 * @returns the column's numeric value, or undefined when NULL.
 */
function optionalInteger(row: IndexRow, column: string, what: string): number | undefined {
  const value = row[column]
  if (value === null || value === undefined) return undefined
  return integer(row, column, what)
}

/**
 * Read a boolean stored as INTEGER 0/1.
 * @param row - the raw row.
 * @param column - the column name.
 * @param what - the record being built, for the failure message.
 * @returns whether the flag is set.
 */
function flag(row: IndexRow, column: string, what: string): boolean {
  return integer(row, column, what) !== 0
}

/**
 * Read an entry kind, refusing a value this schema version does not define.
 * @param row - the raw row.
 * @param what - the record being built, for the failure message.
 * @returns the validated kind.
 */
function entryKind(row: IndexRow, what: string): SessiongraphEntryKind {
  const value = text(row, 'kind', what)
  if (!(SESSIONGRAPH_ENTRY_KINDS as readonly string[]).includes(value)) {
    throw new SessiongraphError(`${what} has an unknown entry kind "${value}"`, 'SESSIONGRAPH_CORRUPT')
  }
  return value as SessiongraphEntryKind
}

/**
 * Build a {@link SessiongraphSessionSummary} from a `session` row.
 * @param row - the raw row, selected with every column the summary reads.
 * @returns the validated session record.
 */
export function toSessionSummary(row: IndexRow): SessiongraphSessionSummary {
  const what = 'an indexed session'
  const id = text(row, 'id', what)
  const named = `indexed session "${id}"`
  const title = optionalText(row, 'title', named)
  const parentSession = optionalText(row, 'parent_session', named)
  const origin = optionalText(row, 'origin', named)
  const agentPreset = optionalText(row, 'agent_preset', named)
  return {
    sessionId: SessiongraphSessionId(id),
    title,
    workspace: text(row, 'workspace', named),
    createdAt: integer(row, 'created_at', named),
    lastAt: integer(row, 'last_at', named),
    turns: integer(row, 'turns', named),
    entries: integer(row, 'entries', named),
    parentSession,
    origin,
    agentPreset,
  }
}

/**
 * Build a {@link SessiongraphEntry} from an `entry` row.
 * @param row - the raw row selected as `seq, time, kind, turn, text, clipped`.
 * @returns the validated entry record.
 */
export function toEntry(row: IndexRow): SessiongraphEntry {
  const what = 'an indexed entry'
  return {
    seq: integer(row, 'seq', what),
    time: integer(row, 'time', what),
    kind: entryKind(row, what),
    turn: optionalInteger(row, 'turn', what),
    text: text(row, 'text', what),
    clipped: flag(row, 'clipped', what),
  }
}

/**
 * Build the metadata half of a {@link SessiongraphHit}; the caller adds the rendered `snippet` and
 * the entry's full `length`, because both are a function of the query and the plugin's snippet cap
 * rather than of the stored row.
 * @param row - the raw row selected as `session_id, title, workspace, time, kind, seq, turn`.
 * @returns the validated hit fields.
 */
export function toHitSubject(row: IndexRow): Omit<SessiongraphHit, 'snippet' | 'length'> {
  const what = 'a search hit'
  return {
    sessionId: SessiongraphSessionId(text(row, 'session_id', what)),
    title: optionalText(row, 'title', what),
    workspace: text(row, 'workspace', what),
    time: integer(row, 'time', what),
    kind: entryKind(row, what),
    seq: integer(row, 'seq', what),
    turn: optionalInteger(row, 'turn', what),
  }
}

/**
 * Build a {@link SessiongraphWorkspaceStat} from a grouped `session` row.
 * @param row - the raw row selected as `workspace, sessions, entries, first_at, last_at`.
 * @returns the validated workspace record.
 */
export function toWorkspaceStat(row: IndexRow): SessiongraphWorkspaceStat {
  const what = 'an indexed workspace'
  return {
    workspace: text(row, 'workspace', what),
    sessions: integer(row, 'sessions', what),
    entries: integer(row, 'entries', what),
    firstAt: integer(row, 'first_at', what),
    lastAt: integer(row, 'last_at', what),
  }
}

/**
 * Build a {@link SessiongraphRawEvent} from one parsed log event.
 *
 * Nothing is validated beyond the identity fields, and nothing is clipped: the payload is handed to
 * the caller exactly as the log holds it. `data` is deliberately `unknown` — the log's event
 * vocabulary belongs to the session runtime, and re-declaring it here would drift from it.
 * @param event - one event parsed from a session log.
 * @returns the seam's raw event record.
 */
export function toRawEvent(event: RawSessionEvent): SessiongraphRawEvent {
  return { seq: event.seq, time: event.time, type: event.type, data: event.data }
}

/**
 * Build a {@link SessiongraphRawEventSummary} from one parsed log event: its identity, without the
 * payload. Windows around a target are answered as summaries because a `tool/result` can be
 * megabytes, and a caller orienting around an event wants the shape of the conversation, not its body.
 * @param event - one event parsed from a session log.
 * @returns the seam's raw-event summary.
 */
export function toRawEventSummary(event: RawSessionEvent): SessiongraphRawEventSummary {
  return { seq: event.seq, time: event.time, type: event.type }
}
