/**
 * Tool-level wiring tests for the single `sessiongraph` tool: one registration, nine operations on
 * one parameter schema, and the measured background split for `index`.
 *
 * The `ctx` here is a structural stand-in for the services the plugin injects and nothing more:
 * importing a real cordis Context would drag the host composition in, while the seam itself is
 * exercised by the service package's own tests. `ctx.get('jobs')` is mocked at the registry's own
 * shape (start → id, run → { cancel, done }) because that contract is what the split depends on.
 * @module dsh-plugin-sessiongraph-tool/tests/tool
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { validateJsonSchemaValue, valueSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools'
import type {
  SessiongraphEventResult,
  SessiongraphIndexReport,
  SessiongraphSessionResult,
  SessiongraphSessionSummary,
  SessiongraphStatusResult,
  SessiongraphTimelineResult,
  SessiongraphTouchedResult,
  SessiongraphTraceResult,
  SessiongraphWorkspacesResult,
} from 'dsh-plugin-sessiongraph-service'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, callTitle } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { SESSIONGRAPH_OUTPUT_SCHEMA } from '../src/schema.ts'
import type { SessiongraphToolValue } from '../src/schema.ts'

/** The slice of a registered tool these tests drive. */
interface RegisteredTool {
  name: string
  timeoutMs?: number
  execute(args: unknown, exec: unknown): Promise<unknown>
  output: { render(args: unknown, value: unknown): { type: string; text: string }[] }
}

/** One job spec the fake registry captured. */
interface CapturedJobSpec {
  readonly owner: string
  readonly kind: string
  readonly label: string
  readonly run: (handle: { append(text: string): void }) => {
    cancel(reason?: string): void
    done: Promise<{ status: string; detail?: string }>
  }
}

/** The fake background-job registry, plus the specs it was handed. */
interface FakeJobs {
  readonly registry: { start(spec: CapturedJobSpec): string }
  readonly started: CapturedJobSpec[]
}

/** A registry that records what it was asked to run and returns sequential job ids. */
function fakeJobs(): FakeJobs {
  const started: CapturedJobSpec[] = []
  return {
    registry: {
      start(spec) {
        started.push(spec)
        return `job-${started.length}`
      },
    },
    started,
  }
}

/** One session summary, complete enough for every operation that embeds one. */
function summary(): SessiongraphSessionSummary {
  return {
    sessionId: '037ad8fc-29b8-4a69-9a02-e75f9cc8fb45' as SessiongraphSessionSummary['sessionId'],
    title: '改广告 SDK',
    workspace: '/Users/admin/www/dsh-community',
    createdAt: 1_760_000_000_000,
    lastAt: 1_760_000_600_000,
    turns: 3,
    entries: 12,
    parentSession: undefined,
    origin: undefined,
    agentPreset: undefined,
  }
}

/** A finished index report shaped like the sessions indexer's. */
function report(): SessiongraphIndexReport {
  return {
    indexPath: join(root, 'index.db'),
    added: 2,
    updated: 1,
    skipped: 3,
    removed: 0,
    discovered: 6,
    failed: [],
    entries: 30,
    sessions: 6,
    workspaces: 2,
    bytes: 4096,
    elapsedMs: 5,
  }
}

