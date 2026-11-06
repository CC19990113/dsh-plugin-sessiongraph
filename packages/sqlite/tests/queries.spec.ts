import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { SessiongraphError } from 'dsh-plugin-sessiongraph-service'
import { IndexPool } from '../src/database.ts'
import { event, search, trace } from '../src/queries.ts'
import { seedIndex } from './fixture.ts'
import type { SeedIndex, SeedSession } from './fixture.ts'

const WORKSPACE = '/Users/admin/www/adx-admin'

const SESSION_A = 'aaaa1111-0000-4000-8000-000000000001'
const SESSION_B = 'bbbb2222-0000-4000-8000-000000000002'
const SESSION_DUP_A = 'abcd0001-0000-4000-8000-000000000003'
const SESSION_DUP_B = 'abcd0002-0000-4000-8000-000000000004'

const roots: string[] = []
const pools: IndexPool[] = []

afterEach(async () => {
  for (const pool of pools.splice(0)) pool.close()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** Seed a fresh index root and register everything for cleanup. */
async function project(seed: SeedIndex): Promise<string> {
  const root = await seedIndex(seed)
  roots.push(root)
  return root
}

/** An open connection through a pool registered for cleanup. */
function connection(root: string): ReturnType<IndexPool['acquire']> {
  const pool = new IndexPool(1)
  pools.push(pool)
  return pool.acquire(root)
}

/** A temp directory registered for cleanup. */
async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sessiongraph-queries-'))
  roots.push(root)
  return root
}

/** Compress one log line as its own frame, exactly how the harness appends them. */
function frame(record: unknown): Buffer {
  return zstdCompressSync(Buffer.from(`${JSON.stringify(record)}\n`))
}

/** One event line carrying a surface marker. */
function logEvent(type: string, seq: number, time: number, data: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, seq, time, data, surfaceOp: 'append', ...extra }
}

/** Two sessions both mentioning the same term, one of them twice. */
const SEARCH_SEED: SeedIndex = {
  sessions: [
    {
      id: SESSION_A,
      workspace: WORKSPACE,
      createdAt: 1_000,
      lastAt: 2_000,
      entries: [
        { seq: 1, time: 1_000, kind: 'user', text: '广告 SDK 改一下' },
        { seq: 2, time: 2_000, kind: 'user', text: '广告 SDK 的点击统计' },
      ],
    },
    {
      id: SESSION_B,
      workspace: WORKSPACE,
      createdAt: 3_000,
      lastAt: 4_000,
      entries: [{ seq: 1, time: 3_000, kind: 'user', text: '广告 素材' }],
    },
    {
      id: SESSION_DUP_A,
      workspace: WORKSPACE,
      createdAt: 5_000,
      lastAt: 5_000,
      entries: [{ seq: 1, time: 5_000, kind: 'user', text: '无关甲' }],
    },
    {
      id: SESSION_DUP_B,
      workspace: WORKSPACE,
      createdAt: 6_000,
      lastAt: 6_000,
      entries: [{ seq: 1, time: 6_000, kind: 'user', text: '无关乙' }],
    },
  ],
}

describe('search session id filter', () => {
  it('restricts the search to one session by exact id', async () => {
    const root = await project(SEARCH_SEED)
    const result = search(
      connection(root),
      { operation: 'search', indexRoot: root, query: '广告', sessionId: SESSION_A, dedupeBySession: false, limit: 10 },
      240,
    )
    expect(result.total).toBe(2)
    expect(result.hits.every(hit => hit.sessionId === SESSION_A)).toBe(true)
  })

  it('resolves a unique id prefix to the one session it names', async () => {
    const root = await project(SEARCH_SEED)
    const result = search(
      connection(root),
      { operation: 'search', indexRoot: root, query: '广告', sessionId: 'bbbb2222', limit: 10 },
      240,
    )
    expect(result.hits.map(hit => hit.sessionId)).toEqual([SESSION_B])
  })

  it('refuses an ambiguous prefix as a bad request instead of guessing a conversation', async () => {
    const root = await project(SEARCH_SEED)
    expect(() =>
      search(connection(root), { operation: 'search', indexRoot: root, query: '广告', sessionId: 'abcd', limit: 10 }, 240),
    ).toThrow(expect.objectContaining<Partial<SessiongraphError>>({ code: 'SESSIONGRAPH_INVALID_REQUEST' }))
  })

  it('reports an unknown session filter as not found', async () => {
    const root = await project(SEARCH_SEED)
    expect(() =>
      search(connection(root), { operation: 'search', indexRoot: root, query: '广告', sessionId: 'ffffffff', limit: 10 }, 240),
    ).toThrow(expect.objectContaining<Partial<SessiongraphError>>({ code: 'SESSIONGRAPH_NOT_FOUND' }))
  })
})

