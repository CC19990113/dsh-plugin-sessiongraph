/**
 * One writer at a time per index root, across processes.
 *
 * Why this exists: the same `index.db` is written by two engines (the TypeScript one through
 * `node:sqlite`, the Rust one through bundled rusqlite) and reached by three triggers (the
 * `agent/created` background run, the lazy refresh before a query, and an explicit index operation
 * — the `sessiongraph` tool's `index`). Nothing in SQLite serializes two writers that open the file
 * independently, and the failure mode is not a clean lock conflict — it is a corpus that later
 * reports `database disk image is malformed` and has to be rebuilt from scratch. A lock file turns
 * that into a short wait.
 *
 * The protocol is deliberately more than "create a file, delete a file":
 *
 * - The lock holds the owner's {@link LockOwner} record — `${pid} ${token}`, the token being a
 *   per-acquisition `randomUUID`. A release only removes the lock while that token is still the one
 *   in the file, so a writer whose lease was already broken and re-taken cannot delete the *new*
 *   holder's lock and become a second concurrent writer.
 * - Whether an existing lock is abandoned is decided by the owner's liveness (`process.kill(pid, 0)`)
 *   before its age: a live pid means a slow run, not a crash, and breaking a live run's lock is how
 *   two writers ended up on one index. Age alone is only the fallback, plus a hard ceiling for a
 *   live pid — past {@link HARD_STALE_LOCK_MS} the pid is presumed reused by an unrelated process.
 * - Two runs inside *one* process cannot arbitrate through the file at all: the holder's pid is our
 *   own, so the liveness probe correctly refuses to break it and the second run would spend the
 *   whole timeout polling. Writers therefore queue on an in-process FIFO per root first.
 * @module dsh-plugin-sessiongraph-sessions/lock
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** File name of the lock inside an index root. */
export const LOCK_FILE_NAME = 'index.lock'

/** How long a lock whose owner cannot be probed may sit untouched before it counts as abandoned. */
export const STALE_LOCK_MS = 5 * 60 * 1000

/** How long a lock may be held by a *live* pid before its owner is presumed a reused pid. */
export const HARD_STALE_LOCK_MS = 60 * 60 * 1000

/** How long a writer waits for the lock before giving up. */
export const LOCK_TIMEOUT_MS = 2 * 60 * 1000

/** Polling interval while another writer holds the lock. */
const POLL_MS = 100

/** Options for {@link acquireIndexLock}, all overridable so tests do not wait minutes. */
export interface IndexLockOptions {
  /** Give up after this long. */
  timeoutMs?: number
  /** Treat a lock whose owner cannot be probed as abandoned once it is older than this. */
  staleMs?: number
  /** Treat even a lock with a live owner as abandoned once it is older than this. */
  hardStaleMs?: number
}

/** What a lock file says about the writer that created it. */
interface LockOwner {
  /** Process id of the writer, always present in a readable lock. */
  readonly pid: number
  /** Per-acquisition token; absent only in the older `${pid}`-only format. */
  readonly token?: string
}

/**
 * Serialized in-process writers, one promise chain per index root.
 *
 * This is not an optimisation. A lock held by *this* process has this process's pid, so the liveness
 * probe below is right to keep it — and a second run in the same process would then wait out the full
 * timeout and fail, which on a slow run means every call made meanwhile fails too. Queueing on a
 * promise makes the same-process case a plain serialization.
 */
const localTurns = new Map<string, Promise<void>>()

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
  const hardStaleMs = options.hardStaleMs ?? HARD_STALE_LOCK_MS
  const lockPath = join(indexRoot, LOCK_FILE_NAME)
  // The index root may not exist yet — a first build creates it, and creating the lock is what has
  // to happen first.
  await mkdir(indexRoot, { recursive: true })
  const deadline = Date.now() + timeoutMs
  // Same-process writers wait for each other here, before touching the filesystem.
  const releaseTurn = await acquireLocalTurn(indexRoot, lockPath, deadline, timeoutMs)
  const token = randomUUID()
  try {
    for (;;) {
      const handle = await open(lockPath, 'wx').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'EEXIST') return undefined
        throw error
      })
      if (handle !== undefined) {
        try {
          await handle.writeFile(`${process.pid} ${token}\n`, 'utf8')
        } catch (error) {
          // A lock whose owner record never landed blocks everyone until a staleness window reclaims
          // it, so do not leave one behind.
          await handle.close().catch(() => {})
          await rm(lockPath, { force: true }).catch(() => {})
          throw error
        }
        await handle.close()
        let released = false
        return () => {
          if (released) return
          released = true
          releaseLock(lockPath, token)
          releaseTurn()
        }
      }
      await breakStaleLock(lockPath, staleMs, hardStaleMs)
      if (Date.now() > deadline) throw timedOutError(lockPath, timeoutMs)
      await sleep(POLL_MS)
    }
  } catch (error) {
    releaseTurn()
    throw error
  }
}

/**
 * Wait for this root's turn among writers in this process.
 *
 * @param indexRoot - the index root the turn belongs to.
 * @param lockPath - the lock file, for the timeout message.
 * @param deadline - epoch milliseconds this writer may wait until.
 * @param timeoutMs - the configured timeout, for the timeout message.
 * @returns a release function; calling it more than once is safe.
 * @throws when the predecessor does not finish before the deadline.
 */
