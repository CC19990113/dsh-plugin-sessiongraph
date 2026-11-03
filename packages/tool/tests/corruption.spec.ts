/**
 * The one failure this tool repairs instead of reporting.
 *
 * A damaged index is derived data: the session logs are untouched, so rebuilding is always safe and
 * always better than telling the model "database disk image is malformed". These tests pin the
 * composition — detect, rebuild once, retry, and only then give up — because that ordering is what
 * makes the repair invisible.
 * @module dsh-plugin-sessiongraph-tool/tests/corruption
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessiongraphError } from 'dsh-plugin-sessiongraph-service'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import type { Config } from '../src/index.ts'

/** The slice of a registered tool these tests drive. */
interface RegisteredTool {
  name: string
  execute(args: unknown, exec: unknown): Promise<unknown>
  output: { render(args: unknown, value: unknown): { type: string; text: string }[] }
}

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sessiongraph-corrupt-'))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

/**
 * Register the plugin against a service whose first `n` searches fail with `failure`.
 * @param failure - what the failing search throws.
 * @param remaining - how many searches fail before one succeeds.
 * @param queries - records the operations the tool asked for.
 * @returns the registered tools and the call order.
 */
function harness(failure: unknown, remaining = 1, queries: string[] = []): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>()
  let left = remaining
  const ctx = {
    systemPrompt: { section: () => {} },
    tools: { register: (definition: RegisteredTool) => tools.set(definition.name, definition) },
    sessiongraph: {
      async query(request: { operation: string }) {
        queries.push(request.operation)
        if (request.operation !== 'search') return { operation: 'status', indexed: true, indexPath: join(root, 'index.db'), sessions: 1, entries: 1, workspaces: 1, indexedAt: Date.now(), bytes: 1 }
        if (left > 0) {
          left -= 1
          throw failure
        }
        return {
          operation: 'search',
          hits: [],
          total: 0,
          truncated: false,
        }
      },
      async index() {
        queries.push('index')
        return {
          indexPath: join(root, 'index.db'),
          added: 0, updated: 0, skipped: 0, removed: 0, discovered: 0, failed: [],
          entries: 0, sessions: 0, workspaces: 0, bytes: 0, elapsedMs: 1,
        }
      },
    },
  }
  const config: Config = {
    indexRoot: root,
    maxLimit: 100,
    maxSnippetChars: 600,
    freshnessThresholdMs: 0,
    timeoutMs: 30_000,
    indexTimeoutMs: 300_000,
  }
  apply(ctx as unknown as Context, config)
  return tools
}

const exec = { signal: new AbortController().signal, agent: { id: 'session-1' } }

describe('corrupt index repair', () => {
  it('rebuilds once and answers from the new index', async () => {
    const queries: string[] = []
    const tools = harness(new SessiongraphError('database disk image is malformed', 'SESSIONGRAPH_CORRUPT'), 1, queries)
    const tool = tools.get('sessiongraph')
    expect(tool).toBeDefined()

    const value = (await tool!.execute({ operation: 'search', query: '广告' }, exec)) as { total: number }
    expect(value.total).toBe(0)
    // search → index(force) → search again
    expect(queries).toEqual(['search', 'index', 'search'])
  })

  it('recognizes SQLite corruption even when it is not wrapped in the seam error', async () => {
    const queries: string[] = []
    const tools = harness(new Error('SQLITE_CORRUPT: database disk image is malformed'), 1, queries)
    const value = (await tools.get('sessiongraph')!.execute({ operation: 'search', query: '广告' }, exec)) as { total: number }
    expect(value.total).toBe(0)
    expect(queries).toEqual(['search', 'index', 'search'])
  })

  it('reports the original failure when the rebuild does not fix it', async () => {
    const queries: string[] = []
    const tools = harness(new SessiongraphError('database disk image is malformed', 'SESSIONGRAPH_CORRUPT'), 2, queries)
    await expect(tools.get('sessiongraph')!.execute({ operation: 'search', query: '广告' }, exec)).rejects.toThrow(
      /malformed/,
    )
    // One repair attempt, not a loop.
    expect(queries).toEqual(['search', 'index', 'search'])
  })

  it('does not rebuild for a failure that is not corruption', async () => {
    const queries: string[] = []
    const tools = harness(new SessiongraphError('no store claims this root', 'SESSIONGRAPH_UNAVAILABLE'), 1, queries)
    await expect(tools.get('sessiongraph')!.execute({ operation: 'search', query: '广告' }, exec)).rejects.toThrow()
    expect(queries).toEqual(['search'])
  })
})
