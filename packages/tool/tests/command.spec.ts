/**
 * `/sessiongraph` command tests: parsing is pure, and the dispatched subcommands are exercised
 * through a fake command registry so the assertions cover the text a person actually reads.
 * @module dsh-plugin-sessiongraph-tool/tests/command
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessiongraphError } from 'dsh-plugin-sessiongraph-service'
import type {
  SessiongraphIndexReport,
  SessiongraphSearchResult,
  SessiongraphStatusResult,
  SessiongraphWorkspacesResult,
} from 'dsh-plugin-sessiongraph-service'
import { describe, expect, it } from 'vitest'
import {
  COMMAND_INPUT_HINT,
  COMMAND_NAME,
  COMMAND_USAGE,
  invocationWorkspace,
  parseCommand,
  registerCommands,
  runCommand,
} from '../src/command.ts'
import type { CommandDefinition, CommandInvocation } from '../src/command.ts'

/** The index root every fixture assumes. */
const INDEX_ROOT = '/tmp/sessiongraph-command'

/** One registered definition plus the invoker that reaches its handler. */
interface CommandHarness {
  readonly definitions: CommandDefinition[]
  invoke(rawInput: string, workspace?: string): Promise<{ kind: string; text?: string }>
}

/** A snapshot of the seam calls a subcommand made. */
interface Calls {
  readonly queries: Array<Record<string, unknown>>
  readonly indexes: Array<Record<string, unknown>>
}

/**
 * Register the command against a fake command registry.
 * @param service - what `ctx.sessiongraph` answers.
 * @returns the captured definition and an invoker.
 */
function harness(service: {
  query?: (request: Record<string, unknown>) => Promise<unknown>
  index?: (root: string, options: Record<string, unknown>) => Promise<unknown>
}, calls: Calls = { queries: [], indexes: [] }): CommandHarness & { readonly calls: Calls } {
  const definitions: CommandDefinition[] = []
  const child = {
    commands: {
      register: (definition: CommandDefinition) => {
        definitions.push(definition)
        return () => {}
      },
    },
    effect: (install: () => unknown) => {
      install()
      return () => {}
    },
  }
  const ctx = {
    inject: (_deps: string[], callback: (child: unknown) => void) => {
      callback(child)
    },
    sessiongraph: {
      async query(request: Record<string, unknown>) {
        calls.queries.push(request)
        if (service.query === undefined) throw new Error('unexpected query')
        return service.query(request)
      },
      async index(root: string, options: Record<string, unknown>) {
        calls.indexes.push(options)
        if (service.index === undefined) throw new Error('unexpected index')
        return service.index(root, options)
      },
    },
  }
  registerCommands(ctx as unknown as Context, { indexRoot: INDEX_ROOT, maxSnippetChars: 600 })
  const definition = definitions[0]
  if (definition === undefined) throw new Error('the command was not registered')
  return {
    definitions,
    calls,
    async invoke(rawInput, workspace) {
      const invocation: CommandInvocation = {
        rawInput,
        signal: new AbortController().signal,
        agent: {
          id: 'session-1',
          session: { header: { ...(workspace === undefined ? {} : { cwd: workspace }) } },
        },
      }
      return definition.handler(invocation)
    },
  }
}

/** A finished index report. */
function report(): SessiongraphIndexReport {
  return {
    indexPath: `${INDEX_ROOT}/index.db`,
    added: 3,
    updated: 2,
    skipped: 486,
    removed: 0,
    discovered: 491,
    failed: [],
    entries: 12345,
    sessions: 491,
    workspaces: 25,
    bytes: 617 * 1024 ** 2,
    elapsedMs: 12_340,
  }
}

/**
 * An indexed status answer.
 * @param liveSessions - live-session count; omitted to model a store that predates live indexing.
 */
function status(liveSessions?: number): SessiongraphStatusResult {
  return {
    operation: 'status',
    indexed: true,
    indexPath: `${INDEX_ROOT}/index.db`,
    sessions: 491,
    entries: 12345,
    workspaces: 25,
    ...(liveSessions === undefined ? {} : { liveSessions }),
    indexedAt: new Date(2026, 10, 3, 10, 40).getTime(),
    bytes: 617 * 1024 ** 2,
  }
}