async function acquireLocalTurn(
  indexRoot: string,
  lockPath: string,
  deadline: number,
  timeoutMs: number,
): Promise<() => void> {
  const previous = localTurns.get(indexRoot) ?? Promise.resolve()
  let releaseSlot = (): void => {}
  const slot = new Promise<void>(resolve => {
    releaseSlot = resolve
  })
  // A predecessor that failed must still pass the turn on, or one bad run would wedge the root.
  const tail = previous.then(() => slot, () => slot)
  localTurns.set(indexRoot, tail)
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(timedOutError(lockPath, timeoutMs))
      }, Math.max(0, deadline - Date.now()))
      timer.unref?.()
      previous.then(
        () => {
          clearTimeout(timer)
          resolve()
        },
        () => {
          clearTimeout(timer)
          resolve()
        },
      )
    })
  } catch (error) {
    // Give the turn away before leaving: a waiter that never had it cannot hold it.
    releaseSlot()
    if (localTurns.get(indexRoot) === tail) localTurns.delete(indexRoot)
    throw error
  }
  let released = false
  return () => {
    if (released) return
    released = true
    releaseSlot()
    // Only drop the entry while it is still ours; a newer waiter has already replaced it otherwise.
    if (localTurns.get(indexRoot) === tail) localTurns.delete(indexRoot)
  }
}

/**
 * Remove the lock, but only while it still belongs to this writer.
 *
 * Unconditional removal is what let a run whose lease had already been broken delete the new
 * holder's lock and write concurrently with it. The stale windows are the backstop for a lock this
 * cannot prove ownership of.
 * @param lockPath - the lock file.
 * @param token - this acquisition's token.
 */
function releaseLock(lockPath: string, token: string): void {
  try {
    // Synchronous on purpose: a disposer returning a promise can be dropped by a `finally` on an
    // async path that is already unwinding, and a leaked lock blocks every later writer until the
    // staleness window reclaims it.
    const owner = parseLockFile(readFileSync(lockPath, 'utf8'))
    if (owner?.token !== token) return
    rmSync(lockPath, { force: true })
  } catch {
    // Missing (already gone) or unreadable: nothing here is provably ours, so leave it alone. The
    // staleness windows reclaim it, and throwing from a release would mask the run's own error.
  }
}

/**
 * Remove the lock if its owner is presumed dead or its age has outlived its welcome.
 *
 * Liveness comes first. A lock whose owner is alive is a slow run, and breaking it is precisely how
 * two writers end up on one index; age is consulted only when the owner cannot be probed, plus a
 * hard ceiling on a live pid because a crash-and-restart can hand that pid to an unrelated process.
 * @param lockPath - the lock file.
 * @param staleMs - age past which an unprobeable lock counts as abandoned.
 * @param hardStaleMs - age past which even a live owner's lock counts as abandoned.
 */
async function breakStaleLock(lockPath: string, staleMs: number, hardStaleMs: number): Promise<void> {
  let content: string
  let mtimeMs: number
  try {
    const [text, info] = await Promise.all([readFile(lockPath, 'utf8'), stat(lockPath)])
    content = text
    mtimeMs = info.mtimeMs
  } catch {
    // The holder released it between our failed create and this read; the next iteration wins.
    return
  }
  const age = Date.now() - mtimeMs
  const owner = parseLockFile(content)
  if (owner !== undefined) {
    const state = probeOwner(owner.pid)
    if (state === 'dead') {
      // A dead owner's lock is abandoned regardless of age: waiting for the window would only cost
      // every caller that time.
      await removeIfUnchanged(lockPath, content)
      return
    }
    if (state === 'alive') {
      if (age > hardStaleMs) await removeIfUnchanged(lockPath, content)
      return
    }
  }
  // No usable owner record, or a pid whose state cannot be determined: fall back to age alone.
  if (age > staleMs) await removeIfUnchanged(lockPath, content)
}

/**
 * Probe whether a pid is still running.
 *
 * @param pid - the pid recorded in the lock.
 * @returns `'alive'`, `'dead'`, or `'unknown'` when the probe itself failed for another reason.
 */
function probeOwner(pid: number): 'alive' | 'dead' | 'unknown' {
  try {
    // Signal 0 runs the existence and permission checks without delivering anything.
    process.kill(pid, 0)
    return 'alive'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // EPERM means the process exists and belongs to someone else — alive, not gone.
    if (code === 'EPERM') return 'alive'
    if (code === 'ESRCH') return 'dead'
    return 'unknown'
  }
}

/**
 * Parse a lock file's owner record.
 * @param content - raw lock file text.
 * @returns the owner, or `undefined` when the content is not a usable record — the caller then falls
 *   back to the age rule.
 */
function parseLockFile(content: string): LockOwner | undefined {
  const [pidField, tokenField] = content.trim().split(/\s+/)
  const pid = Number.parseInt(pidField ?? '', 10)
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  return tokenField === undefined || tokenField === '' ? { pid } : { pid, token: tokenField }
}

/**
 * Remove the lock only if it still holds the content the judgement was made about.
 * @param lockPath - the lock file.
 * @param expected - the content that was judged abandoned.
 */
async function removeIfUnchanged(lockPath: string, expected: string): Promise<void> {
  try {
    const current = await readFile(lockPath, 'utf8')
    if (current !== expected) return
    await rm(lockPath, { force: true })
  } catch {
    // Gone, or replaced between the judgement and the removal; the next iteration re-reads it.
  }
}

/**
 * The one error both waits produce, so a caller cannot tell (or care) which wait ran out.
 * @param lockPath - the lock file that stayed taken.
 * @param timeoutMs - the configured timeout.
 * @returns the error to reject with.
 */
function timedOutError(lockPath: string, timeoutMs: number): Error {
  return new Error(`sessiongraph: timed out after ${timeoutMs}ms waiting for the index write lock at "${lockPath}"`)
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
