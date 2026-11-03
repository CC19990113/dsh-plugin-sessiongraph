/**
 * Connection ownership for the local-conversation index: where an index root's database lives, the
 * schema-version gate every connection passes before serving a query, and the bounded pool that
 * keeps recently queried roots open.
 *
 * The indexer writes `<indexRoot>/index.db` under a temp name and renames it into place, so a reader
 * always sees a complete file. This store still opens READ-ONLY and never repairs, migrates, or
 * writes anything: an index it cannot read is reported as corrupt rather than silently treated as
 * empty, because "no match" and "cannot answer" must never look the same to the model.
 * @module dsh-plugin-sessiongraph-sqlite/database
 */

import { statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  INDEX_RELATIVE_PATH,
  META_SCHEMA_VERSION,
  SCHEMA_VERSION,
  SessiongraphError,
} from 'dsh-plugin-sessiongraph-service'

/**
 * The absolute path of an index root's database.
 * @param indexRoot - directory the seam routed a request to.
 * @returns the database path, whether or not it exists.
 */
export function databasePath(indexRoot: string): string {
  return join(indexRoot, INDEX_RELATIVE_PATH)
}

/**
 * Whether an index root holds an index at all.
 *
 * A synchronous `stat` is deliberate: the seam asks every registered store this question on every
 * query, so the probe must not open a database, parse a header, or touch SQLite. Existence is the
 * claim; whether the file is readable is decided later, by {@link openIndex}, which fails loud.
 * @param indexRoot - directory the seam routed a request to.
 * @returns true when `<indexRoot>/index.db` exists as a regular file.
 */
export function indexExists(indexRoot: string): boolean {
  try {
    return statSync(databasePath(indexRoot)).isFile()
  } catch {
    // Only the existence probe runs in the try. A missing file, a missing directory, or no
    // permission to look all mean the same thing to the seam: this store cannot serve the root.
    return false
  }
}

/**
 * Read the schema version stamped into an open index.
 * @param db - an open connection.
 * @returns the recorded version.
 * @throws SessiongraphError with code `SESSIONGRAPH_CORRUPT` when the row is missing or not an
 * integer, because such a file cannot be read through this code's assumptions.
 */
function readSchemaVersion(db: DatabaseSync): number {
  let row: Record<string, unknown> | undefined
  try {
    row = db.prepare('SELECT value FROM meta WHERE key = ?').get(META_SCHEMA_VERSION) as
      | Record<string, unknown>
      | undefined
  } catch (cause) {
    // A file that is not SQLite at all throws here rather than in the constructor (SQLite opens
    // lazily and only validates the header on first read). That is still a corrupt index, not an
    // unavailable one: `indexes()` already told the seam the file is there.
    throw new SessiongraphError(
      `the session-graph index is not a readable SQLite database (${describe(cause)})`,
      'SESSIONGRAPH_CORRUPT',
    )
  }
  const raw = row?.['value']
  const version = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN
  if (!Number.isInteger(version)) {
    throw new SessiongraphError('the session-graph index records no readable schema version', 'SESSIONGRAPH_CORRUPT')
  }
  return version
}

/**
 * Open one index root's database read-only and verify its schema version.
 * @param indexRoot - directory the seam routed a request to.
 * @returns the open, version-checked connection; the caller owns closing it.
 * @throws SessiongraphError with code `SESSIONGRAPH_CORRUPT` when the file cannot be opened, is not
 * SQLite, or was written at another schema version. Never returns an empty database as a stand-in:
 * a silent empty result would be indistinguishable from "no such conversation".
 */
export function openIndex(indexRoot: string): DatabaseSync {
  const path = databasePath(indexRoot)
  let db: DatabaseSync
  try {
    db = new DatabaseSync(path, { readOnly: true })
  } catch (cause) {
    throw new SessiongraphError(
      `cannot open the session-graph index at "${path}" (${describe(cause)})`,
      'SESSIONGRAPH_CORRUPT',
    )
  }
  let version: number
  try {
    version = readSchemaVersion(db)
  } catch (error) {
    closeQuietly(db)
    throw error
  }
  if (version !== SCHEMA_VERSION) {
    closeQuietly(db)
    throw new SessiongraphError(
      `the session-graph index at "${path}" is schema version ${version}; this store reads version ${SCHEMA_VERSION}`,
      'SESSIONGRAPH_CORRUPT',
    )
  }
  return db
}

