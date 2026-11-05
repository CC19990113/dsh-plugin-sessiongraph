import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireIndexLock, LOCK_FILE_NAME } from '../src/lock.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sessiongraph-lock-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** The lock file this test root would use. */
function lockPath(): string {
  return join(root, LOCK_FILE_NAME)
}

/** Age the lock file so the age-based rules can be exercised without waiting. */
async function ageLock(ms: number): Promise<void> {
  const past = new Date(Date.now() - ms)
  await utimes(lockPath(), past, past)
}

/** Wait a fixed span, for assertions that something must NOT have happened. */
async function settle(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('acquireIndexLock', () => {
  it('creates the lock file and removes it on release', async () => {
    const release = await acquireIndexLock(root)
    expect((await stat(lockPath())).isFile()).toBe(true)
    // The record is `${pid} ${token}`: the pid traces a stuck lock to a process, the token proves on
    // release that the lock is still this writer's.
    const fields = (await readFile(lockPath(), 'utf8')).trim().split(/\s+/)
    expect(fields).toHaveLength(2)
    expect(fields[0]).toBe(String(process.pid))
    expect(fields[1]).toMatch(/^[0-9a-f-]{36}$/)
    release()
    await expect(stat(lockPath())).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('is idempotent on release', async () => {
    const release = await acquireIndexLock(root)
    release()
    expect(() => release()).not.toThrow()
  })

  it('makes a second writer wait for the first', async () => {
    const first = await acquireIndexLock(root)
    let secondAcquired = false
    const second = acquireIndexLock(root, { timeoutMs: 5_000 }).then(release => {
      secondAcquired = true
      release()
    })

    await settle(150)
    expect(secondAcquired).toBe(false)

    first()
    await second
    expect(secondAcquired).toBe(true)
  })

  it('gives up after the timeout instead of writing concurrently', async () => {
    const release = await acquireIndexLock(root)
    await expect(acquireIndexLock(root, { timeoutMs: 150 })).rejects.toThrow(/timed out/)
    release()
  })

  it('breaks a lock left behind by a dead writer', async () => {
    // Simulate a crash: the file stays, but its owner is long gone. The age is irrelevant — a pid
    // that no longer exists is proof enough.
    await writeFile(lockPath(), `999999 ${randomUUID()}\n`)
    const release = await acquireIndexLock(root, { timeoutMs: 1_000, staleMs: 60_000 })
    release()
  })

  it('creates the index root when it does not exist yet', async () => {
    const nested = join(root, 'does', 'not', 'exist')
    const release = await acquireIndexLock(nested)
    expect((await stat(join(nested, LOCK_FILE_NAME))).isFile()).toBe(true)
    release()
  })

  it('never breaks a lock whose owner is still alive, however old it is', async () => {
    // A ten-minute run is a slow run, not a crash. Breaking a live writer's lock puts two engines on
    // one index — the corruption this file exists to prevent — so the waiting writer must time out
    // instead.
    await writeFile(lockPath(), `${process.pid} ${randomUUID()}\n`)
    await ageLock(10 * 60 * 1000)

    await expect(acquireIndexLock(root, { timeoutMs: 400, staleMs: 60_000 })).rejects.toThrow(/timed out/)
    // The live owner's lock is still there: a rejected waiter leaves nothing behind.
    expect((await readFile(lockPath(), 'utf8')).trim().split(/\s+/)[0]).toBe(String(process.pid))
  })

  it('breaks a live pid lock once it is older than the hard ceiling', async () => {
    // A crash plus a restart can hand the recorded pid to an unrelated process, so a live pid cannot
    // pin a lock forever.
    await writeFile(lockPath(), `${process.pid} ${randomUUID()}\n`)
    await ageLock(10 * 60 * 1000)

    const release = await acquireIndexLock(root, { timeoutMs: 2_000, staleMs: 60_000, hardStaleMs: 60_000 })
    release()
  })

  it('falls back to the age rule for a lock it cannot parse', async () => {
    await writeFile(lockPath(), 'not a lock record\n')
    await ageLock(10 * 60 * 1000)

    const release = await acquireIndexLock(root, { timeoutMs: 2_000, staleMs: 60_000 })
    release()
  })

  it('leaves a lock that belongs to another writer alone on release', async () => {
    // The old release removed the file unconditionally. A writer whose lease had already been broken
    // and re-taken then deleted the *new* holder's lock and became a second concurrent writer.
    const release = await acquireIndexLock(root)
    const other = `999999 ${randomUUID()}\n`
    await writeFile(lockPath(), other)

    release()

    expect(await readFile(lockPath(), 'utf8')).toBe(other)
  })

  it('queues a second writer in this process instead of polling its own pid away', async () => {
    const first = await acquireIndexLock(root, { timeoutMs: 5_000 })
    let secondAcquired = false
    const second = acquireIndexLock(root, { timeoutMs: 5_000 }).then(release => {
      secondAcquired = true
      release()
    })

    // Age the lock while the first writer still holds it: a waiting writer that polled the file would
    // break this stale-looking lock at the next poll. A queued one never looks.
    await ageLock(10 * 60 * 1000)
    await settle(250)
    expect(secondAcquired).toBe(false)

    first()
    await second
    expect(secondAcquired).toBe(true)
  })
})
