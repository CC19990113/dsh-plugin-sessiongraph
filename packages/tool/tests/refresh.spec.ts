/**
 * Lazy refresh tests: the decision is a flag on disk, the refresh is injected, and the guarantees are
 * "never blocks the answer" and "never runs twice at once".
 *
 * The fixtures are real temporary directories: the decision deliberately reads the same sidecar prompt
 * assembly reads, so mocking the filesystem would test a different thing than the shipped one.
 * @module dsh-plugin-sessiongraph-tool/tests/refresh
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessiongraphIndexReport } from 'dsh-plugin-sessiongraph-service'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LazyIndexRefresher } from '../src/refresh.ts'
import type { SynchronousIndexOptions } from '../src/refresh.ts'

/** Age the sidecar records, in milliseconds. */
const STALE = 600_000
/** Age that is comfortably inside the default threshold. */
const FRESH = 1_000
/** The threshold under test: five minutes. */
const THRESHOLD = 300_000

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sessiongraph-refresh-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

/** Create the index file, which is what makes a root refreshable in place. */
function writeIndexFile(): void {
  writeFileSync(join(root, 'index.db'), 'stub index')
}

/** Write the sidecar with an age relative to now. */
function writeStatus(ageMs: number): void {
  writeFileSync(join(root, 'status.json'), JSON.stringify({
    schemaVersion: 2,
    indexedAt: Date.now() - ageMs,
    sessions: 1,
    entries: 1,
    workspaces: 1,
    bytes: 100,
  }))
}

/** A finished report shaped like the one the sessions indexer returns. */
function report(): SessiongraphIndexReport {
  return {
    indexPath: join(root, 'index.db'),
    added: 0,
    updated: 0,
    skipped: 1,
    removed: 0,
    discovered: 1,
    failed: [],
    entries: 1,
    sessions: 1,
    workspaces: 1,
    bytes: 100,
    elapsedMs: 5,
  }
}

/** A deferred the test can resolve when it wants a run to finish. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** A refresher over {@link root} with an injected index runner. */
function refresher(
  index: (options: SynchronousIndexOptions) => Promise<unknown>,
  options: { threshold?: number; logError?: (message: string) => void } = {},
): LazyIndexRefresher {
  return new LazyIndexRefresher({
    indexRoot: root,
    freshnessThresholdMs: options.threshold ?? THRESHOLD,
    index,
    ...(options.logError === undefined ? {} : { logError: options.logError }),
  })
}

