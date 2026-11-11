/**
 * `touched` tests: the resources one session's tool calls named, read out of the index's own `tool`
 * entries.
 *
 * The fixtures write `entry.text` exactly as the indexer does — `<tool name> <json arguments>` — so a
 * test that passes here is a test against the real on-disk shape, not a convenient stand-in.
 * @module dsh-plugin-sessiongraph-sqlite/tests/touched
 */

import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessiongraphError } from 'dsh-plugin-sessiongraph-service'
import { IndexPool } from '../src/database.ts'
import { touched } from '../src/queries.ts'
import { seedIndex } from './fixture.ts'
import type { SeedEntry, SeedIndex } from './fixture.ts'

const WORKSPACE = '/Users/admin/www/adx-admin'
const SESSION = 'aaaa1111-0000-4000-8000-000000000001'

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

/** One `tool` entry in the `<name> <json>` shape the indexer records. */
function tool(seq: number, time: number, name: string, args: unknown, clipped = false): SeedEntry {
  return { seq, time, kind: 'tool', text: `${name} ${JSON.stringify(args)}`, clipped }
}

/** One `tool` entry with a hand-written argument body, for the shapes JSON.stringify cannot produce. */
function rawTool(seq: number, time: number, text: string, clipped = false): SeedEntry {
  return { seq, time, kind: 'tool', text, clipped }
}

/** Seed one session whose entries are the given ones. */
function oneSession(entries: SeedEntry[], workspace = WORKSPACE): SeedIndex {
  return { sessions: [{ id: SESSION, workspace, entries }] }
}

/** Ask one session's resource list, with the query defaults a caller would use. */
function ask(root: string, sessionId = SESSION, limit = 50, offset?: number) {
  return touched(connection(root), {
    operation: 'touched',
    indexRoot: root,
    sessionId,
    limit,
    ...(offset === undefined ? {} : { offset }),
  })
}

describe('touched paths', () => {
  it('keeps an absolute path as given, normalised', async () => {
    const root = await project(oneSession([tool(1, 1_000, 'read', { file_path: '/abs/dir/./a.ts' })]))

    expect(ask(root)).toEqual({
      operation: 'touched',
      sessionId: SESSION,
      resources: [
        {
          path: '/abs/dir/a.ts',
          kind: 'file',
          mentions: 1,
          firstSeq: 1,
          lastSeq: 1,
          firstAt: 1_000,
          lastAt: 1_000,
          tools: ['read'],
        },
      ],
      total: 1,
      truncated: false,
      unparsed: 0,
    })
  })

  it('anchors a relative path to the session workspace', async () => {
    const root = await project(oneSession([tool(1, 1_000, 'edit', { file_path: 'src/app.ts' })]))

    expect(ask(root).resources.map(resource => resource.path)).toEqual([resolve(WORKSPACE, 'src/app.ts')])
  })

  it('reads a grep/glob target as a directory even without a trailing separator', async () => {
    const root = await project(oneSession([
      tool(1, 1_000, 'grep', { path: 'src' }),
      tool(2, 2_000, 'glob', { path: '/Users/admin/www/**/*.ts' }),
    ]))
    const resources = ask(root).resources

    expect(resources.map(resource => [resource.path, resource.kind])).toEqual([
      // The glob was the later call, and both resources are mentioned once.
      ['/Users/admin/www/**/*.ts', 'dir'],
      [resolve(WORKSPACE, 'src'), 'dir'],
    ])
  })

  it('calls a read/… path ending in a separator a directory, but not otherwise', async () => {
    const root = await project(oneSession([
      tool(1, 1_000, 'read', { file_path: '/repo/packages/' }),
      tool(2, 2_000, 'read', { file_path: '/repo/packages/index.ts' }),
    ]))

    expect(ask(root).resources.map(resource => [resource.path, resource.kind])).toEqual([
      ['/repo/packages/index.ts', 'file'],
      // The separator is dropped so one tree is one resource, while `kind` still records that the
      // call named it as a directory.
      ['/repo/packages', 'dir'],
    ])
  })

  it('merges a relative directory path with the absolute path it resolves to', async () => {
    const root = await project(oneSession([
      tool(1, 1_000, 'read', { file_path: `${WORKSPACE}/src` }),
      tool(2, 2_000, 'glob', { path: 'src/', pattern: '**/*.ts' }),
    ]))

    const resources = ask(root).resources
    expect(resources.map(resource => [resource.path, resource.kind, resource.mentions])).toEqual([
      [`${WORKSPACE}/src`, 'dir', 2],
    ])
  })
})

