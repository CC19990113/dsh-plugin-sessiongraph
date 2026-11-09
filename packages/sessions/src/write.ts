/**
 * Write the session index with `node:sqlite`.
 *
 * Two modes, deliberately different on disk:
 *
 * - **Rebuild** (`force`) writes a complete index to `index.db.tmp` and renames it over `index.db`
 *   only after the transaction commits, so a reader never observes a half-built index and a run that
 *   dies leaves the previous one untouched. When the run is also scoped (a workspace or single
 *   session was requested), the previous index is attached and copied in first, because a scoped
 *   rebuild must not delete the sessions it was not asked about.
 * - **Incremental** opens the live index and rewrites only the sessions whose source changed, inside
 *   one transaction.
 *
 * `entry_fts.rowid` is aligned with `entry.id`: every written entry row is followed by exactly one
 * FTS row carrying the tokenizer's output. Deletion therefore goes FTS-first — the entry rows are
 * what names the rowids, so dropping them first would strand the FTS rows.
 * @module dsh-plugin-sessiongraph-sessions/write
 */

import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  ENTRY_FTS_TABLE,
  ENTRY_TABLE,
  META_DISCOVERED,
  META_FAILED,
  META_INDEXED_AT,
  META_SCHEMA_VERSION,
  SCHEMA_STATEMENTS,
  SCHEMA_VERSION,
  SESSION_TABLE,
  SESSIONGRAPH_SOURCES,
  tokenize,
} from 'dsh-plugin-sessiongraph-service'
import type { SessiongraphSource } from 'dsh-plugin-sessiongraph-service'
import type { ParsedSession } from './parse.ts'

/** One parsed session and the source it is recorded as coming from. */
export interface IndexedSession {
  readonly session: ParsedSession
  /** Which harness wrote the log this session was parsed from. */
  readonly source: SessiongraphSource
  /**
   * Absolute path of the log it came from, or the synthetic `live://<id>` marker for a session the
   * host still holds in memory and that has no stable file version yet.
   */
  readonly sourcePath: string
  /** Source modification time, or 0 for a live session (there is no version to compare). */
  readonly mtime: number
  /** Source size in bytes, or 0 for a live session. */
  readonly size: number
}

/**
 * Sidecar summary an indexer leaves beside `index.db`.
 *
 * Prompt assembly must never open SQLite, so the same post-run totals the report carries are also
 * persisted as a small JSON file the tool can read synchronously. It is a derived copy: the `meta`
 * table stays authoritative for the store, and a missing sidecar only degrades the prompt line.
 */
export const STATUS_RELATIVE_PATH = 'status.json'

/** What a previous index already holds for one source file. */
export interface ExistingSession {
  readonly id: string
  /** Which harness wrote the session, as the previous run recorded it. */
  readonly source: SessiongraphSource
  readonly workspace: string
  /** Absolute path of the session log this row was built from. */
  readonly sourcePath: string
  readonly mtime: number
  readonly size: number
}

/** One index write, already scoped by the caller. */
export interface IndexWritePlan {
  /** Absolute path of `index.db`. */
  readonly indexPath: string
  /** Rebuild from scratch in `index.db.tmp` and rename it into place. */
  readonly force: boolean
  /** With `force`: seed the rebuild from the previous index so out-of-scope rows survive. */
  readonly preserveExisting: boolean
  /** Sessions to (re)write. */
  readonly sessions: readonly IndexedSession[]
  /** Session ids whose source file disappeared. */
  readonly removed: readonly string[]
  /** Sessions the scan found, for `meta.discovered`. */
  readonly discovered: number
  /** Sessions that failed to parse, for `meta.failed`. */
  readonly failed: number
  /** Epoch milliseconds recorded as the run's completion time in `meta` and the sidecar. */
  readonly indexedAt: number
}

/** What one index write produced. */
export interface IndexWriteResult {
  /** Searchable entries in the index after the write. */
  readonly entries: number
  /** Sessions in the index after the write. */
  readonly sessions: number
  /** Distinct workspaces in the index after the write. */
  readonly workspaces: number
  /** Bytes the index file occupies after the write. */
  readonly bytes: number
}