describe('search dedupe and kind weights', () => {
  it('keeps the strongest hit per session by default', async () => {
    const root = await project(SEARCH_SEED)
    const result = search(connection(root), { operation: 'search', indexRoot: root, query: '广告', limit: 10 }, 240)
    expect(result.total).toBe(2)
    expect(result.hits).toHaveLength(2)
    expect(new Set(result.hits.map(hit => hit.sessionId)).size).toBe(2)
    expect(result.truncated).toBe(false)
  })

  it('returns every matching entry when the caller turns dedupe off', async () => {
    const root = await project(SEARCH_SEED)
    const result = search(
      connection(root),
      { operation: 'search', indexRoot: root, query: '广告', dedupeBySession: false, limit: 10 },
      240,
    )
    expect(result.total).toBe(3)
    expect(result.hits).toHaveLength(3)
  })

  it('defines `total` as the rows the page ranges over, for both dedupe settings', async () => {
    const root = await project(SEARCH_SEED)
    const db = connection(root)
    // The same query, counted twice: two sessions match 广告, three entries do.
    const deduped = search(db, { operation: 'search', indexRoot: root, query: '广告', limit: 10 }, 240)
    const plain = search(
      db,
      { operation: 'search', indexRoot: root, query: '广告', dedupeBySession: false, limit: 10 },
      240,
    )
    expect(deduped.total).toBe(2)
    expect(plain.total).toBe(3)
    expect(deduped.hits).toHaveLength(2)
    expect(plain.hits).toHaveLength(3)
  })

  it('counts sessions rather than entries in `total` when dedupe is on, so paging stays coherent', async () => {
    const root = await project(SEARCH_SEED)
    const db = connection(root)
    const first = search(db, { operation: 'search', indexRoot: root, query: '广告', limit: 1 }, 240)
    const second = search(db, { operation: 'search', indexRoot: root, query: '广告', limit: 1, offset: 1 }, 240)
    expect(first.total).toBe(2)
    expect(first.truncated).toBe(true)
    expect(second.truncated).toBe(false)
    expect(first.hits[0]?.sessionId).not.toBe(second.hits[0]?.sessionId)
  })

  it('ranks a human message above the same text in a more penalized kind', async () => {
    // Identical text in three different kinds, so the raw bm25 score is the same and only the kind
    // weight can decide the order.
    const root = await project({
      sessions: [
        {
          id: 'aaaa1111-0000-4000-8000-000000000011',
          workspace: WORKSPACE,
          entries: [{ seq: 1, time: 1_000, kind: 'user', text: 'command name' }],
        },
        {
          id: 'bbbb2222-0000-4000-8000-000000000012',
          workspace: WORKSPACE,
          entries: [{ seq: 1, time: 2_000, kind: 'assistant', text: 'command name' }],
        },
        {
          id: 'cccc3333-0000-4000-8000-000000000013',
          workspace: WORKSPACE,
          entries: [{ seq: 1, time: 3_000, kind: 'tool', text: 'command name' }],
        },
      ],
    })
    const result = search(connection(root), { operation: 'search', indexRoot: root, query: 'command', limit: 10 }, 240)
    // `bm25` is negative, so the kind weight is a divisor: user (1.0) outranks assistant (1.2), which
    // outranks tool (1.5). Multiplying by the weight would invert this, which is why it is a penalty.
    expect(result.hits.map(hit => hit.kind)).toEqual(['user', 'assistant', 'tool'])
  })
})

