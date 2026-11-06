import { rm, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Sessiongraph from 'dsh-plugin-sessiongraph-service'
import type { SessiongraphError, SessiongraphService } from 'dsh-plugin-sessiongraph-service'
import * as SessiongraphSqlite from '../src/index.ts'
import { IndexPool, databasePath, indexExists, openIndex } from '../src/database.ts'
import { search, session, status, timeline, workspaces } from '../src/queries.ts'
import { emptyRoot, seedIndex, writeIndexAt } from './fixture.ts'
import type { SeedIndex } from './fixture.ts'

const WORKSPACE_ADX = '/Users/admin/www/adx-admin'
const WORKSPACE_CG = '/Users/admin/www/dsh-plugin-codegraph'
const WORKSPACE_TMP = '/tmp/scratch'

const SESSION_ADX = 'aaaa1111-0000-4000-8000-000000000001'
const SESSION_CHILD = 'bbbb2222-0000-4000-8000-000000000002'
const SESSION_OTHER = 'cccc3333-0000-4000-8000-000000000003'
const SESSION_DUP_A = 'abcd0001-0000-4000-8000-000000000004'
const SESSION_DUP_B = 'abcd0002-0000-4000-8000-000000000005'

const INDEXED_AT = 1_790_000_000_000

/** Five sessions across three workspaces, with enough overlap to exercise every filter. */
const SEED: SeedIndex = {
  indexedAt: INDEXED_AT,
  sessions: [
    {
      id: SESSION_ADX,
      workspace: WORKSPACE_ADX,
      title: '改广告 SDK',
      createdAt: 1_000,
      lastAt: 4_000,
      origin: 'user',
      agentPreset: 'standard',
      turns: 2,
      entries: [
        { seq: 1, time: 1_000, turn: 1, kind: 'user', text: '我今天在改广告SDK的点击统计' },
        { seq: 2, time: 2_000, turn: 1, kind: 'assistant', text: '建议把 retry 逻辑抽出来，广告SDK 的 Timeout 也要处理' },
        { seq: 3, time: 3_000, turn: 2, kind: 'tool', text: 'tool call: Edit arguments {"file":"AdManager.kt"}' },
      ],
    },
    {
      id: SESSION_CHILD,
      workspace: WORKSPACE_CG,
      parentSession: SESSION_ADX,
      createdAt: 2_000,
      lastAt: 5_000,
      entries: [
        { seq: 1, time: 2_100, kind: 'user', text: '查一下 codegraph 的索引路径' },
        { seq: 2, time: 2_200, kind: 'assistant', text: 'retry 在这里也有' },
        { seq: 3, time: 2_300, kind: 'user', text: '广告 相关的文档呢' },
      ],
    },
    {
      id: SESSION_OTHER,
      workspace: WORKSPACE_ADX,
      createdAt: 3_000,
      lastAt: 3_500,
      entries: [{ seq: 1, time: 3_100, kind: 'user', text: '别的会话，没有那个词' }],
    },
    {
      id: SESSION_DUP_A,
      workspace: WORKSPACE_TMP,
      createdAt: 4_000,
      lastAt: 6_000,
      entries: [{ seq: 1, time: 4_100, kind: 'user', text: '无关内容甲' }],
    },
    {
      id: SESSION_DUP_B,
      workspace: WORKSPACE_TMP,
      createdAt: 4_500,
      lastAt: 6_500,
      entries: [{ seq: 1, time: 4_600, kind: 'user', text: '无关内容乙' }],
    },
  ],
}

const roots: string[] = []
const pools: IndexPool[] = []
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  for (const pool of pools.splice(0)) pool.close()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** Seed a fresh index root and register it for cleanup. */
async function project(seed: SeedIndex = SEED): Promise<string> {
  const root = await seedIndex(seed)
  roots.push(root)
  return root
}

/** A one-slot pool registered for cleanup. */
function oneSlotPool(): IndexPool {
  const pool = new IndexPool(1)
  pools.push(pool)
  return pool
}

/** An open connection through a one-slot pool, registered for cleanup. */
function connection(root: string): DatabaseSync {
  return oneSlotPool().acquire(root)
}

/** Mount the seam and this store, as a profile would. */
async function mount(config: SessiongraphSqlite.Config = {}): Promise<Context> {
  const ctx = new Context()
  context = ctx
  await ctx.plugin(Sessiongraph)
  await ctx.plugin(SessiongraphSqlite, config)
  return ctx
}

/**
 * The seam this workspace's service package publishes. The service does not (yet) augment Cordis's
 * `Context`, so tests recover it through `ctx.get` exactly as the plugin does.
 */
function seam(ctx: Context): SessiongraphService {
  return ctx.get('sessiongraph') as SessiongraphService
}

describe('index database', () => {
  it('claims a root only when the index file exists, without opening it', async () => {
    const root = await emptyRoot()
    roots.push(root)
    expect(indexExists(root)).toBe(false)
    const seeded = await project({ sessions: [] })
    expect(indexExists(seeded)).toBe(true)
    expect(databasePath(seeded)).toBe(join(seeded, 'index.db'))
  })

  it('refuses an index written at another schema version', async () => {
    const root = await project({ sessions: [], schemaVersion: 999 })
    expect(indexExists(root)).toBe(true)
    expect(() => openIndex(root)).toThrow(
      expect.objectContaining<Partial<SessiongraphError>>({ code: 'SESSIONGRAPH_CORRUPT' }),
    )
    expect(() => openIndex(root)).toThrow(/schema version 999/)
  })

  it('reports a file that is not SQLite as corrupt instead of serving an empty graph', async () => {
    const root = await project({ sessions: [] })
    await writeFile(databasePath(root), 'this is not a sqlite database at all')
    expect(indexExists(root)).toBe(true)
    expect(() => openIndex(root)).toThrow(
      expect.objectContaining<Partial<SessiongraphError>>({ code: 'SESSIONGRAPH_CORRUPT' }),
    )
  })

  it('reopens when an indexing run replaces the file under an open connection', async () => {
    const root = await project({ sessions: [] })
    const pool = new IndexPool(1)
    pools.push(pool)
    const before = pool.acquire(root).prepare('SELECT count(*) AS n FROM session').get() as { n: number }
    expect(before.n).toBe(0)
    writeIndexAt(root, SEED)
    const after = pool.acquire(root).prepare('SELECT count(*) AS n FROM session').get() as { n: number }
    expect(after.n).toBe(SEED.sessions.length)
  })

  it('disposes every connection and refuses further use', async () => {
    const root = await project()
    const pool = new IndexPool(1)
    pool.acquire(root)
    pool.close()
    expect(() => pool.acquire(root)).toThrow(
      expect.objectContaining<Partial<SessiongraphError>>({ code: 'SESSIONGRAPH_UNAVAILABLE' }),
    )
  })
})

describe('search', () => {
  it('matches a two-character Chinese term through the bigram index', async () => {
    const root = await project()
    // One hit per entry, so this test sees every match rather than the strongest one per session.
    const result = search(
      connection(root),
      { operation: 'search', indexRoot: root, query: '广告', dedupeBySession: false, limit: 10 },
      240,
    )
    expect(result.total).toBe(3)
    expect(result.hits).toHaveLength(3)
    for (const hit of result.hits) {
      expect(hit.snippet).toContain('[广告]')
      expect(hit.workspace).toBeTruthy()
      expect(typeof hit.seq).toBe('number')
    }
    const first = result.hits.find(hit => hit.sessionId === SESSION_ADX && hit.seq === 1)
    expect(first?.snippet).toBe('我今天在改[广告]SDK的点击统计')
    expect(first?.length).toBe('我今天在改广告SDK的点击统计'.length)
    expect(first?.title).toBe('改广告 SDK')
    expect(first?.kind).toBe('user')
    expect(first?.turn).toBe(1)
  })

  it('matches Latin text case-insensitively and brackets the original casing', async () => {
    const root = await project()
    const result = search(connection(root), { operation: 'search', indexRoot: root, query: 'TIMEOUT', limit: 10 }, 240)
    expect(result.total).toBe(1)
    expect(result.hits[0]?.sessionId).toBe(SESSION_ADX)
    expect(result.hits[0]?.seq).toBe(2)
    expect(result.hits[0]?.snippet).toContain('[Timeout]')
  })

  it('applies the kinds filter', async () => {
    const root = await project()
    const onlyUser = search(
      connection(root),
      { operation: 'search', indexRoot: root, query: '广告', kinds: ['user'], limit: 10 },
      240,
    )
    expect(onlyUser.total).toBe(2)
    expect(onlyUser.hits.every(hit => hit.kind === 'user')).toBe(true)

    const onlyAssistant = search(
      connection(root),
      { operation: 'search', indexRoot: root, query: '广告', kinds: ['assistant'], limit: 10 },
      240,
    )
    expect(onlyAssistant.total).toBe(1)
    expect(onlyAssistant.hits[0]?.kind).toBe('assistant')
  })

  it('pages deterministically: offset returns the rows the previous page did not', async () => {
    const root = await project()
    const first = search(
      connection(root),
      { operation: 'search', indexRoot: root, query: 'retry', limit: 1, offset: 0 },
      240,
    )
    const second = search(
      connection(root),
      { operation: 'search', indexRoot: root, query: 'retry', limit: 1, offset: 1 },
      240,
    )
    expect(first.total).toBe(2)
    expect(second.total).toBe(2)
    expect(first.hits).toHaveLength(1)
    expect(second.hits).toHaveLength(1)
    expect(first.truncated).toBe(true)
    expect(second.truncated).toBe(false)
    expect(first.hits[0]?.sessionId).not.toBe(second.hits[0]?.sessionId)
  })

  it('filters by exact workspace, workspace prefix, and entry time window', async () => {
    const db = connection(await project())
    const exact = search(
      db,
      { operation: 'search', indexRoot: '', query: '广告', workspace: WORKSPACE_ADX, dedupeBySession: false, limit: 10 },
      240,
    )
    expect(exact.total).toBe(2)

    // A trailing slash marks a prefix filter, which here spans two workspaces.
    const prefix = search(
      db,
      { operation: 'search', indexRoot: '', query: '广告', workspace: '/Users/admin/www/', dedupeBySession: false, limit: 10 },
      240,
    )
    expect(prefix.total).toBe(3)

    const window = search(
      db,
      { operation: 'search', indexRoot: '', query: '广告', after: 2_000, before: 2_500, limit: 10 },
      240,
    )
    expect(window.total).toBe(2)
    expect(window.hits.map(hit => hit.time).sort()).toEqual([2_000, 2_300])
  })

  it('answers an unsearchable query with zero hits rather than an FTS syntax error', async () => {
    const root = await project()
    const result = search(connection(root), { operation: 'search', indexRoot: root, query: '!!!', limit: 10 }, 240)
    expect(result.total).toBe(0)
    expect(result.hits).toEqual([])
  })

  it('clips the snippet to the configured ceiling and reports it', async () => {
    const root = await project()
    const result = search(connection(root), { operation: 'search', indexRoot: root, query: '广告', limit: 10 }, 8)
    const hit = result.hits.find(candidate => candidate.sessionId === SESSION_ADX && candidate.seq === 1)
    expect(hit?.snippet).toContain('[广告]')
    // The excerpt is capped at 8 characters; the two brackets are added after that cap.
    expect(hit?.snippet.replaceAll('[', '').replaceAll(']', '')).toHaveLength(8)
    expect(result.truncated).toBe(true)
  })
})

describe('session', () => {
  it('resolves a unique id prefix and reports the session with its children', async () => {
    const root = await project()
    const result = session(connection(root), { operation: 'session', indexRoot: root, sessionId: 'aaaa1111', limit: 10 })
    expect(result.session.sessionId).toBe(SESSION_ADX)
    expect(result.session.title).toBe('改广告 SDK')
    expect(result.session.workspace).toBe(WORKSPACE_ADX)
    expect(result.session.parentSession).toBeUndefined()
    expect(result.session.origin).toBe('user')
    expect(result.session.agentPreset).toBe('standard')
    expect(result.session.turns).toBe(2)
    expect(result.session.entries).toBe(3)
    expect(result.entries.map(entry => entry.seq)).toEqual([1, 2, 3])
    expect(result.entries[0]?.clipped).toBe(false)
    expect(result.children).toEqual([SESSION_CHILD])
    expect(result.truncated).toBe(false)
  })

  it('pages entries by the session chronological order', async () => {
    const root = await project()
    const db = connection(root)
    const page = session(db, { operation: 'session', indexRoot: root, sessionId: SESSION_ADX, limit: 2, offset: 1 })
    expect(page.entries.map(entry => entry.seq)).toEqual([2, 3])
    expect(page.truncated).toBe(false)

    const first = session(db, { operation: 'session', indexRoot: root, sessionId: SESSION_ADX, limit: 2 })
    expect(first.entries.map(entry => entry.seq)).toEqual([1, 2])
    expect(first.truncated).toBe(true)
  })

  it('refuses an ambiguous prefix and lists the candidates', async () => {
    const root = await project()
    const db = connection(root)
    expect(() => session(db, { operation: 'session', indexRoot: root, sessionId: 'abcd', limit: 10 })).toThrow(
      expect.objectContaining<Partial<SessiongraphError>>({ code: 'SESSIONGRAPH_NOT_FOUND' }),
    )
    // Candidates are listed newest-first, so the message is asserted on membership, not order.
    expect(() => session(db, { operation: 'session', indexRoot: root, sessionId: 'abcd', limit: 10 })).toThrow(
      SESSION_DUP_A,
    )
    expect(() => session(db, { operation: 'session', indexRoot: root, sessionId: 'abcd', limit: 10 })).toThrow(
      SESSION_DUP_B,
    )
  })

  it('reports an unknown id as not found', async () => {
    const root = await project()
    expect(() =>
      session(connection(root), { operation: 'session', indexRoot: root, sessionId: 'ffffffff', limit: 10 }),
    ).toThrow(expect.objectContaining<Partial<SessiongraphError>>({ code: 'SESSIONGRAPH_NOT_FOUND' }))
  })
})

describe('timeline and workspaces', () => {
  it('lists sessions newest activity first and truncates past the limit', async () => {
    const root = await project()
    const db = connection(root)
    const all = timeline(db, { operation: 'timeline', indexRoot: root, limit: 10 })
    expect(all.sessions.map(entry => entry.sessionId)).toEqual([
      SESSION_DUP_B,
      SESSION_DUP_A,
      SESSION_CHILD,
      SESSION_ADX,
      SESSION_OTHER,
    ])
    expect(all.truncated).toBe(false)

    const page = timeline(db, { operation: 'timeline', indexRoot: root, limit: 3 })
    expect(page.sessions).toHaveLength(3)
    expect(page.truncated).toBe(true)
  })

  it('filters the timeline by workspace and by session span', async () => {
    const root = await project()
    const db = connection(root)
    const underWww = timeline(db, {
      operation: 'timeline',
      indexRoot: root,
      workspace: '/Users/admin/www/',
      limit: 10,
    })
    expect(underWww.sessions.map(entry => entry.sessionId)).toEqual([SESSION_CHILD, SESSION_ADX, SESSION_OTHER])

    const active = timeline(db, { operation: 'timeline', indexRoot: root, after: 4_500, limit: 10 })
    expect(active.sessions.map(entry => entry.sessionId)).toEqual([SESSION_DUP_B, SESSION_DUP_A, SESSION_CHILD])

    const started = timeline(db, { operation: 'timeline', indexRoot: root, before: 4_000, limit: 10 })
    expect(started.sessions).toHaveLength(4)
  })

  it('aggregates workspaces by last activity', async () => {
    const root = await project()
    const db = connection(root)
    const result = workspaces(db, { operation: 'workspaces', indexRoot: root, limit: 10 })
    expect(result.total).toBe(3)
    expect(result.workspaces.map(entry => entry.workspace)).toEqual([WORKSPACE_TMP, WORKSPACE_CG, WORKSPACE_ADX])
    const adx = result.workspaces.find(entry => entry.workspace === WORKSPACE_ADX)
    expect(adx).toEqual({
      workspace: WORKSPACE_ADX,
      sessions: 2,
      entries: 4,
      firstAt: 1_000,
      lastAt: 4_000,
    })
    const limited = workspaces(db, { operation: 'workspaces', indexRoot: root, limit: 2 })
    expect(limited.workspaces).toHaveLength(2)
    expect(limited.total).toBe(3)
  })
})

describe('status', () => {
  it('answers indexed: false for a root that holds no index, instead of throwing', async () => {
    const root = await emptyRoot()
    roots.push(root)
    const result = status(oneSlotPool(), root)
    expect(result).toEqual({
      operation: 'status',
      indexed: false,
      indexPath: databasePath(root),
      sessions: 0,
      liveSessions: 0,
      entries: 0,
      workspaces: 0,
      indexedAt: undefined,
      bytes: 0,
    })
  })

  it('counts the sessions the indexer marked live:// as liveSessions', async () => {
    const root = await project({
      sessions: [
        {
          id: 'live0001-0000-4000-8000-000000000001',
          workspace: WORKSPACE_ADX,
          sourcePath: 'live://live0001-0000-4000-8000-000000000001',
          entries: [{ seq: 1, time: 1_000, kind: 'user', text: '还在跑的会话甲' }],
        },
        {
          id: 'live0002-0000-4000-8000-000000000002',
          workspace: WORKSPACE_ADX,
          sourcePath: 'live://live0002-0000-4000-8000-000000000002',
          entries: [{ seq: 1, time: 2_000, kind: 'user', text: '还在跑的会话乙' }],
        },
        {
          id: 'disk0001-0000-4000-8000-000000000003',
          workspace: WORKSPACE_CG,
          entries: [{ seq: 1, time: 3_000, kind: 'user', text: '已落盘的会话' }],
        },
      ],
    })
    const result = status(oneSlotPool(), root)
    expect(result.indexed).toBe(true)
    expect(result.sessions).toBe(3)
    expect(result.liveSessions).toBe(2)
  })

  it('reports counts, the last run time, and the file size for a real index', async () => {
    const root = await project()
    const result = status(oneSlotPool(), root)
    expect(result.indexed).toBe(true)
    expect(result.indexPath).toBe(databasePath(root))
    expect(result.sessions).toBe(5)
    expect(result.entries).toBe(9)
    expect(result.workspaces).toBe(3)
    // The fixture's sessions all have a real log path, so none is live — the field is 0, not absent.
    expect(result.liveSessions).toBe(0)
    expect(result.indexedAt).toBe(INDEXED_AT)
    expect(result.bytes).toBe(statSync(databasePath(root)).size)
    expect(result.bytes).toBeGreaterThan(0)
  })
})

describe('store plugin', () => {
  it('registers a store the seam routes search and status through', async () => {
    const root = await project()
    const ctx = await mount()
    expect(await seam(ctx).available(root)).toBe(true)

    // Two sessions mention 广告; the default dedupe keeps the strongest entry from each.
    const found = await seam(ctx).query({ operation: 'search', indexRoot: root, query: '广告', limit: 10 })
    expect(found.total).toBe(2)
    expect(found.hits).toHaveLength(2)

    const indexStatus = await seam(ctx).query({ operation: 'status', indexRoot: root })
    expect(indexStatus.indexed).toBe(true)
    expect(indexStatus.sessions).toBe(5)
  })

  it('does not claim a root without an index, so the seam fails loud on a query', async () => {
    const root = await emptyRoot()
    roots.push(root)
    const ctx = await mount()
    expect(await seam(ctx).available(root)).toBe(false)
    await expect(seam(ctx).query({ operation: 'search', indexRoot: root, query: '广告', limit: 10 })).rejects.toThrow(
      expect.objectContaining<Partial<SessiongraphError>>({ code: 'SESSIONGRAPH_UNAVAILABLE' }),
    )
  })

  it('falls back to the configured defaultIndexRoot when a request leaves it empty', async () => {
    const root = await project()
    const ctx = await mount({ defaultIndexRoot: root })
    const found = await seam(ctx).query({ operation: 'search', indexRoot: '', query: 'retry', limit: 10 })
    expect(found.total).toBe(2)
  })

  it('honours the configured snippet ceiling', async () => {
    const root = await project()
    const ctx = await mount({ maxSnippetChars: 8 })
    const found = await seam(ctx).query({ operation: 'search', indexRoot: root, query: '广告', limit: 10 })
    expect(found.truncated).toBe(true)
    for (const hit of found.hits) {
      expect(hit.snippet.replaceAll('[', '').replaceAll(']', '').length).toBeLessThanOrEqual(8)
    }
  })
})