/** One search result. */
function search(hits: number): SessiongraphSearchResult {
  return {
    operation: 'search',
    hits: Array.from({ length: hits }, (_, index) => ({
      sessionId: `session-${index}` as SessiongraphSearchResult['hits'][number]['sessionId'],
      title: index === 0 ? '改广告 SDK' : undefined,
      workspace: '/Users/admin/www/dsh-community',
      time: new Date(2026, 10, 3, 10, 37).getTime(),
      kind: 'user',
      seq: 12,
      turn: 3,
      snippet: '我今天在改[广告]SDK',
      length: 30,
    })),
    total: hits,
    truncated: false,
  }
}

describe('parseCommand', () => {
  it('treats an empty line as status', () => {
    expect(parseCommand('')).toEqual({ kind: 'status' })
    expect(parseCommand('   ')).toEqual({ kind: 'status' })
  })

  it('parses every subcommand', () => {
    expect(parseCommand('status')).toEqual({ kind: 'status' })
    expect(parseCommand('workspaces')).toEqual({ kind: 'workspaces' })
    expect(parseCommand('index')).toEqual({ kind: 'index', force: false })
    expect(parseCommand('index --force')).toEqual({ kind: 'index', force: true })
    expect(parseCommand('  index   --force  ')).toEqual({ kind: 'index', force: true })
  })

  it('keeps a search query as free text, including its inner spacing', () => {
    expect(parseCommand('search 广告 SDK')).toEqual({ kind: 'search', query: '广告 SDK' })
    expect(parseCommand('search   广告   SDK ')).toEqual({ kind: 'search', query: '广告   SDK' })
    expect(parseCommand('search')).toEqual({ kind: 'search', query: '' })
  })

  it('reports an unknown subcommand instead of guessing', () => {
    expect(parseCommand('purge now')).toEqual({ kind: 'unknown', subcommand: 'purge' })
  })
})

