/**
 * The on-disk schema both providers agree on. The indexer writes it; the store reads it. It lives in
 * the seam package precisely so neither provider can drift from the other without editing this file.
 *
 * The format is ours to evolve: `SCHEMA_VERSION` is stamped into `meta`, and a store refuses a file
 * whose version it does not know rather than guessing at a shape. That is deliberately stricter than
 * "read whatever is there" — a mismatch must surface as a loud {@link SessiongraphError}, not as a
 * silently empty result that looks like "no match".
 * @module dsh-plugin-sessiongraph-service/schema
 */

/**
 * Current on-disk schema version. Bump on any change to {@link SCHEMA_STATEMENTS}.
 *
 * v2 stores the FTS index contentless (`content=''`): FTS5's default build keeps a copy of every
 * indexed column in a `_content` shadow table, which on a real corpus was 67MB of a 174MB file
 * holding a token stream that can always be recomputed from `entry.text`.
 *
 * v3 records which harness wrote a session (`session.source`). The first version indexed only DSH's
 * own logs, so the column is absent rather than defaulted; a v3 row carries `'dsh'` or `'codex'` and
 * a store that cannot name the origin refuses the file instead of labelling every hit "dsh".
 */
export const SCHEMA_VERSION = 3

/** Relative path of the index file inside an index root. */
export const INDEX_RELATIVE_PATH = 'index.db'

/** One session, keyed by its harness session id. */
export const SESSION_TABLE = 'session'

/** One searchable entry inside a session. */
export const ENTRY_TABLE = 'entry'

/** The FTS5 virtual table over `entry`, with `entry.id` as its `rowid`. */
export const ENTRY_FTS_TABLE = 'entry_fts'

/**
 * Every statement needed to create an index from nothing, in dependency order.
 *
 * `entry_fts` is a **contentless** FTS5 table (`content=''`): it stores only the inverted index for
 * the bigram token stream, keyed by `entry.id`. The default build keeps a `_content` shadow table
 * holding a second copy of that stream — 67MB of a 174MB file on a real corpus, for data that can
 * always be recomputed from `entry.text`.
 *
 * `contentless_delete=1` (SQLite 3.43+) is what makes that affordable: without it a contentless
 * table cannot be maintained with plain `DELETE FROM`, and every removed session would need the old
 * token values fed back through FTS5's `delete` command.
 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS ${SESSION_TABLE} (
     id TEXT PRIMARY KEY,
     source TEXT NOT NULL,
     workspace TEXT NOT NULL,
     title TEXT,
     created_at INTEGER NOT NULL,
     last_at INTEGER NOT NULL,
     parent_session TEXT,
     origin TEXT,
     agent_preset TEXT,
     turns INTEGER NOT NULL DEFAULT 0,
     entries INTEGER NOT NULL DEFAULT 0,
     source_path TEXT NOT NULL,
     source_mtime INTEGER NOT NULL,
     source_size INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS ${ENTRY_TABLE} (
     id INTEGER PRIMARY KEY,
     session_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     time INTEGER NOT NULL,
     turn INTEGER,
     kind TEXT NOT NULL,
     text TEXT NOT NULL,
     clipped INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS idx_entry_session ON ${ENTRY_TABLE} (session_id, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_session_last ON ${SESSION_TABLE} (last_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_session_workspace ON ${SESSION_TABLE} (workspace, last_at DESC)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS ${ENTRY_FTS_TABLE} USING fts5(
     tokens,
     content = '',
     contentless_delete = 1,
     tokenize = 'unicode61 remove_diacritics 0'
   )`,
]

/** `meta` keys the store and the indexer exchange through the file. */
export const META_SCHEMA_VERSION = 'schema_version'
/** Epoch milliseconds of the last completed index run. */
export const META_INDEXED_AT = 'indexed_at'
/** Number of source sessions the last run discovered. */
export const META_DISCOVERED = 'discovered'
/** Number of source sessions the last run could not parse. */
export const META_FAILED = 'failed'