describe('trace: session lineage', () => {
  const ROOT = 'root0001-0000-4000-8000-000000000001'
  const CHILD = 'child001-0000-4000-8000-000000000002'
  const GRAND = 'grand001-0000-4000-8000-000000000003'
  const SIBLING = 'sibl0001-0000-4000-8000-000000000004'
  const ORPHAN = 'orph0001-0000-4000-8000-000000000005'
  const LINEAGE: SeedIndex = {
    sessions: [
      { id: ROOT, workspace: WORKSPACE, createdAt: 100, lastAt: 100, entries: [] },
      { id: SIBLING, workspace: WORKSPACE, parentSession: ROOT, createdAt: 150, lastAt: 150, entries: [] },
      { id: CHILD, workspace: WORKSPACE, parentSession: ROOT, createdAt: 200, lastAt: 200, entries: [] },
      { id: GRAND, workspace: WORKSPACE, parentSession: CHILD, createdAt: 300, lastAt: 300, entries: [] },
      { id: ORPHAN, workspace: WORKSPACE, parentSession: 'missing-parent', createdAt: 400, lastAt: 400, entries: [] },
    ],
  }

  it('walks ancestors nearest first and the descendant tree breadth by breadth', async () => {
    const root = await project(LINEAGE)
    const db = connection(root)

    const fromLeaf = trace(db, { operation: 'trace', indexRoot: root, sessionId: GRAND })
    expect(fromLeaf.kind).toBe('session')
    if (fromLeaf.kind !== 'session') throw new Error('unreachable')
    expect(fromLeaf.target.sessionId).toBe(GRAND)
    expect(fromLeaf.ancestors.map(ancestor => ancestor.sessionId)).toEqual([CHILD, ROOT])
    expect(fromLeaf.descendants).toEqual([])
    expect(fromLeaf.complete).toBe(true)

    const fromRoot = trace(db, { operation: 'trace', indexRoot: root, sessionId: ROOT })
    if (fromRoot.kind !== 'session') throw new Error('unreachable')
    // Siblings are ordered oldest first, and each child carries its own subtree.
    expect(fromRoot.descendants.map(node => node.session.sessionId)).toEqual([SIBLING, CHILD])
    expect(fromRoot.descendants[1]?.descendants.map(node => node.session.sessionId)).toEqual([GRAND])
    expect(fromRoot.ancestors).toEqual([])
    expect(fromRoot.complete).toBe(true)
  })

  it('reports an incomplete walk when the depth limit cut the tree', async () => {
    const root = await project(LINEAGE)
    const db = connection(root)
    const limited = trace(db, { operation: 'trace', indexRoot: root, sessionId: ROOT, depth: 1 })
    if (limited.kind !== 'session') throw new Error('unreachable')
    expect(limited.descendants.map(node => node.session.sessionId)).toEqual([SIBLING, CHILD])
    expect(limited.descendants[1]?.descendants).toEqual([])
    expect(limited.complete).toBe(false)

    const zero = trace(db, { operation: 'trace', indexRoot: root, sessionId: CHILD, depth: 0 })
    if (zero.kind !== 'session') throw new Error('unreachable')
    expect(zero.descendants).toEqual([])
    expect(zero.complete).toBe(false)
  })

  it('reports an incomplete lineage when the parent is not in the index', async () => {
    const root = await project(LINEAGE)
    const result = trace(connection(root), { operation: 'trace', indexRoot: root, sessionId: ORPHAN })
    if (result.kind !== 'session') throw new Error('unreachable')
    expect(result.ancestors).toEqual([])
    expect(result.complete).toBe(false)
  })

  it('reports an unknown session as not found', async () => {
    const root = await project(LINEAGE)
    expect(() => trace(connection(root), { operation: 'trace', indexRoot: root, sessionId: 'ffffffff' })).toThrow(
      expect.objectContaining<Partial<SessiongraphError>>({ code: 'SESSIONGRAPH_NOT_FOUND' }),
    )
  })
})