describe('runCommand', () => {
  it('registers one stable definition with the documented discovery copy', () => {
    const subject = harness({})
    expect(subject.definitions).toHaveLength(1)
    expect(subject.definitions[0]).toMatchObject({
      name: COMMAND_NAME,
      input: { hint: COMMAND_INPUT_HINT },
    })
    expect(subject.definitions[0]?.definitionId).toBe('dsh-plugin-sessiongraph/command/sessiongraph')
  })

  it('answers an unknown subcommand with the usage line and the available list', async () => {
    const result = await harness({}).invoke('purge')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('未知的子命令 "purge"')
    expect(result.text).toContain(COMMAND_USAGE)
    expect(result.text).toContain('status')
    expect(result.text).toContain('index [--force]')
    expect(result.text).toContain('search <query>')
    expect(result.text).toContain('workspaces')
  })

  it('prints the index state, its freshness, and the live-session gap', async () => {
    const result = await harness({ query: async () => status(3) }).invoke('status', '/Users/admin/www/dsh-community')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('491 个会话')
    expect(result.text).toContain('12345 条可检索条目')
    expect(result.text).toContain('25 个工作区')
    expect(result.text).toContain('617 MB')
    expect(result.text).toContain('2026-11-03 10:40')
    expect(result.text).toContain('实时会话：3 个（当前还在跑、未落盘）')
    expect(result.text).toContain('当前工作区：/Users/admin/www/dsh-community')
  })

  it('says zero live sessions explicitly', async () => {
    const result = await harness({ query: async () => status(0) }).invoke('status')
    expect(result.text).toContain('实时会话：0（当前没有正在跑的会话）')
  })

  it('falls back to zero when the store predates live indexing', async () => {
    const result = await harness({ query: async () => status() }).invoke('status')
    expect(result.text).toContain('实时会话：0（当前没有正在跑的会话）')
  })

  it('turns "no index" into an answer with the command that fixes it', async () => {
    const result = await harness({
      query: async () => {
        throw new SessiongraphError('no store indexes the root', 'SESSIONGRAPH_UNAVAILABLE')
      },
    }).invoke('status')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('还没有索引')
    expect(result.text).toContain(`/${COMMAND_NAME} index`)
  })

  it('runs a search and prints title, time, workspace, and snippet', async () => {
    const result = await harness({ query: async () => search(2) }).invoke('search 广告')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('命中「广告」')
    expect(result.text).toContain('2026-11-03 10:37')
    expect(result.text).toContain('《改广告 SDK》')
    expect(result.text).toContain('（无标题）')
    expect(result.text).toContain('/Users/admin/www/dsh-community')
    expect(result.text).toContain('我今天在改[广告]SDK')
    expect(result.text).not.toContain('"')
  })

  it('answers an empty search with a hint instead of an empty screen', async () => {
    const subject = harness({ query: async () => search(0) })
    const result = await subject.invoke('search 不存在的词')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('没有命中「不存在的词」')
    expect(result.text).toContain('两字词即可命中')
    expect(subject.calls.queries[0]).toMatchObject({ operation: 'search', query: '不存在的词' })
  })

  it('clips a long snippet so one hit cannot fill the terminal', async () => {
    const long = search(1)
    const hit = long.hits[0]
    if (hit !== undefined) hit.snippet = 'x'.repeat(600)
    const result = await harness({ query: async () => long }).invoke('search 广告')
    const lines = (result.text ?? '').split('\n')
    const snippetLine = lines[2] ?? ''
    expect(snippetLine.length).toBeLessThanOrEqual(202)
    expect(snippetLine.endsWith('…')).toBe(true)
  })

  it('rejects a search without a query', async () => {
    const result = await harness({}).invoke('search')
    expect(result.kind).toBe('error')
    expect(result.text).toContain(`/${COMMAND_NAME} search <query>`)
  })

  it('runs a manual index synchronously and passes the owning session id', async () => {
    const subject = harness({ index: async () => report() })
    const result = await subject.invoke('index --force')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('建索引完成')
    expect(result.text).toContain('新增 3、更新 2、跳过 486、移除 0')
    expect(result.text).toContain('491 个会话')
    expect(subject.calls.indexes[0]).toEqual({ force: true, owner: 'session-1' })
    expect(subject.calls.indexes[0]).not.toHaveProperty('workspace')
  })

  it('mentions replayed live sessions, and stays quiet when there were none', async () => {
    const replaying = await harness({ index: async () => ({ ...report(), liveSessions: 2 }) }).invoke('index')
    expect(replaying.text).toContain('本次重放 2 个实时会话')

    const quiet = await harness({ index: async () => report() }).invoke('index')
    expect(quiet.text).not.toContain('本次重放')
  })

  it('prints the job id when a large manual index is delegated', async () => {
    const result = await harness({ index: async () => ({ ...report(), jobId: 'job-9' }) }).invoke('index')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('已在后台建索引')
    expect(result.text).toContain('jobId=job-9')
    expect(result.text).toContain(`/${COMMAND_NAME} status`)
    expect(result.text).not.toContain('建索引完成')
  })

  it('lists workspaces and marks the caller’s own', async () => {
    const workspaces: SessiongraphWorkspacesResult = {
      operation: 'workspaces',
      workspaces: [
        {
          workspace: '/Users/admin/www/dsh-community',
          sessions: 12,
          entries: 340,
          firstAt: new Date(2026, 9, 1, 9, 0).getTime(),
          lastAt: new Date(2026, 10, 3, 10, 37).getTime(),
        },
        {
          workspace: '/Users/admin/www/other',
          sessions: 3,
          entries: 40,
          firstAt: new Date(2026, 9, 2, 9, 0).getTime(),
          lastAt: new Date(2026, 10, 1, 10, 0).getTime(),
        },
      ],
      total: 2,
    }
    const result = await harness({ query: async () => workspaces }).invoke('workspaces', '/Users/admin/www/dsh-community')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('2 个工作区')
    expect(result.text).toContain('* /Users/admin/www/dsh-community · 12 会话 · 340 条')
    expect(result.text).toContain('  /Users/admin/www/other · 3 会话 · 40 条')
    expect(result.text).toContain('当前工作区')
  })

  it('does nothing at all when the composition has no command registry', () => {
    const ctx = {
      inject: () => {
        throw new Error('unknown service commands')
      },
    }
    expect(() => registerCommands(ctx as unknown as Context, {
      indexRoot: INDEX_ROOT,
      maxSnippetChars: 600,
    })).not.toThrow()
  })

  it('reads the workspace from the invocation only', () => {
    expect(invocationWorkspace({ rawInput: '', agent: { session: { header: { cwd: '/w' } } } })).toBe('/w')
    expect(invocationWorkspace({ rawInput: '' })).toBeUndefined()
    expect(invocationWorkspace({ rawInput: '', agent: { session: { header: { cwd: '  ' } } } })).toBeUndefined()
  })

  it('dispatches through runCommand with the same text a handler would return', async () => {
    const ctx = {
      sessiongraph: { async query() { return search(1) } },
    }
    const result = await runCommand(ctx as unknown as Context, {
      indexRoot: INDEX_ROOT,
      maxSnippetChars: 600,
    }, { rawInput: 'search 广告', signal: new AbortController().signal })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('命中「广告」')
  })
})