describe('LazyIndexRefresher', () => {
  it('does not refresh an index inside the threshold', async () => {
    writeIndexFile()
    writeStatus(FRESH)
    const calls: SynchronousIndexOptions[] = []
    const outcome = await refresher(async (options) => {
      calls.push(options)
      return report()
    }).ensureFresh()

    expect(calls).toHaveLength(0)
    expect(outcome).toEqual({ refreshed: false, stale: false })
  })

  it('refreshes once an index has aged past the threshold, synchronously', async () => {
    writeIndexFile()
    writeStatus(STALE)
    const calls: SynchronousIndexOptions[] = []
    const outcome = await refresher(async (options) => {
      calls.push(options)
      return report()
    }).ensureFresh()

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ force: false })
    expect(outcome).toEqual({ refreshed: true, stale: false })
  })

  it('treats exactly the threshold as stale', async () => {
    writeIndexFile()
    writeStatus(THRESHOLD)
    const calls: SynchronousIndexOptions[] = []
    await refresher(async (options) => {
      calls.push(options)
      return report()
    }).ensureFresh()
    expect(calls).toHaveLength(1)
  })

  it('refreshes an index that exists without a status record', async () => {
    writeIndexFile()
    const calls: SynchronousIndexOptions[] = []
    await refresher(async (options) => {
      calls.push(options)
      return report()
    }).ensureFresh()
    expect(calls).toHaveLength(1)
  })

  it('never builds an index from nothing — that belongs to sessiongraph_index', async () => {
    const calls: SynchronousIndexOptions[] = []
    const outcome = await refresher(async (options) => {
      calls.push(options)
      return report()
    }).ensureFresh()
    expect(calls).toHaveLength(0)
    expect(outcome).toEqual({ refreshed: false, stale: false })
  })

  it('never rebuilds from a status record whose index file is gone', async () => {
    writeStatus(STALE)
    const calls: SynchronousIndexOptions[] = []
    const outcome = await refresher(async (options) => {
      calls.push(options)
      return report()
    }).ensureFresh()
    expect(calls).toHaveLength(0)
    expect(outcome).toEqual({ refreshed: false, stale: false })
  })

  it('is disabled entirely by a zero threshold', async () => {
    writeIndexFile()
    writeStatus(STALE)
    const calls: SynchronousIndexOptions[] = []
    const outcome = await refresher(async (options) => {
      calls.push(options)
      return report()
    }, { threshold: 0 }).ensureFresh()
    expect(calls).toHaveLength(0)
    expect(outcome).toEqual({ refreshed: false, stale: false })
  })

  it('swallows a failed refresh, logs one line, and marks the answer stale', async () => {
    writeIndexFile()
    writeStatus(STALE)
    const logged: string[] = []
    const outcome = await refresher(async () => {
      throw new Error('indexer exploded')
    }, { logError: message => logged.push(message) }).ensureFresh()

    expect(outcome).toEqual({ refreshed: false, stale: true })
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain(root)
    expect(logged[0]).toContain('indexer exploded')
  })

  it('logs a failed refresh once through console.error by default', async () => {
    writeIndexFile()
    writeStatus(STALE)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const outcome = await refresher(async () => {
      throw new Error('boom')
    }).ensureFresh()

    expect(outcome).toEqual({ refreshed: false, stale: true })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(String(spy.mock.calls[0]?.[0])).toContain('incremental refresh')
  })

  it('does not wait for a run the indexer handed to a background job', async () => {
    writeIndexFile()
    writeStatus(STALE)
    const logged: string[] = []
    // The real indexer's delegated answer is a full report shape *plus* a job id: the
    // discriminator must be the id, not the counts that describe the index as it stood.
    const outcome = await refresher(
      async () => ({ ...report(), jobId: 'job-1' }),
      { logError: message => logged.push(message) },
    ).ensureFresh()

    expect(outcome).toEqual({ refreshed: false, stale: true })
    expect(logged).toHaveLength(0)
  })

  it('does not log a refresh cancelled by the query it belonged to', async () => {
    writeIndexFile()
    writeStatus(STALE)
    const logged: string[] = []
    const controller = new AbortController()
    const outcome = await refresher(async () => {
      controller.abort()
      throw new Error('The operation was aborted')
    }, { logError: message => logged.push(message) }).ensureFresh(controller.signal)

    expect(outcome).toEqual({ refreshed: false, stale: true })
    expect(logged).toHaveLength(0)
  })

  it('runs one incremental index for two queries that arrive while it is in flight', async () => {
    writeIndexFile()
    writeStatus(STALE)
    const gate = deferred()
    const calls: SynchronousIndexOptions[] = []
    const subject = refresher(async (options) => {
      calls.push(options)
      await gate.promise
      return report()
    })

    const first = subject.ensureFresh()
    const second = subject.ensureFresh()
    gate.resolve()
    const outcomes = await Promise.all([first, second])

    expect(calls).toHaveLength(1)
    expect(outcomes).toEqual([
      { refreshed: true, stale: false },
      { refreshed: true, stale: false },
    ])
  })

  it('refreshes again on a later query once the previous run finished', async () => {
    writeIndexFile()
    writeStatus(STALE)
    const calls: SynchronousIndexOptions[] = []
    const subject = refresher(async (options) => {
      calls.push(options)
      return report()
    })

    await subject.ensureFresh()
    // The fake never writes a fresh sidecar, so the second call sees the same stale record — which
    // is exactly the "still stale, try again" case a real machine only leaves after a failure.
    await subject.ensureFresh()

    expect(calls).toHaveLength(2)
  })
})
