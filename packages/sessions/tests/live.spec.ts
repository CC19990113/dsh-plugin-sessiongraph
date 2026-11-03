import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
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
  const work = await mkdtemp(join(tmpdir(), 'sessiongraph-live-'))
  fixture = { work, sessionsRoot: join(work, 'sessions'), indexRoot: join(work, 'index') }
  await mkdir(fixture.sessionsRoot, { recursive: true })
})

afterEach(async () => {
  vi.restoreAllMocks()
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
    maxLiveSessions: 8,
    engine: 'typescript',
    ...overrides,
  }
}

/** One event line, shaped exactly like a JSONL log line. */
function event(type: string, seq: number, time: number, data: unknown): Record<string, unknown> {
  return { type, seq, time, data }
}

/** A human message event. */
function userMessage(seq: number, text: string): Record<string, unknown> {
  return event('user/message', seq, 1_700_000_000_000 + seq, {
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  })
}

/** One session the stub host reports as live. */
interface StubLiveSession {
  readonly id: string
  readonly cwd: string
  readonly createdAt?: number
  readonly events: readonly unknown[]
}

/** A stand-in for the host's `sessionQuery` service. */
function stubQuery(
  sessions: readonly StubLiveSession[],
  options: { failList?: boolean; failReadIds?: readonly string[] } = {},
): {
  listSessions(): Promise<unknown[]>
  readSession(sessionId: string): Promise<unknown>
} {
  const failing = new Set(options.failReadIds ?? [])
  return {
    async listSessions(): Promise<unknown[]> {
      if (options.failList === true) throw new Error('SESSION_QUERY_PERSISTENCE_FAILED')
      return sessions.map(session => ({
        header: { id: session.id, cwd: session.cwd, createdAt: session.createdAt ?? 1_700_000_000_000 },
        live: true,
        persisted: false,
      }))
    },
    async readSession(sessionId: string): Promise<unknown> {
      if (failing.has(sessionId)) throw new Error('SESSION_QUERY_PERSISTENCE_FAILED')
      const session = sessions.find(candidate => candidate.id === sessionId)
      if (session === undefined) throw new Error(`no live session ${sessionId}`)
      return {
        session: {
          type: 'session',
          version: 4,
          id: session.id,
          cwd: session.cwd,
          createdAt: session.createdAt ?? 1_700_000_000_000,
        },
        inheritedEventCount: 0,
        events: session.events,
      }
    },
  }
}

/** Compress one log line as its own zstd frame, as the harness appends them. */
function frame(record: unknown): Buffer {
  return zstdCompressSync(Buffer.from(`${JSON.stringify(record)}\n`))
}

/** Write one persisted session log into the fixture store. */
async function writeSessionLog(id = 'session-file'): Promise<void> {
  const directory = join(fixture.sessionsRoot, '--Users-admin-www-demo--', id)
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'session.v4.jsonl.zstd'),
    Buffer.concat([
      frame({ type: 'session', version: 4, id, createdAt: 1_700_000_000_000, cwd: '/Users/admin/www/demo' }),
      frame(userMessage(1, `落盘会话 ${id}`)),
    ]),
  )
}

/**
 * Mount the service and this plugin, optionally serving a stub session-query service.
 * @param options - plugin config overrides and the stub to provide.
 * @returns the mounted context.
 */
async function mount(options: { sessionQuery?: unknown; config?: Partial<ResolvedConfig> } = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(ServicePlugin)
  if (options.sessionQuery !== undefined) ctx.provide('sessionQuery', options.sessionQuery)
  await ctx.plugin(SessionsPlugin, config(options.config))
  return ctx
}

/** Read rows from the written index. */
function query(sql: string, ...parameters: (string | number | null)[]): Record<string, unknown>[] {
  const database = new DatabaseSync(join(fixture.indexRoot, INDEX_RELATIVE_PATH), { readOnly: true })
  try {
    return database.prepare(sql).all(...parameters)
  } finally {
    database.close()
  }
}

