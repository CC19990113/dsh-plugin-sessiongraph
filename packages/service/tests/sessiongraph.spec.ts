import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { Sessiongraph, SessiongraphError, SessiongraphIndexerId, SessiongraphStoreId } from '../src/index.ts'
import type {
  SessiongraphIndexOptions,
  SessiongraphIndexReport,
  SessiongraphIndexer,
  SessiongraphRequest,
  SessiongraphResultFor,
  SessiongraphStatusResult,
  SessiongraphStoreProvider,
} from '../src/index.ts'

const ROOT = '/tmp/sessiongraph-registry-test'

/** A store that claims exactly the roots it was told to claim. */
function store(id: string, claims: readonly string[]): SessiongraphStoreProvider {
  return {
    id: SessiongraphStoreId(id),
    indexes: async (indexRoot: string) => claims.includes(indexRoot),
    query: async <R extends SessiongraphRequest>(request: R): Promise<SessiongraphResultFor<R>> =>
      ({
        operation: 'status',
        indexed: true,
        indexPath: request.indexRoot,
        sessions: 1,
        entries: 1,
        workspaces: 1,
        indexedAt: 1,
        bytes: 1,
      }) as SessiongraphResultFor<R>,
  }
}

/** An indexer that claims exactly the roots it was told to claim. */
function indexer(id: string, claims: readonly string[]): SessiongraphIndexer {
  return {
    id: SessiongraphIndexerId(id),
    canIndex: async (indexRoot: string) => claims.includes(indexRoot),
    index: async (indexRoot: string, options: SessiongraphIndexOptions): Promise<SessiongraphIndexReport> => ({
      indexPath: `${indexRoot}/index.db`,
      added: options.force ? 1 : 0,
      updated: 0,
      skipped: 0,
      removed: 0,
      discovered: 1,
      failed: [],
      entries: 1,
      sessions: 1,
      workspaces: 1,
      bytes: 1,
      elapsedMs: 1,
    }),
  }
}

async function service(): Promise<{ ctx: Context; sessiongraph: Sessiongraph }> {
  const ctx = new Context()
  await ctx.plugin(Sessiongraph)
  return { ctx, sessiongraph: ctx.get('sessiongraph') as Sessiongraph }
}

describe('registry', () => {
  it('rejects a store claiming a duplicate id', async () => {
    const { sessiongraph } = await service()
    sessiongraph.registerStore(store('only', [ROOT]))
    expect(() => sessiongraph.registerStore(store('only', [ROOT]))).toThrow(SessiongraphError)
  })

  it('unregisters a store when its disposer runs', async () => {
    const { sessiongraph } = await service()
    const dispose = sessiongraph.registerStore(store('only', [ROOT]))
    expect(await sessiongraph.available(ROOT)).toBe(true)
    dispose()
    expect(await sessiongraph.available(ROOT)).toBe(false)
  })
})

describe('routing', () => {
  it('answers status with zeros when no store claims the root', async () => {
    const { sessiongraph } = await service()
    sessiongraph.registerStore(store('elsewhere', ['/tmp/other']))
    const result = (await sessiongraph.query({ operation: 'status', indexRoot: ROOT })) as SessiongraphStatusResult
    expect(result.indexed).toBe(false)
    expect(result.indexPath).toBe(`${ROOT}/index.db`)
    expect(result.sessions).toBe(0)
  })

  it('still fails a non-status query when no store claims the root', async () => {
    const { sessiongraph } = await service()
    sessiongraph.registerStore(store('elsewhere', ['/tmp/other']))
    await expect(
      sessiongraph.query({ operation: 'search', query: '广告', limit: 5, indexRoot: ROOT }),
    ).rejects.toMatchObject({ code: 'SESSIONGRAPH_UNAVAILABLE' })
  })

  it('does not hide a conflict behind a zero status', async () => {
    const { sessiongraph } = await service()
    sessiongraph.registerStore(store('one', [ROOT]))
    sessiongraph.registerStore(store('two', [ROOT]))
    await expect(
      sessiongraph.query({ operation: 'status', indexRoot: ROOT }),
    ).rejects.toMatchObject({ code: 'SESSIONGRAPH_CONFLICT' })
  })

  it('fails when two stores claim the same root', async () => {
    const { sessiongraph } = await service()
    sessiongraph.registerStore(store('one', [ROOT]))
    sessiongraph.registerStore(store('two', [ROOT]))
    await expect(
      sessiongraph.query({ operation: 'status', indexRoot: ROOT }),
    ).rejects.toMatchObject({ code: 'SESSIONGRAPH_CONFLICT' })
  })

  it('routes to the single claimant regardless of registration order', async () => {
    const { sessiongraph } = await service()
    sessiongraph.registerStore(store('first', ['/tmp/a']))
    sessiongraph.registerStore(store('second', [ROOT]))
    const result = (await sessiongraph.query({ operation: 'status', indexRoot: ROOT })) as SessiongraphStatusResult
    expect(result.indexed).toBe(true)
  })

  it('routes index runs through the one claiming indexer', async () => {
    const { sessiongraph } = await service()
    sessiongraph.registerIndexer(indexer('writer', [ROOT]))
    const report = await sessiongraph.index(ROOT, { force: true })
    expect(report.added).toBe(1)
  })

  it('fails an index run when no indexer claims the root', async () => {
    const { sessiongraph } = await service()
    await expect(sessiongraph.index(ROOT)).rejects.toMatchObject({ code: 'SESSIONGRAPH_UNAVAILABLE' })
  })
})