/**
 * Read the state a previous index recorded, when it is usable.
 *
 * An index written by another schema version is refused rather than reused: silently mixing two
 * shapes would hand the store rows it cannot interpret.
 * @param indexPath - absolute path of `index.db`.
 * @returns rows keyed by source path, or undefined when there is no usable index.
 */
export function readIndexState(indexPath: string): ReadonlyMap<string, ExistingSession> | undefined {
  if (!existsSync(indexPath)) return undefined
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(indexPath, { readOnly: true })
    const version = database.prepare(`SELECT value FROM meta WHERE key = ?`).get(META_SCHEMA_VERSION)
    if (version === undefined || String(version.value) !== String(SCHEMA_VERSION)) return undefined
    const rows = database
      .prepare(`SELECT id, source, workspace, source_path, source_mtime, source_size FROM ${SESSION_TABLE}`)
      .all()
    const existing = new Map<string, ExistingSession>()
    for (const row of rows) {
      const id = stringColumn(row, 'id')
      const sourcePath = stringColumn(row, 'source_path')
      if (id === undefined || sourcePath === undefined) continue
      existing.set(sourcePath, {
        id,
        source: sourceColumn(row, 'source'),
        workspace: stringColumn(row, 'workspace') ?? '',
        sourcePath,
        mtime: numberColumn(row, 'source_mtime') ?? 0,
        size: numberColumn(row, 'source_size') ?? 0,
      })
    }
    return existing
  } catch {
    return undefined
  } finally {
    database?.close()
  }
}

/**
 * Write one index update.
 * @param plan - sessions to write, sessions to drop, and how to place the result.
 * @returns what the index holds after the write.
 */
export function writeIndex(plan: IndexWritePlan): IndexWriteResult {
  mkdirSync(dirname(plan.indexPath), { recursive: true })
  if (plan.force) {
    const temporaryPath = `${plan.indexPath}.tmp`
    removeDatabaseFiles(temporaryPath)
    const database = new DatabaseSync(temporaryPath)
    try {
      createSchema(database)
      writeAll(database, plan)
    } catch (error) {
      database.close()
      removeDatabaseFiles(temporaryPath)
      throw error
    }
    database.close()
    renameSync(temporaryPath, plan.indexPath)
    const summary = summarize(plan.indexPath)
    writeStatusFile(plan.indexPath, plan.indexedAt, summary)
    return summary
  }

  const database = new DatabaseSync(plan.indexPath)
  try {
    createSchema(database)
    writeAll(database, plan)
  } finally {
    database.close()
  }
  const summary = summarize(plan.indexPath)
  writeStatusFile(plan.indexPath, plan.indexedAt, summary)
  return summary
}

/**
 * Create every table and index the shared schema declares.
 * @param database - open index database.
 */
function createSchema(database: DatabaseSync): void {
  for (const statement of SCHEMA_STATEMENTS) database.exec(statement)
}

/**
 * Write the sidecar summary the prompt-assembly path reads.
 *
 * Written only after the index transaction committed and the file is in place, through a temporary
 * file and a rename: a reader polling the sidecar sees either the previous run's complete JSON or
 * this run's, never a half-written one.
 * @param indexPath - absolute path of the written index.
 * @param indexedAt - epoch milliseconds of this run.
 * @param summary - totals the index now holds.
 */
function writeStatusFile(indexPath: string, indexedAt: number, summary: IndexWriteResult): void {
  const statusPath = join(dirname(indexPath), STATUS_RELATIVE_PATH)
  const temporaryPath = `${statusPath}.tmp`
  const document = {
    schemaVersion: SCHEMA_VERSION,
    indexedAt,
    sessions: summary.sessions,
    entries: summary.entries,
    workspaces: summary.workspaces,
    bytes: summary.bytes,
  }
  writeFileSync(temporaryPath, `${JSON.stringify(document)}\n`)
  renameSync(temporaryPath, statusPath)
}