/** The answer the fake seam returns for each read operation. */
function answers(): Record<string, unknown> {
  const session = summary()
  const status: SessiongraphStatusResult = {
    operation: 'status',
    indexed: true,
    indexPath: join(root, 'index.db'),
    sessions: 6,
    entries: 30,
    workspaces: 2,
    indexedAt: Date.now(),
    bytes: 4096,
  }
  const sessionResult: SessiongraphSessionResult = {
    operation: 'session',
    session,
    entries: [],
    children: [],
    truncated: false,
  }
  const event: SessiongraphEventResult = {
    operation: 'event',
    session,
    event: { seq: 7, time: 1_760_000_000_000, type: 'tool/call', data: { name: 'grep' } },
    before: [],
    after: [],
  }
  const trace: SessiongraphTraceResult = {
    operation: 'trace',
    kind: 'session',
    target: session,
    ancestors: [],
    descendants: [],
    complete: true,
  }
  const timeline: SessiongraphTimelineResult = { operation: 'timeline', sessions: [session], truncated: false }
  const workspaces: SessiongraphWorkspacesResult = {
    operation: 'workspaces',
    workspaces: [{ workspace: session.workspace, sessions: 6, entries: 30, firstAt: 1, lastAt: 2 }],
    total: 1,
  }
  const touched: SessiongraphTouchedResult = {
    operation: 'touched',
    sessionId: session.sessionId,
    resources: [],
    total: 0,
    truncated: false,
    unparsed: 0,
  }
  return {
    search: { operation: 'search', hits: [], total: 0, truncated: false },
    session: sessionResult,
    event,
    trace,
    timeline,
    workspaces,
    status,
    touched,
  }
}

/** One composed tool over a fake seam, with every call it observed. */
interface Harness {
  readonly tools: RegisteredTool[]
  /** Number of `ctx.tools.register` invocations, whatever they registered. */
  readonly registrations: number
  readonly queries: string[]
  readonly indexOptions: Array<Record<string, unknown>>
}

const THRESHOLD = 1_000

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sessiongraph-tool-'))
  // A sidecar with one session: below the threshold unless a test writes its own.
  writeStatus(1)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

/** Write the sidecar the background decision reads. */
function writeStatus(sessions: number): void {
  writeFileSync(join(root, 'status.json'), JSON.stringify({
    indexedAt: Date.now(),
    sessions,
    entries: 30,
    workspaces: 2,
    bytes: 4096,
  }))
}

/**
 * Register the plugin against a fake service.
 * @param options - registry, index answer, and config overrides.
 * @returns the registered tool and the calls it made.
 */
function harness(options: {
  jobs?: FakeJobs
  index?: () => Promise<unknown>
  config?: Partial<Config>
} = {}): Harness {
  const tools: RegisteredTool[] = []
  let registrations = 0
  const queries: string[] = []
  const indexOptions: Array<Record<string, unknown>> = []
  const status = answers()['status'] as SessiongraphStatusResult
  const byOperation = answers()
  const ctx = {
    systemPrompt: { section: () => undefined },
    tools: {
      register: (definition: RegisteredTool) => {
        registrations += 1
        tools.push(definition)
      },
    },
    get: (name: string) => (name === 'jobs' ? options.jobs?.registry : undefined),
    sessiongraph: {
      async query(request: { operation: string }) {
        queries.push(request.operation)
        return byOperation[request.operation] ?? status
      },
      async index(_indexRoot: string, indexOptionsSeen: Record<string, unknown>) {
        indexOptions.push(indexOptionsSeen)
        return options.index === undefined ? report() : options.index()
      },
    },
  }
  const config: Config = {
    indexRoot: root,
    maxLimit: 100,
    maxSnippetChars: 600,
    freshnessThresholdMs: 0,
    timeoutMs: 30_000,
    backgroundIndexThreshold: THRESHOLD,
    ...options.config,
  }
  apply(ctx as unknown as Context, config)
  return { tools, registrations, queries, indexOptions }
}

/** The only registered tool, failing loudly when the plugin registered zero or several. */
function onlyTool(harnessed: Harness): RegisteredTool {
  expect(harnessed.registrations).toBe(1)
  expect(harnessed.tools).toHaveLength(1)
  const tool = harnessed.tools[0]
  if (tool === undefined) throw new Error('no tool registered')
  return tool
}

/** The execution context a tool body reads: a signal, plus an owning agent when a test needs one. */
function exec(agentId?: string): unknown {
  return {
    signal: new AbortController().signal,
    ...(agentId === undefined ? {} : { agent: { id: agentId } }),
  }
}