/** The indexed session rows, id-only, for compact assertions. */
function indexedSessionIds(): string[] {
  return query('SELECT id FROM session ORDER BY id').map(row => String(row.id))
}

describe('live session indexing', () => {
  it('indexes a session the file scan cannot see, and its text becomes searchable', async () => {
    const ctx = await mount({
      sessionQuery: stubQuery([
        {
          id: 'session-live',
          cwd: '/Users/admin/www/demo',
          events: [
            event('turn/start', 1, 1_700_000_000_100, { turn: 1 }),
            userMessage(2, '帮我看看广告SDK的竞价逻辑'),
            event('assistant/message', 3, 1_700_000_000_300, {
              turn: 1,
              step: 1,
              message: { role: 'assistant', content: [{ type: 'text', text: '先看竞价模块。' }] },
            }),
            event('tool/call', 4, 1_700_000_000_400, { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }),
          ],
        },
      ]),
    })

    const report = await ctx.sessiongraph.index(fixture.indexRoot, {})

    expect(report.liveSessions).toBe(1)
    expect(report.liveSkipped).toBe(0)
    expect(report.sessions).toBe(1)
    expect(report.entries).toBe(3)
    expect(indexedSessionIds()).toEqual(['session-live'])

    const session = query('SELECT workspace, source_path, entries, turns FROM session WHERE id = ?', 'session-live')[0]
    expect(session).toMatchObject({
      workspace: '/Users/admin/www/demo',
      source_path: 'live://session-live',
      entries: 3,
      turns: 1,
    })

    const kinds = query('SELECT kind FROM entry WHERE session_id = ? ORDER BY id', 'session-live').map(row => row.kind)
    expect(kinds).toEqual(['user', 'assistant', 'tool'])
    // The two-character Chinese word is the whole point: it must match through the bigram tokenizer.
    expect(query(`SELECT rowid FROM entry_fts WHERE entry_fts MATCH ?`, '"广告"').length).toBeGreaterThan(0)
  })

  it('rebuilds a live session every run, replacing its previous rows', async () => {
    const session: StubLiveSession = { id: 'session-live', cwd: '/Users/admin/www/demo', events: [userMessage(1, '第一版内容')] }
    const sessions: StubLiveSession[] = [session]
    const ctx = await mount({ sessionQuery: stubQuery(sessions) })
    await ctx.sessiongraph.index(fixture.indexRoot, {})

    const next: StubLiveSession = { id: 'session-live', cwd: '/Users/admin/www/demo', events: [userMessage(1, '第二版内容')] }
    sessions.splice(0, sessions.length, next)
    const report = await ctx.sessiongraph.index(fixture.indexRoot, {})

    expect(report).toMatchObject({ added: 0, updated: 0, skipped: 0, liveSessions: 1 })
    expect(query('SELECT text FROM entry WHERE session_id = ?', 'session-live')).toEqual([{ text: '第二版内容' }])
    expect(query('SELECT COUNT(*) AS n FROM entry_fts')[0]?.n).toBe(query('SELECT COUNT(*) AS n FROM entry')[0]?.n)
  })

  it('behaves exactly as before when the host has no sessionQuery service', async () => {
    await writeSessionLog()
    const ctx = await mount()

    const report = await ctx.sessiongraph.index(fixture.indexRoot, {})

    expect(report).toMatchObject({ liveSessions: 0, liveSkipped: 0, added: 1, sessions: 1 })
    expect(indexedSessionIds()).toEqual(['session-file'])
  })

  it('commits the file-path index even when the live read fails', async () => {
    await writeSessionLog()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ctx = await mount({
      sessionQuery: stubQuery(
        [{ id: 'session-live', cwd: '/Users/admin/www/demo', events: [userMessage(1, 'live')] }],
        { failReadIds: ['session-live'] },
      ),
    })

    const report = await ctx.sessiongraph.index(fixture.indexRoot, {})

    expect(report).toMatchObject({ liveSessions: 0, liveSkipped: 0, added: 1, sessions: 1 })
    expect(indexedSessionIds()).toEqual(['session-file'])
    expect(logged).toHaveBeenCalledTimes(1)
  })

  it('skips the live pass when the list itself fails', async () => {
    await writeSessionLog()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ctx = await mount({ sessionQuery: stubQuery([], { failList: true }) })

    const report = await ctx.sessiongraph.index(fixture.indexRoot, {})

    expect(report.liveSessions).toBe(0)
    expect(indexedSessionIds()).toEqual(['session-file'])
    expect(logged).toHaveBeenCalledTimes(1)
  })

  it('caps how many live sessions one run replays and reports the rest as skipped', async () => {
    const live = ['session-a', 'session-b', 'session-c'].map(id => ({
      id,
      cwd: '/Users/admin/www/demo',
      createdAt: 1_700_000_000_000 + id.charCodeAt(id.length - 1),
      events: [userMessage(1, `${id} 的内容`)],
    }))
    const ctx = await mount({ sessionQuery: stubQuery(live), config: { maxLiveSessions: 2 } })

    const report = await ctx.sessiongraph.index(fixture.indexRoot, {})

    expect(report).toMatchObject({ liveSessions: 2, liveSkipped: 1 })
    // Newest first, so the two most recent conversations stay searchable.
    expect(indexedSessionIds()).toEqual(['session-a', 'session-b'])
  })

  it('applies the workspace and session filters to the live set', async () => {
    const stub = stubQuery([
      { id: 'session-keep', cwd: '/Users/admin/www/demo', events: [userMessage(1, '保留')] },
      { id: 'session-drop', cwd: '/Users/admin/www/other', events: [userMessage(1, '丢弃')] },
    ])
    const ctx = await mount({ sessionQuery: stub })

    const byWorkspace = await ctx.sessiongraph.index(fixture.indexRoot, { workspace: '/Users/admin/www/demo' })
    expect(byWorkspace.liveSessions).toBe(1)
    expect(indexedSessionIds()).toEqual(['session-keep'])

    // A scoped run keeps what it did not cover: the earlier workspace's row survives, and the
    // newly requested session is added beside it.
    const bySession = await ctx.sessiongraph.index(fixture.indexRoot, { sessionId: 'session-drop' })
    expect(bySession.liveSessions).toBe(1)
    expect(indexedSessionIds()).toEqual(['session-drop', 'session-keep'])
  })

  it('rebuilds live sessions on a forced run too', async () => {
    const ctx = await mount({
      sessionQuery: stubQuery([{ id: 'session-live', cwd: '/Users/admin/www/demo', events: [userMessage(1, '强制')] }]),
    })
    await ctx.sessiongraph.index(fixture.indexRoot, {})

    const report = await ctx.sessiongraph.index(fixture.indexRoot, { force: true })

    expect(report.liveSessions).toBe(1)
    expect(query('SELECT text FROM entry WHERE session_id = ?', 'session-live')).toEqual([{ text: '强制' }])
    expect(existsSync(join(fixture.indexRoot, SessionsPlugin.STATUS_RELATIVE_PATH))).toBe(true)
  })

  it('does not let a file scan remove a live row it knows nothing about', async () => {
    const sessions: StubLiveSession[] = [
      { id: 'session-live', cwd: '/Users/admin/www/demo', events: [userMessage(1, '还在跑')] },
    ]
    const ctx = await mount({ sessionQuery: stubQuery(sessions) })
    await ctx.sessiongraph.index(fixture.indexRoot, {})

    // The host reports no live sessions on the next run (the session just ended, its log is not
    // written yet): the file scan must not treat the synthetic row as a vanished source.
    sessions.splice(0, sessions.length)
    const report = await ctx.sessiongraph.index(fixture.indexRoot, {})

    expect(report.removed).toBe(0)
    expect(indexedSessionIds()).toEqual(['session-live'])
  })
})