describe('event and trace: raw log reads', () => {
  const LOGGED = 'logg0001-0000-4000-8000-000000000001'
  const LIVE = 'live0001-0000-4000-8000-000000000002'
  const BODY = 'y'.repeat(12_000)

  /** The log every raw-read test uses, written into `root` and pointed at by the seeded session. */
  async function seedLoggedSession(): Promise<string> {
    const root = await scratch()
    const path = join(root, 'session.v4.jsonl.zstd')
    const records: unknown[] = [
      { type: 'session', version: 4, id: LOGGED, createdAt: 1_000, cwd: WORKSPACE },
      logEvent('user/message', 1, 1_000, { content: [{ type: 'text', text: '原始消息' }] }),
      logEvent('assistant/message', 2, 2_000, { message: { content: [{ type: 'text', text: '回答' }] } }),
      logEvent('tool/call', 3, 3_000, { name: 'bash', arguments: '{"command":"ls"}' }),
      logEvent('tool/result', 4, 4_000, { message: { content: [{ type: 'text', text: BODY }] } }, { sourceEventSeqs: [3] }),
      {
        type: 'user/message',
        seq: 5,
        time: 5_000,
        data: { content: [{ type: 'text', text: '改写后的消息' }] },
        surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 },
        sourceEventSeqs: [1],
      },
    ]
    await writeFile(path, Buffer.concat(records.map(frame)))
    const sessions: SeedSession[] = [
      {
        id: LOGGED,
        workspace: WORKSPACE,
        title: '带日志的会话',
        createdAt: 1_000,
        lastAt: 5_000,
        sourcePath: path,
        entries: [{ seq: 1, time: 1_000, kind: 'user', text: '原始消息' }],
      },
      {
        id: LIVE,
        workspace: WORKSPACE,
        createdAt: 6_000,
        lastAt: 6_000,
        sourcePath: `live://${LIVE}`,
        entries: [{ seq: 1, time: 6_000, kind: 'user', text: '还在跑的会话' }],
      },
    ]
    return seedIndex({ sessions })
  }

  it('returns the unabridged event with the requested window of neighbours', async () => {
    const root = await seedLoggedSession()
    roots.push(root)
    const result = event(connection(root), {
      operation: 'event',
      indexRoot: root,
      sessionId: LOGGED,
      seq: 4,
      windowBefore: 2,
      windowAfter: 1,
    })
    expect(result.operation).toBe('event')
    expect(result.session.sessionId).toBe(LOGGED)
    expect(result.session.title).toBe('带日志的会话')
    expect(result.event.seq).toBe(4)
    expect(result.event.type).toBe('tool/result')
    // The indexer clips entries at 4000 characters; an event read must not.
    const data = result.event.data as { message: { content: { text: string }[] } }
    expect(data.message.content[0]?.text).toHaveLength(12_000)
    expect(result.before.map(summary => summary.seq)).toEqual([2, 3])
    expect(result.after.map(summary => summary.seq)).toEqual([5])
    expect(result.before[1]).toMatchObject({ seq: 3, type: 'tool/call' })
  })

  it('reports a live session as unreadable instead of pretending it has no events', async () => {
    const root = await seedLoggedSession()
    roots.push(root)
    expect(() =>
      event(connection(root), { operation: 'event', indexRoot: root, sessionId: LIVE, seq: 1 }),
    ).toThrow(expect.objectContaining<Partial<SessiongraphError>>({ code: 'SESSIONGRAPH_IO' }))
  })

  it('reports a missing event sequence number as not found', async () => {
    const root = await seedLoggedSession()
    roots.push(root)
    expect(() =>
      event(connection(root), { operation: 'event', indexRoot: root, sessionId: LOGGED, seq: 99 }),
    ).toThrow(expect.objectContaining<Partial<SessiongraphError>>({ code: 'SESSIONGRAPH_NOT_FOUND' }))
  })

  it('traces an event through its replacement chain and cited sources', async () => {
    const root = await seedLoggedSession()
    roots.push(root)
    const db = connection(root)

    const replaced = trace(db, { operation: 'trace', indexRoot: root, sessionId: LOGGED, seq: 1 })
    expect(replaced.kind).toBe('event')
    if (replaced.kind !== 'event') throw new Error('unreachable')
    expect(replaced.event).toMatchObject({ seq: 1, type: 'user/message' })
    expect(replaced.replacedBy).toEqual([5])
    expect(replaced.shadowedSeqs).toEqual([])
    expect(replaced.sourceEventSeqs).toEqual([])

    const replacement = trace(db, { operation: 'trace', indexRoot: root, sessionId: LOGGED, seq: 5 })
    if (replacement.kind !== 'event') throw new Error('unreachable')
    expect(replacement.shadowedSeqs).toEqual([1])
    expect(replacement.sourceEventSeqs).toEqual([1])

    const cited = trace(db, { operation: 'trace', indexRoot: root, sessionId: LOGGED, seq: 4 })
    if (cited.kind !== 'event') throw new Error('unreachable')
    expect(cited.sourceEventSeqs).toEqual([3])
    expect(cited.replacedBy).toEqual([])
  })

  it('reports an unknown sequence number in a trace as not found', async () => {
    const root = await seedLoggedSession()
    roots.push(root)
    expect(() =>
      trace(connection(root), { operation: 'trace', indexRoot: root, sessionId: LOGGED, seq: 99 }),
    ).toThrow(expect.objectContaining<Partial<SessiongraphError>>({ code: 'SESSIONGRAPH_NOT_FOUND' }))
  })
})