/** Close without letting a secondary failure mask the error already being reported. */
function closeQuietly(db: DatabaseSync): void {
  try {
    db.close()
  } catch {
    // The connection is being abandoned because it is unusable; a close failure changes nothing.
  }
}

/** One diagnostic line from a caught value, without assuming it is an Error. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * The device and inode a path currently resolves to — cheap, filesystem-level proof that two opens
 * of the same path did or didn't land on the same underlying file. `ino` alone is only unique within
 * one device, so both are required.
 */
interface FileIdentity {
  readonly dev: number
  readonly ino: number
}

/**
 * A path's current on-disk identity, or `undefined` when it cannot be stat'd (most commonly: an
 * indexing run's atomic replace is between removing the old file and renaming the new one into
 * place). That absence is treated as "unknown, not gone" by every caller — a transient rebuild
 * window must never look like a missing index.
 * @param path - the file to identify.
 */
function identify(path: string): FileIdentity | undefined {
  try {
    const stats = statSync(path)
    return { dev: stats.dev, ino: stats.ino }
  } catch {
    return undefined
  }
}

/** Whether two identities name the same underlying file. */
function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

/** A pooled connection alongside the on-disk identity it was opened against. */
interface PooledConnection {
  readonly db: DatabaseSync
  readonly identity: FileIdentity
}

/**
 * A bounded set of open index connections keyed by index root, evicting the least recently used one
 * when full. Every connection the pool hands out stays valid until {@link close}: eviction and
 * disposal both close connections, so a caller holds a connection only for the duration of one
 * synchronous query.
 *
 * A connection is opened against one specific on-disk file. The indexer replaces that file wholesale
 * (rename over the old path), and POSIX unlink semantics mean an already-open read-only connection
 * keeps serving the REPLACED file's bytes indefinitely — reopening is the only way to see the new
 * index. `acquire` detects that swap by comparing the device/inode recorded at open time against the
 * path's current identity, so a cache hit never silently serves an index an indexing run has already
 * superseded.
 */
export class IndexPool {
  private readonly open = new Map<string, PooledConnection>()
  private disposed = false

  /**
   * @param capacity - largest number of simultaneously open indexes; at least 1.
   */
  constructor(private readonly capacity: number) {}

  /**
   * The connection for an index root, opening and caching it on first use. Reopens automatically
   * when the file on disk is no longer the one the cached connection was opened against.
   * @param indexRoot - directory the seam routed a request to.
   * @returns the open, version-checked connection, current as of this call.
   */
  acquire(indexRoot: string): DatabaseSync {
    if (this.disposed) {
      throw new SessiongraphError('the session-graph store is disposed', 'SESSIONGRAPH_UNAVAILABLE')
    }
    const cached = this.open.get(indexRoot)
    if (cached !== undefined) {
      const current = identify(databasePath(indexRoot))
      // `undefined` means the path is transiently unstatable — most likely an indexing run's replace
      // is mid-flight between removing the old file and renaming the new one into place. Keep serving
      // the connection we have rather than treating a rebuild-in-progress as a missing index.
      if (current === undefined || sameIdentity(current, cached.identity)) {
        // Re-insert to mark most recently used; Map iteration order is insertion order.
        this.open.delete(indexRoot)
        this.open.set(indexRoot, cached)
        return cached.db
      }
      cached.db.close()
      this.open.delete(indexRoot)
    }
    const db = openIndex(indexRoot)
    const identity = identify(databasePath(indexRoot))
    // Only `undefined` when the file vanishes in the instant between opening it and this stat — an
    // unprovokable race in tests. The sentinel never matches a real identity, so the next acquire()
    // is forced to re-verify rather than trusting an unconfirmed connection indefinitely.
    /* v8 ignore next */
    this.open.set(indexRoot, { db, identity: identity ?? { dev: -1, ino: -1 } })
    this.evictOverflow()
    return db
  }

  /** Close every open connection; further {@link acquire} calls fail as `SESSIONGRAPH_UNAVAILABLE`. */
  close(): void {
    this.disposed = true
    for (const { db } of this.open.values()) db.close()
    this.open.clear()
  }

  /** Close least-recently-used connections until the pool fits its capacity. */
  private evictOverflow(): void {
    while (this.open.size > this.capacity) {
      // Map iteration starts at the least recently used entry, and `acquire` re-inserts on a hit,
      // so the first entry is always the eviction candidate.
      for (const [root, entry] of this.open) {
        entry.db.close()
        this.open.delete(root)
        break
      }
    }
  }
}
