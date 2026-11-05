import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessiongraphIndexOptions, SessiongraphIndexReport } from 'dsh-plugin-sessiongraph-service'
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
  const work = await mkdtemp(join(tmpdir(), 'sessiongraph-background-index-'))
  fixture = { work, sessionsRoot: join(work, 'sessions'), indexRoot: join(work, 'index') }
  await mkdir(fixture.sessionsRoot, { recursive: true })
})

afterEach(async () => {
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
    engine: 'typescript',
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
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: `内容 ${id}` }] },
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

/**
 * Build the options a tool passes through the seam. `owner` is the runtime extension this indexer
 * reads to decide whether the run may be delegated to a job; the seam itself carries no caller id.
 */
function options(extra: SessiongraphIndexOptions & { owner?: string } = {}): SessiongraphIndexOptions {
  return extra
}

describe('background index runs', () => {
  it('indexes synchronously while the store is below the threshold', async () => {
    await writeSessionLog()
    const { started, jobs } = fakeJobs()
    const ctx = await mount({ jobs })

    const report = await ctx.sessiongraph.index(fixture.indexRoot, options({ owner: 'session-caller' }))

    expect(SessionsPlugin.isBackgroundIndexReport(report)).toBe(false)
    expect(started).toHaveLength(0)
    expect(report.sessions).toBe(1)
    expect(existsSync(join(fixture.indexRoot, INDEX_RELATIVE_PATH))).toBe(true)
  })

  it('hands a large store to the job registry and returns its id', async () => {
    await writeSessionLog()
    const { started, jobs } = fakeJobs()
    const ctx = await mount({ jobs, config: { backgroundIndexThreshold: 1 } })

    const report = await ctx.sessiongraph.index(fixture.indexRoot, options({ owner: 'session-caller' }))

    expect(SessionsPlugin.isBackgroundIndexReport(report)).toBe(true)
    expect(started).toHaveLength(1)
    expect(started[0]?.spec).toMatchObject({ owner: 'session-caller', kind: SessionsPlugin.AUTO_INDEX_JOB_KIND })
    // Nothing has been written yet: the delegated result reports the index as it stands.
    expect(existsSync(join(fixture.indexRoot, INDEX_RELATIVE_PATH))).toBe(false)
    expect(report.sessions).toBe(0)

    // Driving the producer is what the registry does; both halves of the job contract must work.
    const job = started[0] as RecordedJob
    const outcome = await driveJob(job).done
    expect(outcome.status).toBe('completed')
    expect(job.output.join('')).toContain('Indexed')
    expect(existsSync(join(fixture.indexRoot, INDEX_RELATIVE_PATH))).toBe(true)
    expect(existsSync(join(fixture.indexRoot, SessionsPlugin.STATUS_RELATIVE_PATH))).toBe(true)
  })

  it('reports the previous run\'s totals in a delegated result', async () => {
    await writeSessionLog()
    const ctx = await mount({ jobs: fakeJobs().jobs, config: { backgroundIndexThreshold: 1 } })
    await SessionsPlugin.runIndex(fixture.indexRoot, {}, undefined, config())

    const report = await ctx.sessiongraph.index(fixture.indexRoot, options({ owner: 'session-caller' }))

    expect(SessionsPlugin.isBackgroundIndexReport(report)).toBe(true)
    expect(report).toMatchObject({ added: 0, updated: 0, skipped: 0, removed: 0, failed: [] })
    expect(report.sessions).toBe(1)
    expect(report.bytes).toBeGreaterThan(0)
  })

  it('falls back to a synchronous run when the host has no jobs service', async () => {
    await writeSessionLog()
    const ctx = await mount({ config: { backgroundIndexThreshold: 1 } })

    const report = await ctx.sessiongraph.index(fixture.indexRoot, options({ owner: 'session-caller' }))

    expect(SessionsPlugin.isBackgroundIndexReport(report)).toBe(false)
    expect(report.sessions).toBe(1)
  })

  it('falls back to a synchronous run when the registry refuses the job', async () => {
    await writeSessionLog()
    const { jobs } = fakeJobs({ refuse: true })
    const ctx = await mount({ jobs, config: { backgroundIndexThreshold: 1 } })

    const report = await ctx.sessiongraph.index(fixture.indexRoot, options({ owner: 'session-caller' }))

    expect(SessionsPlugin.isBackgroundIndexReport(report)).toBe(false)
    expect(report.sessions).toBe(1)
  })

  it('runs synchronously when the caller attached no owning session', async () => {
    await writeSessionLog()
    const { started, jobs } = fakeJobs()
    const ctx = await mount({ jobs, config: { backgroundIndexThreshold: 1 } })

    const report = await ctx.sessiongraph.index(fixture.indexRoot, options())

    expect(SessionsPlugin.isBackgroundIndexReport(report)).toBe(false)
    expect(started).toHaveLength(0)
    expect(report.sessions).toBe(1)
  })

  it('keeps a scoped run synchronous even with a large store', async () => {
    await writeSessionLog()
    const { started, jobs } = fakeJobs()
    const ctx = await mount({ jobs, config: { backgroundIndexThreshold: 1 } })

    const report = await ctx.sessiongraph.index(
      fixture.indexRoot,
      options({ owner: 'session-caller', workspace: '/Users/admin/www/demo' }),
    )

    expect(SessionsPlugin.isBackgroundIndexReport(report)).toBe(false)
    expect(started).toHaveLength(0)
    expect(report.sessions).toBe(1)
  })

  it('never throws to the caller when the job start cannot even be attempted', async () => {
    await writeSessionLog()
    const ctx = await mount({
      jobs: { start(): never { throw new Error('owner already holds the maximum number of jobs') } },
      config: { backgroundIndexThreshold: 1 },
    })

    const report: SessiongraphIndexReport = await ctx.sessiongraph.index(
      fixture.indexRoot,
      options({ owner: 'session-caller' }),
    )

    expect(report.sessions).toBe(1)
  })
})