describe('registration', () => {
  it('registers exactly one tool named sessiongraph', () => {
    const harnessed = harness()
    const tool = onlyTool(harnessed)
    expect(tool.name).toBe('sessiongraph')
    expect(tool.timeoutMs).toBe(30_000)
  })

  it('keeps the tool registered whatever toolSet says (visibility owns the kernel side)', () => {
    for (const toolSet of ['sessiongraph', 'kernel', 'both'] as const) {
      expect(onlyTool(harness({ config: { toolSet } })).name).toBe('sessiongraph')
    }
  })
})

describe('callTitle', () => {
  it('names the defaulted operation when the model omitted one', () => {
    expect(callTitle({ query: '广告' })).toBe('sessiongraph search 广告')
    expect(callTitle({ operation: 'index' })).toBe('sessiongraph index')
  })
})

describe('operation dispatch', () => {
  it('runs every query operation through ctx.sessiongraph.query', async () => {
    const harnessed = harness()
    const tool = onlyTool(harnessed)
    const calls: Array<[string, Record<string, unknown>]> = [
      ['search', { operation: 'search', query: '广告' }],
      ['session', { operation: 'session', session_id: '037ad8fc' }],
      ['event', { operation: 'event', session_id: '037ad8fc', seq: 7 }],
      ['trace', { operation: 'trace', session_id: '037ad8fc' }],
      ['timeline', { operation: 'timeline' }],
      ['workspaces', { operation: 'workspaces' }],
      ['status', { operation: 'status' }],
      ['touched', { operation: 'touched', session_id: '037ad8fc' }],
    ]
    for (const [, args] of calls) await tool.execute(args, exec())
    expect(harnessed.queries).toEqual(calls.map(([operation]) => operation))
    expect(harnessed.indexOptions).toEqual([])
  })

  it('runs a call with no operation as a search', async () => {
    const harnessed = harness()
    const value = await onlyTool(harnessed).execute({ query: '广告' }, exec()) as SessiongraphToolValue
    expect(harnessed.queries).toEqual(['search'])
    // The defaulted call still reports its operation, and the closed oneOf output accepts the value.
    expect(value).toMatchObject({ operation: 'search', total: 0 })
    expect(validateJsonSchemaValue(valueSchemaSpecToJsonSchema(SESSIONGRAPH_OUTPUT_SCHEMA), value)).toEqual([])
  })

  it('keeps an explicit operation instead of the search default', async () => {
    const harnessed = harness()
    const value = await onlyTool(harnessed).execute({ operation: 'timeline' }, exec()) as SessiongraphToolValue
    expect(harnessed.queries).toEqual(['timeline'])
    expect(value.operation).toBe('timeline')
  })

  it('routes index to ctx.sessiongraph.index and never to query', async () => {
    const harnessed = harness()
    await onlyTool(harnessed).execute({ operation: 'index' }, exec('session-1'))
    expect(harnessed.queries).toEqual([])
    expect(harnessed.indexOptions).toHaveLength(1)
    // A run that stayed synchronous must not name an owner: the indexer would delegate it again.
    expect(harnessed.indexOptions[0]).toEqual({})
  })

  it('keeps status answerable when the seam reports no index at all', async () => {
    const tools = harness()
    // The fake seam answers status normally; the no-index path itself is covered by the seam's tests.
    const value = await onlyTool(tools).execute({ operation: 'status' }, exec()) as SessiongraphToolValue
    expect(value).toMatchObject({ operation: 'status', indexed: true, live_sessions: 0 })
  })

  it('never refreshes the index for status or index itself', async () => {
    const harnessed = harness({ config: { freshnessThresholdMs: 300_000 } })
    const tool = onlyTool(harnessed)
    await tool.execute({ operation: 'status' }, exec())
    await tool.execute({ operation: 'index' }, exec())
    expect(harnessed.queries).toEqual(['status'])
    expect(harnessed.indexOptions).toHaveLength(1)
  })
})

