/**
 * One writer at a time per index root, across processes.
 *
 * Why this exists: the same `index.db` is written by two engines (the TypeScript one through
 * `node:sqlite`, the Rust one through bundled rusqlite) and reached by three triggers (the
 * `agent/created` background job, the lazy refresh before a query, and an explicit
 * `sessiongraph_index`). Nothing in SQLite serializes two writers that open the file
 * independently, and the failure mode is not a clean lock conflict — it is a corpus that later
 * reports `database disk image is malformed` and has to be rebuilt from scratch. A lock file turns
 * that into a short wait.
 *
 * The lock is a file created with `wx` (exclusive create): the winner writes its pid and proceeds,
 * the losers poll until it disappears. A crash leaves the file behind, so a lock older than
 * {@link STALE_LOCK_MS} is broken — the alternative is a permanently unusable index that only
 * deleting a file by hand can fix.
 * @module dsh-plugin-sessiongraph-sessions/lock
 */

import { rmSync } from 'node:fs'
import { mkdir, open, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** File name of the lock inside an index root. */
export const LOCK_FILE_NAME = 'index.lock'

/** How long a lock may sit untouched before another writer treats its owner as dead. */
export const STALE_LOCK_MS = 5 * 60 * 1000

/** How long a writer waits for the lock before giving up. */
export const LOCK_TIMEOUT_MS = 2 * 60 * 1000

/** Polling interval while another writer holds the lock. */
const POLL_MS = 100

/** Options for {@link acquireIndexLock}, all overridable so tests do not wait minutes. */
export interface IndexLockOptions {
  /** Give up after this long. */
  timeoutMs?: number
  /** Treat a lock older than this as abandoned. */
  staleMs?: number
}

/**
 * Acquire the write lock for one index root.
 *
 * @param indexRoot - directory holding the index the caller is about to write.
 * @param options - timeout and staleness overrides, for tests.
 * @returns a release function; calling it more than once is safe.
 * @throws when the lock cannot be taken before the timeout, so the caller can skip the run instead
 *   of writing concurrently.
 */
export async function acquireIndexLock(indexRoot: string, options: IndexLockOptions = {}): Promise<() => void> {
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS
  const staleMs = options.staleMs ?? STALE_LOCK_MS
  const lockPath = join(indexRoot, LOCK_FILE_NAME)
  // The index root may not exist yet — a first build creates it, and creating the lock is what has
  // to happen first.
  await mkdir(indexRoot, { recursive: true })
  const deadline = Date.now() + timeoutMs

  for (;;) {
    try {
      const handle = await open(lockPath, 'wx')
      try {
        await handle.writeFile(`${process.pid}\n`, 'utf8')
      } finally {
        await handle.close()
      }
      let released = false
      return () => {
        if (released) return
        released = true
        // Synchronous on purpose: a disposer returning a promise can be dropped by a `finally` on
        // an async path that is already unwinding, and a leaked lock blocks every later writer
        // until the staleness window reclaims it.
        try {
          rmSync(lockPath, { force: true })
        } catch {
          // A lock we cannot remove is bad, but throwing from a release would mask the run's own
          // error. The staleness window is the backstop.
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await breakStaleLock(lockPath, staleMs)
      if (Date.now() > deadline) {
        throw new Error(
          `sessiongraph: timed out after ${timeoutMs}ms waiting for the index write lock at "${lockPath}"`,
        )
      }
      await sleep(POLL_MS)
    }
  }
}

/**
 * Remove the lock if its owner is presumed dead.
 * @param lockPath - the lock file.
 * @param staleMs - age past which the lock counts as abandoned.
 */
async function breakStaleLock(lockPath: string, staleMs: number): Promise<void> {
  try {
    const info = await stat(lockPath)
    if (Date.now() - info.mtimeMs > staleMs) await rm(lockPath, { force: true })
  } catch {
    // The holder released it between our failed create and this stat; the next iteration wins.
  }
}

/**
 * Wait without keeping the process alive.
 * @param ms - milliseconds to sleep.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms).unref?.()
  })
}