describe('touched whitelist', () => {
  it('ignores tools that name no path, and does not count them as unparsed', async () => {
    const root = await project(oneSession([
      // `bash` is the largest kind of tool call, and its command line is free text: reading a path out
      // of it would be guessing, so it is dropped silently.
      tool(1, 1_000, 'bash', { command: 'cat src/app.ts' }),
      tool(2, 2_000, 'web_search', { queries: ['广告'] }),
      tool(3, 3_000, 'read', { file_path: '/repo/a.ts' }),
    ]))

    const result = ask(root)

    expect(result.resources.map(resource => resource.path)).toEqual(['/repo/a.ts'])
    expect(result.unparsed).toBe(0)
  })

  it('matches the tool name exactly, so a lookalike is not a path source', async () => {
    const root = await project(oneSession([
      tool(1, 1_000, 'Read', { file_path: '/repo/a.ts' }),
      tool(2, 2_000, 'read_file', { file_path: '/repo/b.ts' }),
    ]))

    expect(ask(root).resources).toEqual([])
    expect(ask(root).unparsed).toBe(0)
  })

  it('ignores a tool entry that carries no arguments at all', async () => {
    const root = await project(oneSession([rawTool(1, 1_000, 'read')]))

    expect(ask(root)).toMatchObject({ resources: [], total: 0, unparsed: 0 })
  })
})

describe('touched unparsed accounting', () => {
  it('counts a clipped entry without attempting its truncated JSON', async () => {
    const root = await project(oneSession([
      tool(1, 1_000, 'read', { file_path: '/repo/a.ts' }, true),
      tool(2, 2_000, 'read', { file_path: '/repo/b.ts' }),
    ]))

    const result = ask(root)

    expect(result.resources.map(resource => resource.path)).toEqual(['/repo/b.ts'])
    expect(result.unparsed).toBe(1)
  })

  it('counts an argument body that is not JSON', async () => {
    const root = await project(oneSession([rawTool(1, 1_000, 'read {not json}')]))

    expect(ask(root)).toMatchObject({ resources: [], unparsed: 1 })
  })

  it('counts a whitelisted call whose path field is absent, blank, or not a string', async () => {
    const root = await project(oneSession([
      tool(1, 1_000, 'read', { path: '/repo/wrong-field.ts' }),
      tool(2, 2_000, 'read', { file_path: '   ' }),
      tool(3, 3_000, 'read', { file_path: 42 }),
      tool(4, 4_000, 'grep', { path: '' }),
    ]))

    expect(ask(root)).toMatchObject({ resources: [], total: 0, unparsed: 4 })
  })

  it('counts a relative path when the session recorded no workspace', async () => {
    const root = await project(oneSession([tool(1, 1_000, 'read', { file_path: 'src/app.ts' })], ''))

    expect(ask(root)).toMatchObject({ resources: [], total: 0, unparsed: 1 })
  })

  it('still resolves an absolute path when the session recorded no workspace', async () => {
    const root = await project(oneSession([tool(1, 1_000, 'read', { file_path: '/repo/a.ts' })], ''))

    expect(ask(root).resources.map(resource => resource.path)).toEqual(['/repo/a.ts'])
  })
})

