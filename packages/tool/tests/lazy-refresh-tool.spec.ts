/**
 * Tool-level wiring tests for the lazy refresh: the coordinator is unit-tested next door, but what
 * matters to the model is the composed path — `apply` registers the tool, `execute` decides whether
 * to refresh, the query always runs, and the answer carries the staleness marker when it should.
 *
 * The `ctx` here is a structural stand-in for the three services the plugin injects and nothing more:
 * importing a real cordis Context would drag the host composition in, while the seam itself is
 * exercised by the refresh unit tests.
 * @module dsh-plugin-sessiongraph-tool/tests/lazy-refresh-tool
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SessiongraphIndexReport, SessiongraphSearchResult } from 'dsh-plugin-sessiongraph-service'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import type { Config } from '../src/index.ts'

/** The slice of a registered tool these tests drive. */
interface RegisteredTool {
  name: string
  execute(args: unknown, exec: unknown): Promise<unknown>
  output: { render(args: unknown, value: unknown): { type: string; text: string }[] }
}

/** One composed tool family over a fake service, with the call order it observed. */
interface Harness {
  readonly tools: Map<string, RegisteredTool>
  readonly calls: string[]
  /** The options object each `ctx.sessiongraph.index` call carried. */
  readonly options: Array<Record<string, unknown>>
}

const THRESHOLD = 300_000
const STALE = 600_000
const FRESH = 1_000

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sessiongraph-lazy-'))
  writeFileSync(join(root, 'index.db'), 'stub index')
  writeStatus(STALE)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

/** Write the sidecar prompt assembly and the refresh decision both read. */
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

/** A finished report shaped like the sessions indexer's. */
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

/** One search hit, so the answer is recognizably the query's own result. */
function searchResult(): SessiongraphSearchResult {
  return {
    operation: 'search',
    hits: [{
      sessionId: '037ad8fc-29b8-4a69-9a02-e75f9cc8fb45' as SessiongraphSearchResult['hits'][number]['sessionId'],
      title: '改广告 SDK',
      workspace: '/Users/admin/www/dsh-community',
      time: Date.now(),
      kind: 'user',
      seq: 12,
      turn: 3,
      snippet: '我今天在改[广告]SDK',
      length: 30,
    }],
    total: 1,
    truncated: false,
  }
}

/**
 * Register the plugin against a fake service.
 * @param index - what `ctx.sessiongraph.index` does; the seam's call is recorded either way.
 * @param options - per-test overrides (threshold, config shape).
 * @returns the registered tools and the observed call order.
 */
function harness(
  index: () => Promise<unknown>,
  options: { threshold?: number; indexRoot?: string; liveSessions?: number } = {},
): Harness {
  const tools = new Map<string, RegisteredTool>()
  const calls: string[] = []
  const optionsSeen: Array<Record<string, unknown>> = []
  const sections: string[] = []
  const indexRoot = options.indexRoot ?? root
  const ctx = {
    systemPrompt: {
      section: (section: { text: string | ((context: unknown) => string) }) => {
        sections.push(typeof section.text === 'string' ? section.text : section.text({}))
      },
    },
    tools: {
      register: (definition: RegisteredTool) => {
        tools.set(definition.name, definition)
      },
    },
    sessiongraph: {
      async query(request: { operation: string }) {
        calls.push(`query:${request.operation}`)
        return request.operation === 'status'
          ? {
              operation: 'status',
              indexed: true,
              indexPath: join(indexRoot, 'index.db'),
              sessions: 1,
              entries: 1,
              workspaces: 1,
              ...(options.liveSessions === undefined ? {} : { liveSessions: options.liveSessions }),
              indexedAt: Date.now(),
              bytes: 100,
            }
          : searchResult()
      },
      async index(_root: string, indexOptions: Record<string, unknown>) {
        calls.push('index')
        optionsSeen.push(indexOptions)
        return index()
      },
    },
  }
  const config: Config = {
    indexRoot,
    maxLimit: 100,
    maxSnippetChars: 600,
    freshnessThresholdMs: options.threshold ?? THRESHOLD,
    timeoutMs: 30_000,
    backgroundIndexThreshold: 1_000,
  }
  apply(ctx as unknown as Context, config)
  return { tools, calls, options: optionsSeen }
}

