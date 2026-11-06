import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { Sessiongraph, SessiongraphError, SessiongraphIndexerId, SessiongraphSessionId, SessiongraphStoreId } from '../src/index.ts'
import type {
  SessiongraphEventResult,
  SessiongraphIndexOptions,
  SessiongraphIndexReport,
  SessiongraphIndexer,
  SessiongraphRequest,
  SessiongraphResultFor,
  SessiongraphStatusResult,
  SessiongraphStoreProvider,
  SessiongraphTraceResult,
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

/**
 * `event` and `trace` arrived when the model-facing surface collapsed into one tool, and their
 * answers are discriminated unions — a `trace` of a session and a `trace` of an event share an
 * operation name but nothing else. These tests pin the seam's half of that contract: the request
 * reaches the store untouched, and whatever shape the store returns is what the caller sees.
 */
describe('event and trace routing', () => {
  /** A store that records every request and answers with the shape that request asks for. */
  function recordingStore(seen: SessiongraphRequest[]): SessiongraphStoreProvider {
    const summary = {
      sessionId: SessiongraphSessionId('session-1'),
      title: undefined,
      workspace: '/w',
      createdAt: 1,
      lastAt: 2,
      turns: 1,
      entries: 1,
      parentSession: undefined,
      origin: undefined,
      agentPreset: undefined,
    }
    return {
      id: SessiongraphStoreId('recorder'),
      indexes: async (indexRoot: string) => indexRoot === ROOT,
      query: async <R extends SessiongraphRequest>(request: R): Promise<SessiongraphResultFor<R>> => {
        seen.push(request)
        const answer = ((): unknown => {
          if (request.operation === 'event') {
            return {
              operation: 'event',
              session: summary,
              event: { seq: request.seq, time: 9, type: 'tool/call', data: { name: 'bash' } },
              before: [],
              after: [],
            }
          }
          if (request.operation === 'trace') {
            return request.seq === undefined
              ? { operation: 'trace', kind: 'session', target: summary, ancestors: [], descendants: [], complete: true }
              : {
                  operation: 'trace',
                  kind: 'event',
                  session: summary,
                  event: { seq: request.seq, time: 9, type: 'tool/result' },
                  replacedBy: [],
                  shadowedSeqs: [],
                  sourceEventSeqs: [request.seq - 1],
                }
          }
          return {
            operation: 'status',
            indexed: true,
            indexPath: request.indexRoot,
            sessions: 1,
            entries: 1,
            workspaces: 1,
            indexedAt: 1,
            bytes: 1,
          }
        })()
        return answer as SessiongraphResultFor<R>
      },
    }
  }

  it('forwards an event request to the store with its window intact', async () => {
    const { sessiongraph } = await service()
    const seen: SessiongraphRequest[] = []
    sessiongraph.registerStore(recordingStore(seen))
    const result = (await sessiongraph.query({
      operation: 'event',
      indexRoot: ROOT,
      sessionId: 'session-1',
      seq: 7,
      windowBefore: 2,
      windowAfter: 1,
    })) as SessiongraphEventResult
    expect(seen[0]).toMatchObject({ operation: 'event', seq: 7, windowBefore: 2, windowAfter: 1 })
    expect(result.event.seq).toBe(7)
    expect(result.event.data).toEqual({ name: 'bash' })
  })

  it('discriminates a session trace from an event trace by the presence of seq', async () => {
    const { sessiongraph } = await service()
    sessiongraph.registerStore(recordingStore([]))
    const lineage = (await sessiongraph.query({ operation: 'trace', indexRoot: ROOT, sessionId: 'session-1' })) as SessiongraphTraceResult
    expect(lineage.kind).toBe('session')
    const relation = (await sessiongraph.query({ operation: 'trace', indexRoot: ROOT, sessionId: 'session-1', seq: 7 })) as SessiongraphTraceResult
    expect(relation.kind).toBe('event')
    if (relation.kind === 'event') expect(relation.sourceEventSeqs).toEqual([6])
  })
})
