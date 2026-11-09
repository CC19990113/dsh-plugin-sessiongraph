import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { INDEX_RELATIVE_PATH } from 'dsh-plugin-sessiongraph-service'
import * as ServicePlugin from 'dsh-plugin-sessiongraph-service'
import * as SessionsPlugin from '../src/index.ts'
import { acquireIndexLock } from '../src/lock.ts'
import type { ResolvedConfig } from '../src/index.ts'

/** Temporary roots for one test. */
interface Fixture {
  readonly work: string
  readonly sessionsRoot: string
  readonly indexRoot: string
}

let fixture: Fixture

beforeEach(async () => {
  const work = await mkdtemp(join(tmpdir(), 'sessiongraph-auto-index-'))
  fixture = { work, sessionsRoot: join(work, 'sessions'), indexRoot: join(work, 'index') }
  await mkdir(fixture.sessionsRoot, { recursive: true })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(fixture.work, { recursive: true, force: true })
})

/** The resolved configuration a real deployment would hand `apply`. */
function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    sessionsRoot: fixture.sessionsRoot,
    indexRoot: fixture.indexRoot,
    maxEntryChars: 4_000,
    toolCallChars: 2_000,
    maxFileBytes: 64 * 1024 * 1024,
    autoIndex: true,
    autoIndexMinIntervalMs: 60_000,
    autoIndexTimeoutMs: 900_000,
    autoBuild: true,
    maxLiveSessions: 8,
    engine: 'typescript',
    codex: false,
    codexRoot: join(fixture.work, 'codex'),
    ...overrides,
  }
}

/** Compress one log line as its own zstd frame, as the harness appends them. */
function frame(record: unknown): Buffer {
  return zstdCompressSync(Buffer.from(`${JSON.stringify(record)}\n`))
}

/** Write one small session log into the fixture store. */
async function writeSessionLog(id = 'session-aaaa'): Promise<void> {
  const directory = join(fixture.sessionsRoot, '--Users-admin-www-demo--', id)
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'session.v4.jsonl.zstd'),
    Buffer.concat([
      frame({ type: 'session', version: 4, id, createdAt: 1_700_000_000_000, cwd: '/Users/admin/www/demo' }),
      frame({
        type: 'user/message',
        seq: 1,
        time: 1_700_000_000_100,
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: '索引里的会话' }] },
      }),
    ]),
  )
}

/** The `agent/created` payload the host dispatches during agent registration. */
interface AgentCreatedPayload {
  readonly agent: { readonly id: string; readonly session: { readonly header: { readonly cwd?: string } } }
}

/**
 * Mount the service and this plugin.
 * @param options - plugin config overrides and an optional fake job registry.
 * @returns the mounted context.
 */
async function mount(options: { jobs?: unknown; config?: Partial<ResolvedConfig> } = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(ServicePlugin)
  if (options.jobs !== undefined) ctx.provide('jobs', options.jobs)
  await ctx.plugin(SessionsPlugin, config(options.config))
  return ctx
}

/** Dispatch `agent/created` the way the host's agent registry does. */
function emitAgentCreated(ctx: Context, cwd?: string): void {
  const payload: AgentCreatedPayload = {
    agent: {
      id: 'session-new',
      session: { header: cwd === undefined ? {} : { cwd } },
    },
  }
  ;(ctx as unknown as { emit(name: string, payload: unknown): void }).emit('agent/created', payload)
}

/** Build an index once, so the sidecar this plugin uses as its precondition exists. */
async function buildIndex(): Promise<void> {
  await SessionsPlugin.runIndex(fixture.indexRoot, {}, undefined, config())
}

/** The sidecar summary the last run left, or undefined when no run has written one yet. */
function statusOf(root = fixture.indexRoot): { readonly indexedAt: number; readonly sessions: number } | undefined {
  try {
    return JSON.parse(readFileSync(join(root, SessionsPlugin.STATUS_RELATIVE_PATH), 'utf8'))
  } catch {
    return undefined
  }
}