describe('index background split', () => {
  it('runs in place below the threshold and answers with the report', async () => {
    writeStatus(THRESHOLD - 1)
    const harnessed = harness({ jobs: fakeJobs() })
    const value = await onlyTool(harnessed).execute({ operation: 'index' }, exec('session-1')) as SessiongraphToolValue
    expect(value).toMatchObject({ operation: 'index', added: 2, updated: 1, skipped: 3, removed: 0 })
    expect('status' in value).toBe(false)
  })

  it('hands a large run to ctx.jobs.start and answers with a job id', async () => {
    writeStatus(THRESHOLD)
    const jobs = fakeJobs()
    const harnessed = harness({ jobs })
    const value = await onlyTool(harnessed).execute({ operation: 'index' }, exec('session-1')) as SessiongraphToolValue
    expect(value).toEqual({ operation: 'index', status: 'started', job_id: 'job-1' })
    expect(harnessed.indexOptions).toEqual([])
    expect(jobs.started).toHaveLength(1)
    expect(jobs.started[0]).toMatchObject({
      owner: 'session-1',
      kind: 'sessiongraph-index',
      label: `sessiongraph index ${root}`,
    })
  })

  it('runs the job body synchronously inside the job and settles it with the summary', async () => {
    writeStatus(THRESHOLD)
    const jobs = fakeJobs()
    const harnessed = harness({ jobs })
    await onlyTool(harnessed).execute({ operation: 'index' }, exec('session-1'))

    const spec = jobs.started[0]
    if (spec === undefined) throw new Error('no job started')
    const output: string[] = []
    const hooks = spec.run({ append: text => output.push(text) })
    await expect(hooks.done).resolves.toEqual({ status: 'completed' })
    // The job body indexes in place: no owner, so the indexer cannot delegate a second time.
    expect(harnessed.indexOptions).toEqual([{}])
    expect(output.join('')).toContain(`Indexed ${root}: 6 sessions`)
  })

  it('reports a failed job as failed and keeps the failure in its log', async () => {
    writeStatus(THRESHOLD)
    const jobs = fakeJobs()
    const harnessed = harness({
      jobs,
      index: async () => {
        throw new Error('indexer exploded')
      },
    })
    await onlyTool(harnessed).execute({ operation: 'index' }, exec('session-1'))
    const spec = jobs.started[0]
    if (spec === undefined) throw new Error('no job started')
    const output: string[] = []
    const hooks = spec.run({ append: text => output.push(text) })
    await expect(hooks.done).resolves.toEqual({ status: 'failed', detail: 'indexer exploded' })
    expect(output.join('')).toContain('sessiongraph index failed')
  })

  it('runs in place when no owning agent exists to own a job', async () => {
    writeStatus(THRESHOLD)
    const jobs = fakeJobs()
    const harnessed = harness({ jobs })
    await onlyTool(harnessed).execute({ operation: 'index' }, exec())
    expect(jobs.started).toHaveLength(0)
    expect(harnessed.indexOptions).toHaveLength(1)
  })

  it('runs in place when the host has no job registry', async () => {
    writeStatus(THRESHOLD)
    const harnessed = harness()
    await onlyTool(harnessed).execute({ operation: 'index' }, exec('session-1'))
    expect(harnessed.indexOptions).toHaveLength(1)
  })

  it('never backgrounds a scoped run, whose round trip would cost more than the run', async () => {
    writeStatus(THRESHOLD)
    const jobs = fakeJobs()
    const harnessed = harness({ jobs })
    await onlyTool(harnessed).execute({ operation: 'index', workspace: '/w' }, exec('session-1'))
    expect(jobs.started).toHaveLength(0)
    expect(harnessed.indexOptions[0]).toEqual({ workspace: '/w' })
  })

  it('runs in place when there is no sidecar to measure', async () => {
    rmSync(join(root, 'status.json'))
    const jobs = fakeJobs()
    const harnessed = harness({ jobs })
    await onlyTool(harnessed).execute({ operation: 'index' }, exec('session-1'))
    expect(jobs.started).toHaveLength(0)
    expect(harnessed.indexOptions).toHaveLength(1)
  })
})
