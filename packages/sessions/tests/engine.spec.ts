import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { INDEX_RELATIVE_PATH } from 'dsh-plugin-sessiongraph-service'
import * as ServicePlugin from 'dsh-plugin-sessiongraph-service'
import * as SessionsPlugin from '../src/index.ts'
import type { ResolvedConfig, SessiongraphEngineSetting } from '../src/index.ts'

// The kernel is a native module: tests drive the selection logic with a stub, never the real `.node`.
import { loadNative } from 'dsh-plugin-sessiongraph-native'

vi.mock('dsh-plugin-sessiongraph-native', () => ({ loadNative: vi.fn() }))

const loadNativeMock = vi.mocked(loadNative)

/** Temporary roots for one test. */
interface Fixture {
  readonly work: string
  readonly sessionsRoot: string
  readonly indexRoot: string
}

let fixture: Fixture

beforeEach(async () => {
  loadNativeMock.mockReset()
  const work = await mkdtemp(join(tmpdir(), 'sessiongraph-engine-'))
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
    autoIndex: false,
    backgroundIndexThreshold: 1_000,
    autoIndexTimeoutMs: 900_000,
    maxLiveSessions: 8,
    engine: 'auto',
    ...overrides,
  }
}

/** Compress one log line as its own zstd frame, as the harness appends them. */
function frame(record: unknown): Buffer {
  return zstdCompressSync(Buffer.from(`${JSON.stringify(record)}\n`))
}

/** Write one persisted session log into the fixture store. */
async function writeSessionLog(): Promise<void> {
  const directory = join(fixture.sessionsRoot, '--Users-admin-www-demo--', 'session-file')
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'session.v4.jsonl.zstd'),
    Buffer.concat([
      frame({ type: 'session', version: 4, id: 'session-file', createdAt: 1_700_000_000_000, cwd: '/Users/admin/www/demo' }),
      frame({
        type: 'user/message',
        seq: 1,
        time: 1_700_000_000_100,
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: '落盘会话内容' }] },
      }),
    ]),
  )
}

/** A stand-in native kernel that records its options and answers with a fixed report. */
function fakeKernel(options: { throws?: boolean; report?: Record<string, unknown> } = {}): {
  kernel: { indexSessions(callOptions: Record<string, unknown>): Record<string, unknown> }
  calls: Record<string, unknown>[]
} {
  const calls: Record<string, unknown>[] = []
  return {
    calls,
    kernel: {
      indexSessions(callOptions: Record<string, unknown>): Record<string, unknown> {
        calls.push(callOptions)
        if (options.throws === true) throw new Error('native kernel exploded')
        return {
          indexPath: callOptions.indexPath,
          added: 0,
          updated: 0,
          skipped: 0,
          removed: 0,
          liveSessions: 0,
          liveSkipped: 0,
          discovered: 0,
          failed: [],
          entries: 0,
          sessions: 0,
          workspaces: 0,
          bytes: 0,
          elapsedMs: 1,
          ...options.report,
        }
      },
    },
  }
}

/** A stand-in for the host's `sessionQuery` service with exactly one live session. */
function liveStub(): {
  listSessions(): Promise<unknown[]>
  readSession(sessionId: string): Promise<unknown>
} {
  return {
    async listSessions(): Promise<unknown[]> {
      return [{ header: { id: 'session-live', cwd: '/Users/admin/www/demo' }, live: true, persisted: false }]
    },
    async readSession(sessionId: string): Promise<unknown> {
      return {
        session: { type: 'session', version: 4, id: sessionId, cwd: '/Users/admin/www/demo', createdAt: 1_700_000_000_000 },
        inheritedEventCount: 0,
        events: [
          {
            type: 'user/message',
            seq: 1,
            time: 1_700_000_000_100,
            data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'live 会话内容' }] },
          },
        ],
      }
    },
  }
}

/**
 * Mount the service and this plugin, optionally serving a stub session-query service.
 * @param options - engine setting, config overrides, and the session-query stub.
 * @returns the mounted context.
 */
async function mount(
  options: { engine?: SessiongraphEngineSetting; config?: Partial<ResolvedConfig>; sessionQuery?: unknown } = {},
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(ServicePlugin)
  if (options.sessionQuery !== undefined) ctx.provide('sessionQuery', options.sessionQuery)
  await ctx.plugin(SessionsPlugin, config({ ...options.config, ...(options.engine === undefined ? {} : { engine: options.engine }) }))
  return ctx
}

