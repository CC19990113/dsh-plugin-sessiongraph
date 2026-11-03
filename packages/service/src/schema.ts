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

/** Current on-disk schema version. Bump on any change to {@link SCHEMA_STATEMENTS}. */
export const SCHEMA_VERSION = 1

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
 * `entry_fts` is an external-content-free FTS5 table: it stores only the bigram token stream and
 * keys rows by `entry.id`, so the entry text is never duplicated into the index. `content=''` would
 * also work, but the plain form keeps `delete`/`insert` symmetrical with one rowid.
 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS ${SESSION_TABLE} (
     id TEXT PRIMARY KEY,
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