describe('touched merging', () => {
  it('merges one path across calls, keeping the span and the sorted tool set', async () => {
    const root = await project(oneSession([
      tool(1, 1_000, 'read', { file_path: '/repo/a.ts' }),
      tool(2, 2_000, 'edit', { file_path: '/repo/a.ts' }),
      tool(3, 3_000, 'read', { file_path: '/repo/a.ts' }),
      tool(4, 4_000, 'read', { file_path: '/repo/b.ts' }),
    ]))

    const [first, second] = ask(root).resources

    expect(first).toEqual({
      path: '/repo/a.ts',
      kind: 'file',
      mentions: 3,
      firstSeq: 1,
      lastSeq: 3,
      firstAt: 1_000,
      lastAt: 3_000,
      tools: ['edit', 'read'],
    })
    expect(second).toMatchObject({ path: '/repo/b.ts', mentions: 1 })
  })

  it('orders by mentions, then last touch, then path', async () => {
    const root = await project(oneSession([
      tool(1, 1_000, 'read', { file_path: '/repo/rare.ts' }),
      tool(2, 2_000, 'read', { file_path: '/repo/often.ts' }),
      tool(3, 3_000, 'read', { file_path: '/repo/often.ts' }),
      tool(4, 4_000, 'read', { file_path: '/repo/often.ts' }),
      tool(5, 5_000, 'read', { file_path: '/repo/tie-b.ts' }),
      tool(6, 6_000, 'read', { file_path: '/repo/tie-a.ts' }),
      tool(7, 7_000, 'read', { file_path: '/repo/rare.ts' }),
    ]))

    expect(ask(root).resources.map(resource => resource.path)).toEqual([
      '/repo/often.ts',
      '/repo/rare.ts',
      // `tie-a` is touched last, so it comes before `tie-b` even though both are mentioned once.
      '/repo/tie-a.ts',
      '/repo/tie-b.ts',
    ])
  })

  it('reports a path as a directory when any one call named it as one', async () => {
    const root = await project(oneSession([
      tool(1, 1_000, 'read', { file_path: '/repo/pkg' }),
      tool(2, 2_000, 'grep', { path: '/repo/pkg' }),
    ]))

    expect(ask(root).resources[0]).toMatchObject({ path: '/repo/pkg', kind: 'dir', mentions: 2, tools: ['grep', 'read'] })
  })
})

describe('touched paging', () => {
  /** Five resources, mentioned 5, 4, 3, 2, 1 times respectively. */
  const FIVE: SeedIndex = oneSession(
    Array.from({ length: 5 }, (_, index) => {
      const file = `/repo/f${index}.ts`
      const times = 5 - index
      return Array.from({ length: times }, (_, repeat) =>
        tool(index * 10 + repeat + 1, (index * 10 + repeat + 1) * 1_000, 'read', { file_path: file }))
    }).flat(),
  )

  it('slices the sorted resources and reports the pre-paging total', async () => {
    const root = await project(FIVE)
    const result = ask(root, SESSION, 2)

    expect(result.resources.map(resource => resource.path)).toEqual(['/repo/f0.ts', '/repo/f1.ts'])
    expect(result.total).toBe(5)
    expect(result.truncated).toBe(true)
  })

  it('pages with offset without repeating or dropping a resource', async () => {
    const root = await project(FIVE)
    const page = ask(root, SESSION, 2, 2)

    expect(page.resources.map(resource => [resource.path, resource.mentions])).toEqual([
      ['/repo/f2.ts', 3],
      ['/repo/f3.ts', 2],
    ])
    expect(page.total).toBe(5)
    expect(page.truncated).toBe(true)
  })

  it('is not truncated on the last page', async () => {
    const root = await project(FIVE)

    expect(ask(root, SESSION, 2, 4)).toMatchObject({
      resources: [expect.objectContaining({ path: '/repo/f4.ts' })],
      total: 5,
      truncated: false,
    })
  })

  it('returns no resources but a total when the page size is zero', async () => {
    const root = await project(FIVE)

    expect(ask(root, SESSION, 0)).toMatchObject({ resources: [], total: 5, truncated: true })
  })
})

describe('touched session resolution', () => {
  it('answers an empty result for a session with no tool entries', async () => {
    const root = await project(oneSession([{ seq: 1, time: 1_000, kind: 'user', text: '纯聊天，没有工具' }]))

    expect(ask(root)).toEqual({
      operation: 'touched',
      sessionId: SESSION,
      resources: [],
      total: 0,
      truncated: false,
      unparsed: 0,
    })
  })

  it('resolves a unique id prefix to the one session it names', async () => {
    const root = await project(oneSession([tool(1, 1_000, 'read', { file_path: '/repo/a.ts' })]))

    expect(ask(root, 'aaaa1111').sessionId).toBe(SESSION)
  })

  it('reports an unknown session as not found', async () => {
    const root = await project(oneSession([tool(1, 1_000, 'read', { file_path: '/repo/a.ts' })]))

    expect(() => ask(root, 'ffffffff'))
      .toThrow(expect.objectContaining<Partial<SessiongraphError>>({ code: 'SESSIONGRAPH_NOT_FOUND' }))
  })
})