/**
 * Apply the plan inside one transaction.
 * @param database - open index database.
 * @param plan - what to write.
 */
function writeAll(database: DatabaseSync, plan: IndexWritePlan): void {
  // Only a rebuild seeds itself from the previous index. An incremental run writes into the live
  // database, which is the same file a preserved copy would be attached from, so there is nothing to
  // copy and attaching it would lock the connection against its own transaction.
  const preserve = plan.force && plan.preserveExisting && existsSync(plan.indexPath)
  if (preserve) database.exec(`ATTACH DATABASE '${escapeSqlLiteral(plan.indexPath)}' AS existing`)
  try {
    database.exec('BEGIN IMMEDIATE')
    try {
      if (preserve) copyExisting(database)

      const removeFts = database.prepare(
        `DELETE FROM ${ENTRY_FTS_TABLE} WHERE rowid IN (SELECT id FROM ${ENTRY_TABLE} WHERE session_id = ?)`,
      )
      const removeEntries = database.prepare(`DELETE FROM ${ENTRY_TABLE} WHERE session_id = ?`)
      const removeSession = database.prepare(`DELETE FROM ${SESSION_TABLE} WHERE id = ?`)
      for (const id of plan.removed) {
        removeFts.run(id)
        removeEntries.run(id)
        removeSession.run(id)
      }

      const removeFtsForSource = database.prepare(
        `DELETE FROM ${ENTRY_FTS_TABLE} WHERE rowid IN (SELECT id FROM ${ENTRY_TABLE}
          WHERE session_id IN (SELECT id FROM ${SESSION_TABLE} WHERE id = ? OR source_path = ?))`,
      )
      const removeEntriesForSource = database.prepare(
        `DELETE FROM ${ENTRY_TABLE}
          WHERE session_id IN (SELECT id FROM ${SESSION_TABLE} WHERE id = ? OR source_path = ?)`,
      )
      const removeSessionForSource = database.prepare(`DELETE FROM ${SESSION_TABLE} WHERE id = ? OR source_path = ?`)
      const insertSession = database.prepare(
        `INSERT INTO ${SESSION_TABLE}
          (id, source, workspace, title, created_at, last_at, parent_session, origin, agent_preset, turns, entries,
           source_path, source_mtime, source_size)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      const insertEntry = database.prepare(
        `INSERT INTO ${ENTRY_TABLE} (session_id, seq, time, turn, kind, text, clipped) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      const insertFts = database.prepare(`INSERT INTO ${ENTRY_FTS_TABLE} (rowid, tokens) VALUES (?, ?)`)

      for (const item of plan.sessions) {
        const { session, source, sourcePath, mtime, size } = item
        // Keyed by id AND source path: a session whose id changed between runs must not leave its
        // old row behind, and the source path is the stable half of the pair.
        removeFtsForSource.run(session.id, sourcePath)
        removeEntriesForSource.run(session.id, sourcePath)
        removeSessionForSource.run(session.id, sourcePath)

        insertSession.run(
          session.id,
          source,
          session.cwd,
          session.title ?? null,
          session.createdAt,
          session.lastAt,
          session.parentSession ?? null,
          session.origin ?? null,
          session.agentPreset ?? null,
          session.turns,
          session.entries.length,
          sourcePath,
          mtime,
          size,
        )
        for (const entry of session.entries) {
          const result = insertEntry.run(
            session.id,
            entry.seq,
            entry.time,
            entry.turn ?? null,
            entry.kind,
            entry.text,
            entry.clipped ? 1 : 0,
          )
          insertFts.run(Number(result.lastInsertRowid), tokenize(entry.text).join(' '))
        }
      }

      const upsertMeta = database.prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      upsertMeta.run(META_SCHEMA_VERSION, String(SCHEMA_VERSION))
      upsertMeta.run(META_INDEXED_AT, String(plan.indexedAt))
      upsertMeta.run(META_DISCOVERED, String(plan.discovered))
      upsertMeta.run(META_FAILED, String(plan.failed))

      database.exec('COMMIT')
    } catch (error) {
      rollback(database)
      throw error
    }
  } finally {
    if (preserve) {
      try {
        database.exec('DETACH DATABASE existing')
      } catch {
        // The connection is about to close; a failed detach cannot corrupt the committed index.
      }
    }
  }
}

/**
 * Copy the previous index's rows into a scoped rebuild.
 * @param database - the temporary database, with the previous index attached as `existing`.
 */
function copyExisting(database: DatabaseSync): void {
  database.exec(`INSERT INTO ${SESSION_TABLE} SELECT * FROM existing.${SESSION_TABLE}`)
  database.exec(`INSERT INTO ${ENTRY_TABLE} SELECT * FROM existing.${ENTRY_TABLE}`)
  database.exec(`INSERT INTO ${ENTRY_FTS_TABLE} (rowid, tokens) SELECT rowid, tokens FROM existing.${ENTRY_FTS_TABLE}`)
}

/**
 * Count what the index now holds and measure it.
 *
 * `entries` is the index's total, not this run's writes: it is reported beside `sessions`,
 * `workspaces` and `bytes`, which are all post-run totals, and a caller reading the report is
 * asking what the index now contains. What this run changed is already in
 * `added`/`updated`/`skipped`/`removed`.
 * @param indexPath - absolute path of the written index.
 * @returns the totals the report carries.
 */
function summarize(indexPath: string): IndexWriteResult {
  const database = new DatabaseSync(indexPath, { readOnly: true })
  try {
    const sessions = count(database, `SELECT COUNT(*) AS n FROM ${SESSION_TABLE}`)
    const entries = count(database, `SELECT COUNT(*) AS n FROM ${ENTRY_TABLE}`)
    const workspaces = count(database, `SELECT COUNT(DISTINCT workspace) AS n FROM ${SESSION_TABLE}`)
    return { entries, sessions, workspaces, bytes: statSync(indexPath).size }
  } finally {
    database.close()
  }
}

/**
 * Run a counting query.
 * @param database - open index database.
 * @param sql - query returning one `n` column.
 * @returns the count.
 */
function count(database: DatabaseSync, sql: string): number {
  const row = database.prepare(sql).get()
  return row === undefined ? 0 : (numberColumn(row, 'n') ?? 0)
}

/**
 * Roll a transaction back without masking the error that caused it.
 * @param database - open index database.
 */
function rollback(database: DatabaseSync): void {
  try {
    database.exec('ROLLBACK')
  } catch {
    // The transaction was already resolved; the caller rethrows the original failure.
  }
}

/**
 * Delete an index file and any journal/WAL siblings a previous run left behind.
 * @param path - index file path.
 */
function removeDatabaseFiles(path: string): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true })
}

/**
 * Quote a value for inlining into a statement SQLite will not bind a parameter to (`ATTACH`).
 * @param value - raw string.
 * @returns the single-quoted literal.
 */
function escapeSqlLiteral(value: string): string {
  return value.replaceAll("'", "''")
}

/**
 * Read a string column from a prototype-less SQLite row.
 * @param row - result row.
 * @param key - column name.
 * @returns the string, or undefined.
 */
function stringColumn(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Read one source column, refusing a value this build does not know.
 * @param row - result row.
 * @param key - column name.
 * @returns the recorded source, or `dsh` for a row written before the column existed.
 */
function sourceColumn(row: Record<string, unknown>, key: string): SessiongraphSource {
  const value = stringColumn(row, key)
  const known = (SESSIONGRAPH_SOURCES as readonly string[]).includes(value ?? '')
  return known ? (value as SessiongraphSource) : 'dsh'
}

/**
 * Read a numeric column from a prototype-less SQLite row.
 * @param row - result row.
 * @param key - column name.
 * @returns the number, or undefined.
 */
function numberColumn(row: Record<string, unknown>, key: string): number | undefined {
  const value = row[key]
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return undefined
}