/** The execution context a tool body reads: the signal, plus an owning agent when a test needs one. */
function exec(agentId?: string): unknown {
  return {
    signal: new AbortController().signal,
    ...(agentId === undefined ? {} : { agent: { id: agentId } }),
  }
}

/** Fetch a registered tool, failing loudly when the plugin did not register it. */
function tool(harnessed: Harness, name: string): RegisteredTool {
  const found = harnessed.tools.get(name)
  if (found === undefined) throw new Error(`tool ${name} was not registered`)
  return found
}

describe('lazy refresh through the registered tool', () => {
  it('refreshes before the query and answers with the refreshed result', async () => {
    const subject = harness(async () => report())
    const value = await tool(subject, 'sessiongraph').execute({ operation: 'search', query: '广告' }, exec('session-1'))

    expect(subject.calls).toEqual(['index', 'query:search'])
    // A lazy refresh must stay synchronous even when the query has an owning agent: no `owner`,
    // hence no background job to wait for.
    expect(subject.options[0]).toEqual({ force: false })
    expect(value).toMatchObject({ operation: 'search', total: 1 })
    expect('stale' in (value as object)).toBe(false)
    const text = tool(subject, 'sessiongraph').output.render({ operation: 'search', query: '广告' }, value)[0]?.text
    expect(text).toContain('我今天在改[广告]SDK')
    expect(text).not.toContain('可能不是最新')
  })

  it('answers from the existing index when the refresh fails, and says the answer may be behind', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const subject = harness(async () => {
      throw new Error('indexer exploded')
    })
    const value = await tool(subject, 'sessiongraph').execute({ operation: 'search', query: '广告' }, exec())

    expect(subject.calls).toEqual(['index', 'query:search'])
    expect(value).toMatchObject({ operation: 'search', total: 1, stale: true })
    const text = tool(subject, 'sessiongraph').output.render({ operation: 'search', query: '广告' }, value)[0]?.text
    expect(text).toContain('可能不是最新')
    expect(console.error).toHaveBeenCalledTimes(1)
  })

  it('runs one incremental index for two queries issued together', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const subject = harness(async () => {
      await gate
      return report()
    })
    const registered = tool(subject, 'sessiongraph')

    const first = registered.execute({ operation: 'search', query: '广告' }, exec())
    const second = registered.execute({ operation: 'timeline' }, exec())
    release()
    const values = await Promise.all([first, second])

    expect(subject.calls.filter(call => call === 'index')).toHaveLength(1)
    expect(values).toHaveLength(2)
  })

  it('leaves a fresh index alone and skips the refresh entirely when it is disabled', async () => {
    writeStatus(FRESH)
    const fresh = harness(async () => report())
    await tool(fresh, 'sessiongraph').execute({ operation: 'search', query: '广告' }, exec())
    expect(fresh.calls).toEqual(['query:search'])

    writeStatus(STALE)
    const disabled = harness(async () => report(), { threshold: 0 })
    await tool(disabled, 'sessiongraph').execute({ operation: 'search', query: '广告' }, exec())
    expect(disabled.calls).toEqual(['query:search'])
  })

  it('never refreshes for status, which describes the index itself', async () => {
    const subject = harness(async () => report())
    const value = await tool(subject, 'sessiongraph').execute({ operation: 'status' }, exec())

    expect(subject.calls).toEqual(['query:status'])
    expect(value).toMatchObject({ operation: 'status', indexed: true })
    // The store omitted the live count; the tool answers zero and the render says so.
    expect(value).toMatchObject({ live_sessions: 0 })
    const text = tool(subject, 'sessiongraph').output.render({ operation: 'status' }, value)[0]?.text
    expect(text).toContain('实时会话：0（当前没有正在跑的会话）')
  })

  it('carries the store\'s live-session count into the status answer', async () => {
    const subject = harness(async () => report(), { liveSessions: 2 })
    const value = await tool(subject, 'sessiongraph').execute({ operation: 'status' }, exec())

    expect(value).toMatchObject({ live_sessions: 2 })
    const text = tool(subject, 'sessiongraph').output.render({ operation: 'status' }, value)[0]?.text
    expect(text).toContain('实时会话：2 个（当前还在跑、未落盘）')
  })
})
