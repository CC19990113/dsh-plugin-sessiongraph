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

describe('acquireIndexLock', () => {
  it('creates the lock file and removes it on release', async () => {
    const release = await acquireIndexLock(root)
    const lockPath = join(root, LOCK_FILE_NAME)
    expect((await stat(lockPath)).isFile()).toBe(true)
    // The pid is written so a stuck lock can be traced to a process.
    expect((await readFile(lockPath, 'utf8')).trim()).toBe(String(process.pid))
    release()
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
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

    await new Promise(resolve => setTimeout(resolve, 150))
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
    // Simulate a crash: the file stays, but its owner is long gone.
    const lockPath = join(root, LOCK_FILE_NAME)
    await writeFile(lockPath, '99999\n')
    const past = new Date(Date.now() - 10 * 60 * 1000)
    await utimes(lockPath, past, past)

    const release = await acquireIndexLock(root, { timeoutMs: 1_000, staleMs: 60_000 })
    release()
  })

  it('creates the index root when it does not exist yet', async () => {
    const nested = join(root, 'does', 'not', 'exist')
    const release = await acquireIndexLock(nested)
    expect((await stat(join(nested, LOCK_FILE_NAME))).isFile()).toBe(true)
    release()
  })
})
