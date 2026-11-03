// A real session-graph index built in a temp directory, so every test runs against the on-disk
// schema the indexer writes rather than a stand-in: the store's SQL, its FTS5 bigram search, and its
// schema-version gate are all exercised exactly as they are against a real index file.
import { mkdirSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  META_INDEXED_AT,
  META_SCHEMA_VERSION,
  SCHEMA_STATEMENTS,
  SCHEMA_VERSION,
  tokenize,
} from 'dsh-plugin-sessiongraph-service'
import { databasePath } from '../src/database.ts'

/** One entry to seed; `text` is what gets indexed and searched. */
export interface SeedEntry {
  seq: number
  time: number
  turn?: number
  kind: 'user' | 'assistant' | 'tool' | 'title'
  text: string
  clipped?: boolean
}

/** One session to seed. `entries` are written in the order given. */
export interface SeedSession {
  id: string
  workspace: string
  title?: string
  createdAt?: number
  lastAt?: number
  parentSession?: string
  origin?: string
  agentPreset?: string
  turns?: number
  /** Source path to record; defaults to a real log path. Use `live://<id>` for a still-running session. */
  sourcePath?: string
  entries: SeedEntry[]
}

/** What one seeded index contains. */
export interface SeedIndex {
  sessions: SeedSession[]
  /** Schema version to record; defaults to the one this store supports. */
  schemaVersion?: number
  /** Epoch milliseconds to record as the last index run, when the test cares about `status`. */
  indexedAt?: number
}

/**
 * Write (or overwrite) an index at an existing root. Used both for a fresh temp directory and by
 * tests that need to replace an index file another connection already opened.
 * @param root - existing directory to write `<root>/index.db` into.
 * @param seed - the sessions to write.
 */
export function writeIndexAt(root: string, seed: SeedIndex): void {
  mkdirSync(root, { recursive: true })
  const path = databasePath(root)
  // A fresh file, distinct from whatever (if anything) was at this path before: the fixture's stand-in
  // for a real indexing run replacing the index, which is what a reload test needs to observe.
  rmSync(path, { force: true })
  rmSync(`${path}-wal`, { force: true })
  rmSync(`${path}-shm`, { force: true })
  const db = new DatabaseSync(path)
  for (const statement of SCHEMA_STATEMENTS) db.exec(statement)
  const insertMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
  insertMeta.run(META_SCHEMA_VERSION, String(seed.schemaVersion ?? SCHEMA_VERSION))
  if (seed.indexedAt !== undefined) insertMeta.run(META_INDEXED_AT, String(seed.indexedAt))

  const insertSession = db.prepare(`INSERT INTO session
    (id, workspace, title, created_at, last_at, parent_session, origin, agent_preset, turns, entries,
     source_path, source_mtime, source_size)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 100)`)
  const insertEntry = db.prepare(`INSERT INTO entry
    (session_id, seq, time, turn, kind, text, clipped)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
  const insertTokens = db.prepare('INSERT INTO entry_fts (rowid, tokens) VALUES (?, ?)')
  for (const session of seed.sessions) {
    insertSession.run(
      session.id,
      session.workspace,
      session.title ?? null,
      session.createdAt ?? 0,
      session.lastAt ?? 0,
      session.parentSession ?? null,
      session.origin ?? null,
      session.agentPreset ?? null,
      session.turns ?? 0,
      session.entries.length,
      session.sourcePath ?? `/sessions/${session.id}/session.v4.jsonl.zstd`,
    )
    for (const entry of session.entries) {
      const inserted = insertEntry.run(
        session.id,
        entry.seq,
        entry.time,
        entry.turn ?? null,
        entry.kind,
        entry.text,
        entry.clipped === true ? 1 : 0,
      )
      insertTokens.run(inserted.lastInsertRowid, tokenize(entry.text).join(' '))
    }
  }
  db.close()
}

/**
 * Create a temp directory holding one index.
 * @param seed - the sessions to write.
 * @returns the absolute index root.
 */
export async function seedIndex(seed: SeedIndex): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sessiongraph-'))
  writeIndexAt(root, seed)
  return root
}

/** Create an empty temp directory, for "no index here" cases. */
export async function emptyRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-sessiongraph-'))
}