/** Wait for a background run to land, since session creation never blocks on it. */
async function waitUntil(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('timed out waiting for the background index run')
}

/** Wait a fixed span, for assertions that something must NOT have happened. */
async function settle(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('automatic index on session creation', () => {
  it('refreshes an existing index in the background', async () => {
    await writeSessionLog('session-aaaa')
    await buildIndex()
    expect(statusOf()?.sessions).toBe(1)

    const ctx = await mount()
    await writeSessionLog('session-bbbb')
    emitAgentCreated(ctx, '/Users/admin/www/demo')

    await waitUntil(() => statusOf()?.sessions === 2)
    expect(existsSync(join(fixture.indexRoot, INDEX_RELATIVE_PATH))).toBe(true)
  })

  it('never registers a job, so no completion notice can reach the transcript', async () => {
    // 这是本次改动的核心契约：自动刷新是维护动作，宿主 job 的完成通知会唤醒一轮对话、污染会话。
    await writeSessionLog('session-aaaa')
    await buildIndex()
    const start = vi.fn(() => {
      throw new Error('automatic index must not register a host job')
    })
    const ctx = await mount({ jobs: { start } })

    await writeSessionLog('session-bbbb')
    emitAgentCreated(ctx, '/Users/admin/www/demo')

    await waitUntil(() => statusOf()?.sessions === 2)
    expect(start).not.toHaveBeenCalled()
  })

  it('builds the first index in the background when none exists', async () => {
    await writeSessionLog()
    const ctx = await mount()

    emitAgentCreated(ctx, '/Users/admin/www/demo')

    expect(existsSync(join(fixture.indexRoot, 'index.db'))).toBe(false)
    await waitUntil(() => statusOf()?.sessions === 1)
    expect(existsSync(join(fixture.indexRoot, 'index.db'))).toBe(true)
  })

  it('refreshes again once the auto-index window has passed', async () => {
    // 索引的意义是「刚说的话也查得到」。进程内只跑一次，桌面开几天后就落后一整天；
    // 改成时间窗口后，窗口内吸收 burst，窗口外下一次会话就刷新。
    await writeSessionLog('session-aaaa')
    await buildIndex()
    const ctx = await mount({ config: { autoIndexMinIntervalMs: 1_000 } })

    await writeSessionLog('session-bbbb')
    emitAgentCreated(ctx, '/Users/admin/www/demo')
    await waitUntil(() => statusOf()?.sessions === 2)

    // 窗口内再开一个会话：同一个 root 不重复排
    await writeSessionLog('session-cccc')
    emitAgentCreated(ctx, '/Users/admin/www/demo')
    await settle(150)
    expect(statusOf()?.sessions).toBe(2)

    // 过了窗口：下一次会话触发刷新
    await settle(1_000)
    emitAgentCreated(ctx, '/Users/admin/www/demo')
    await waitUntil(() => statusOf()?.sessions === 3)
  })

  it('leaves a machine with no index alone when autoBuild is false', async () => {
    await writeSessionLog()
    const ctx = await mount({ config: { autoBuild: false } })

    emitAgentCreated(ctx, '/Users/admin/www/demo')

    await settle(100)
    expect(existsSync(join(fixture.indexRoot, INDEX_RELATIVE_PATH))).toBe(false)
    // The manual indexer is unaffected by switching the automatic refresh off.
    const report = await SessionsPlugin.runIndex(fixture.indexRoot, {}, undefined, config())
    expect(report.sessions).toBe(1)
  })

  it('does not auto-build without a workspace on the new session', async () => {
    await writeSessionLog()
    await buildIndex()
    const ctx = await mount()

    emitAgentCreated(ctx, undefined)

    await settle(100)
    expect(statusOf()?.sessions).toBe(1)
  })

  it('registers no listener at all when autoIndex is false', async () => {
    await writeSessionLog()
    await buildIndex()
    const ctx = await mount({ config: { autoIndex: false } })

    await writeSessionLog('session-bbbb')
    emitAgentCreated(ctx, '/Users/admin/www/demo')

    await settle(100)
    expect(statusOf()?.sessions).toBe(1)
  })

  it('does not start a second run while the first one is still in flight', async () => {
    // The time window cannot deduplicate a slow run: the second session opens after the window while
    // the first run still waits for the write lock. Only the in-flight set can skip it, and a
    // skipped session must not produce a second run.
    await writeSessionLog('session-aaaa')
    await buildIndex()
    // A short deadline is what makes a wrongly started second run observable: it would time out too.
    const ctx = await mount({ config: { autoIndexMinIntervalMs: 10, autoIndexTimeoutMs: 200 } })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const release = await acquireIndexLock(fixture.indexRoot, { timeoutMs: 5_000, staleMs: 3_600_000 })
    try {
      emitAgentCreated(ctx, '/Users/admin/www/demo')
      await settle(40) // past the window; the first run is still waiting behind the held lock
      emitAgentCreated(ctx, '/Users/admin/www/demo')
      // Wait for the first run's deadline, then give a wrongly started second run (40ms later) room
      // to miss its own. Exactly one timeout proves the second session was skipped, not run.
      await waitUntil(() => logged.mock.calls.length >= 1)
      await settle(120)
      expect(logged).toHaveBeenCalledTimes(1)
      expect(String(logged.mock.calls[0]?.[0])).toContain('timed out')
    } finally {
      release()
    }
    // The aborted run settles once the lock is free, but must not release an entry it no longer owns.
    await settle(250)
    expect(logged).toHaveBeenCalledTimes(1)
  })

  it('runs again once the lock that stalled a timed-out run is released', async () => {
    // The deadline's whole job is to make the root usable again, so the recovery needs a test: a run
    // blocked on a held lock times out and drops its in-flight entry, and the next session must be
    // the one that builds the index once the lock is finally gone.
    await writeSessionLog('session-aaaa')
    await buildIndex()
    const ctx = await mount({ config: { autoIndexMinIntervalMs: 10, autoIndexTimeoutMs: 200 } })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const release = await acquireIndexLock(fixture.indexRoot, { timeoutMs: 5_000, staleMs: 3_600_000 })
    try {
      await writeSessionLog('session-bbbb')
      emitAgentCreated(ctx, '/Users/admin/www/demo')
      await waitUntil(() => logged.mock.calls.length >= 1)
      expect(String(logged.mock.calls[0]?.[0])).toContain('timed out')
      expect(statusOf()?.sessions).toBe(1)
    } finally {
      release()
    }

    // The timed-out run released its entry, and the aborted promise cannot write the index, so this
    // second session is the one that has to produce `status.json`.
    emitAgentCreated(ctx, '/Users/admin/www/demo')
    await waitUntil(() => statusOf()?.sessions === 2)
  })

  it('releases the in-flight entry when a run fails, so the next session retries', async () => {
    await writeSessionLog('session-aaaa')
    // An index root that is a file: creating the write lock fails, so the run rejects before writing.
    const blocked = join(fixture.work, 'blocked-index')
    await writeFile(blocked, 'not a directory')
    const ctx = await mount({ config: { indexRoot: blocked, autoIndexMinIntervalMs: 1 } })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    emitAgentCreated(ctx, '/Users/admin/www/demo')
    await waitUntil(() => logged.mock.calls.length >= 1)
    expect(String(logged.mock.calls[0]?.[0])).toContain('automatic index')

    // A failure must not leave the root suppressed: make it usable and open another session.
    await rm(blocked, { force: true })
    await mkdir(blocked, { recursive: true })
    await settle(10)
    emitAgentCreated(ctx, '/Users/admin/www/demo')
    await waitUntil(() => statusOf(blocked)?.sessions === 1)
  })
})