/** Read rows from the written index. */
function query(sql: string, ...parameters: (string | number | null)[]): Record<string, unknown>[] {
  const database = new DatabaseSync(join(fixture.indexRoot, INDEX_RELATIVE_PATH), { readOnly: true })
  try {
    return database.prepare(sql).all(...parameters)
  } finally {
    database.close()
  }
}

describe('engine selection', () => {
  it('prefers the native kernel under `auto` and still runs the live pass', async () => {
    await writeSessionLog()
    const { kernel, calls } = fakeKernel()
    loadNativeMock.mockReturnValue(kernel as never)
    const ctx = await mount({ sessionQuery: liveStub() })

    const report = await ctx.sessiongraph.index(fixture.indexRoot, {})

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      sessionsRoot: fixture.sessionsRoot,
      indexPath: join(fixture.indexRoot, INDEX_RELATIVE_PATH),
      maxEntryChars: 4_000,
      toolCallChars: 2_000,
      maxFileBytes: 64 * 1024 * 1024,
    })
    expect(report.engine).toBe('native')
    // The kernel always reports zero live sessions; the shared live pass owns the real numbers.
    expect(report.liveSessions).toBe(1)
    expect(query('SELECT id FROM session')).toEqual([{ id: 'session-live' }])
  })

  it('forwards the run switches to the kernel', async () => {
    const { kernel, calls } = fakeKernel()
    loadNativeMock.mockReturnValue(kernel as never)
    const ctx = await mount()

    await ctx.sessiongraph.index(fixture.indexRoot, { force: true, workspace: '/Users/admin/www/demo', sessionId: 'session-x' })

    expect(calls[0]).toMatchObject({ force: true, workspaceFilter: '/Users/admin/www/demo', sessionFilter: 'session-x' })
  })

  it('falls back to the TypeScript engine when the kernel is unavailable', async () => {
    await writeSessionLog()
    loadNativeMock.mockReturnValue(undefined)
    const ctx = await mount()

    const report = await ctx.sessiongraph.index(fixture.indexRoot, {})

    expect(report.engine).toBe('typescript')
    expect(report.sessions).toBe(1)
    expect(query('SELECT id FROM session')).toEqual([{ id: 'session-file' }])
  })

  it('never probes the kernel when the engine is pinned to typescript', async () => {
    await writeSessionLog()
    loadNativeMock.mockReturnValue(fakeKernel().kernel as never)
    const ctx = await mount({ engine: 'typescript' })

    const report = await ctx.sessiongraph.index(fixture.indexRoot, {})

    expect(loadNativeMock).not.toHaveBeenCalled()
    expect(report.engine).toBe('typescript')
    expect(report.sessions).toBe(1)
  })

  it('falls back to TypeScript when the kernel run throws, logging once', async () => {
    await writeSessionLog()
    const { kernel } = fakeKernel({ throws: true })
    loadNativeMock.mockReturnValue(kernel as never)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ctx = await mount({ engine: 'native' })

    const report = await ctx.sessiongraph.index(fixture.indexRoot, {})

    expect(report.engine).toBe('typescript')
    expect(report.sessions).toBe(1)
    expect(query('SELECT id FROM session')).toEqual([{ id: 'session-file' }])
    expect(logged).toHaveBeenCalledTimes(1)
  })

  it('explains the fallback once when native was requested but is unavailable', async () => {
    await writeSessionLog()
    loadNativeMock.mockReturnValue(undefined)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ctx = await mount({ engine: 'native' })

    const report = await ctx.sessiongraph.index(fixture.indexRoot, {})

    expect(report.engine).toBe('typescript')
    expect(report.sessions).toBe(1)
    expect(logged).toHaveBeenCalledTimes(1)
  })

  it('keeps quiet about an unavailable kernel when the engine is auto', async () => {
    await writeSessionLog()
    loadNativeMock.mockReturnValue(undefined)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ctx = await mount()

    await ctx.sessiongraph.index(fixture.indexRoot, {})

    expect(logged).not.toHaveBeenCalled()
  })
})
