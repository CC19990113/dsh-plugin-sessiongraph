import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { INDEX_RELATIVE_PATH } from 'dsh-plugin-sessiongraph-service'
import * as ServicePlugin from 'dsh-plugin-sessiongraph-service'
import * as SessionsPlugin from '../src/index.ts'
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
    backgroundIndexThreshold: 1_000,
    maxLiveSessions: 8,
    ...overrides,
  }
}

/** Compress one log line as its own zstd frame, as the harness appends them. */
function frame(record: unknown): Buffer {
  return zstdCompressSync(Buffer.from(`${JSON.stringify(record)}\n`))
}

/** Write one small session log into the fixture store. */
async function writeSessionLog(): Promise<void> {
  const directory = join(fixture.sessionsRoot, '--Users-admin-www-demo--', 'session-aaaa')
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'session.v4.jsonl.zstd'),
    Buffer.concat([
      frame({ type: 'session', version: 4, id: 'session-aaaa', createdAt: 1_700_000_000_000, cwd: '/Users/admin/www/demo' }),
      frame({
        type: 'user/message',
        seq: 1,
        time: 1_700_000_000_100,
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: '索引里的会话' }] },
      }),
    ]),
  )
}

/** One job the fake registry was asked to start, with the log its producer body writes. */
interface RecordedJob {
  readonly spec: {
    readonly owner: string
    readonly kind: string
    readonly label: string
    readonly run: (handle: { append(text: string): void }) => {
      cancel(reason?: string): void
      done: Promise<{ status: string; detail?: string }>
    }
  }
  readonly output: string[]
}

/** A stand-in for the host's background-job registry. */
function fakeJobs(options: { refuse?: boolean } = {}): {
  started: RecordedJob[]
  jobs: { start(spec: RecordedJob['spec']): string }
} {
  const started: RecordedJob[] = []
  return {
    started,
    jobs: {
      start(spec: RecordedJob['spec']): string {
        if (options.refuse === true) throw new Error('background jobs unavailable: no job controller serves this agent')
        started.push({ spec, output: [] })
        return `job-${started.length}`
      },
    },
  }
}

/** Invoke one recorded job's producer, the way the registry does while building the job record. */
function driveJob(job: RecordedJob): ReturnType<RecordedJob['spec']['run']> {
  return job.spec.run({ append: text => { job.output.push(text) } })
}

/** The `agent/created` payload the host dispatches during agent registration. */
interface AgentCreatedPayload {
  readonly agent: { readonly id: string; readonly session: { readonly header: { readonly cwd?: string } } }
}

/**
 * Mount the service and this plugin, optionally serving a fake job registry.
 * @param options - plugin config overrides and the jobs registry to provide.
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

describe('automatic index on session creation', () => {
  it('refreshes an existing index in the background and settles its job', async () => {
    await writeSessionLog()
    await buildIndex()
    const { started, jobs } = fakeJobs()
    const ctx = await mount({ jobs })

    emitAgentCreated(ctx, '/Users/admin/www/demo')

    expect(started).toHaveLength(1)
    expect(started[0]?.spec).toMatchObject({
      owner: 'session-new',
      kind: SessionsPlugin.AUTO_INDEX_JOB_KIND,
    })
    expect(started[0]?.spec.label).toContain('/Users/admin/www/demo')

    // The producer body is what the registry invokes; both halves of the contract must work.
    const job = started[0] as RecordedJob
    const hooks = driveJob(job)
    const outcome = await hooks.done
    expect(outcome.status).toBe('completed')
    expect(job.output.join('')).toContain('Indexed')
    expect(existsSync(join(fixture.indexRoot, INDEX_RELATIVE_PATH))).toBe(true)
    expect(existsSync(join(fixture.indexRoot, SessionsPlugin.STATUS_RELATIVE_PATH))).toBe(true)
  })

  it('does not auto-build a machine that has no index yet', async () => {
    await writeSessionLog()
    const { started, jobs } = fakeJobs()
    const ctx = await mount({ jobs })

    emitAgentCreated(ctx, '/Users/admin/www/demo')

    expect(started).toHaveLength(0)
  })

  it('does not auto-build without a workspace on the new session', async () => {
    await writeSessionLog()
    await buildIndex()
    const { started, jobs } = fakeJobs()
    const ctx = await mount({ jobs })

    emitAgentCreated(ctx, undefined)

    expect(started).toHaveLength(0)
  })

  it('returns silently when the host has no jobs service', async () => {
    await writeSessionLog()
    await buildIndex()
    const ctx = await mount()

    expect(() => emitAgentCreated(ctx, '/Users/admin/www/demo')).not.toThrow()
  })

  it('schedules at most one refresh per root per process', async () => {
    await writeSessionLog()
    await buildIndex()
    const { started, jobs } = fakeJobs()
    const ctx = await mount({ jobs })

    emitAgentCreated(ctx, '/Users/admin/www/demo')
    emitAgentCreated(ctx, '/Users/admin/www/demo')

    expect(started).toHaveLength(1)
  })

  it('swallows a refusing job registry after one console error', async () => {
    await writeSessionLog()
    await buildIndex()
    const { jobs } = fakeJobs({ refuse: true })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ctx = await mount({ jobs })

    expect(() => emitAgentCreated(ctx, '/Users/admin/www/demo')).not.toThrow()
    expect(logged).toHaveBeenCalledTimes(1)
  })

  it('registers no listener at all when autoIndex is false', async () => {
    await writeSessionLog()
    await buildIndex()
    const { started, jobs } = fakeJobs()
    const ctx = await mount({ jobs, config: { autoIndex: false } })

    emitAgentCreated(ctx, '/Users/admin/www/demo')

    expect(started).toHaveLength(0)
    // The manual indexer is unaffected by switching the automatic refresh off.
    const report = await SessionsPlugin.runIndex(fixture.indexRoot, {}, undefined, config())
    expect(report.sessions).toBe(1)
  })
})
