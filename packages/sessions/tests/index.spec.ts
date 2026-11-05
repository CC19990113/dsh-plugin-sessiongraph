import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { INDEX_RELATIVE_PATH } from 'dsh-plugin-sessiongraph-service'
import * as ServicePlugin from 'dsh-plugin-sessiongraph-service'
import * as SessionsPlugin from '../src/index.ts'
import type { ResolvedConfig } from '../src/index.ts'

/** One session log to write into a fixture session store. */
interface SessionSpec {
  /** Escaped workspace directory name. */
  readonly workspace: string
  /** Session directory name. */
  readonly id: string
  /** Log format version (defaults to 4). */
  readonly version?: number
  /** Log contents, first record being the header. */
  readonly records: readonly unknown[]
}

/** Temporary roots for one test. */
interface Fixture {
  readonly work: string
  readonly sessionsRoot: string
  readonly indexRoot: string
}

let fixture: Fixture

beforeEach(async () => {
  const work = await mkdtemp(join(tmpdir(), 'sessiongraph-sessions-'))
  fixture = { work, sessionsRoot: join(work, 'sessions'), indexRoot: join(work, 'index') }
  await mkdir(fixture.sessionsRoot, { recursive: true })
})

afterEach(async () => {
  await rm(fixture.work, { recursive: true, force: true })
})

/** The resolved configuration a real deployment would hand `apply`. */
function config(): ResolvedConfig {
  return {
    sessionsRoot: fixture.sessionsRoot,
    indexRoot: fixture.indexRoot,
    maxEntryChars: 4_000,
    toolCallChars: 2_000,
    maxFileBytes: 64 * 1024 * 1024,
    autoIndex: true,
    backgroundIndexThreshold: 1_000,
    autoIndexTimeoutMs: 900_000,
    maxLiveSessions: 8,
    engine: 'typescript',
  }
}

/** A session header in the harness's flat shape. */
function header(id: string, cwd: string): Record<string, unknown> {
  return { type: 'session', version: 4, id, createdAt: 1_700_000_000_000, cwd, isSeeded: false, delegationDepth: 0 }
}

/** One event line. */
function event(type: string, seq: number, time: number, data: unknown): Record<string, unknown> {
  return { type, seq, time, data }
}

/** A human user message. */
function userMessage(seq: number, time: number, text: string): Record<string, unknown> {
  return event('user/message', seq, time, { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
}

/** An assistant reply carrying one visible text block. */
function assistantMessage(seq: number, time: number, text: string): Record<string, unknown> {
  return event('assistant/message', seq, time, {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  })
}

/** A session title event. */
function title(seq: number, time: number, text: string): Record<string, unknown> {
  return event('session/title', seq, time, { title: text, source: { kind: 'provider' } })
}

/** Compress records into one multi-frame log, as the harness appends them. */
function log(records: readonly unknown[]): Buffer {
  return Buffer.concat(records.map(record => zstdCompressSync(Buffer.from(`${JSON.stringify(record)}\n`))))
}

/** Write one session log into the fixture store. */
async function writeSession(spec: SessionSpec): Promise<string> {
  const directory = join(fixture.sessionsRoot, spec.workspace, spec.id)
  await mkdir(directory, { recursive: true })
  const path = join(directory, `session.v${spec.version ?? 4}.jsonl.zstd`)
  await writeFile(path, log(spec.records))
  return path
}

/** A small session whose text is easy to find in the index. */
async function writeDemoSession(workspace = '--Users-admin-www-demo--', id = 'session-aaaa'): Promise<string> {
  return writeSession({
    workspace,
    id,
    records: [
      header(id, '/Users/admin/www/demo'),
      event('turn/start', 1, 1_700_000_000_100, { turn: 1 }),
      userMessage(2, 1_700_000_000_200, '我今天在改广告SDK'),
      assistantMessage(3, 1_700_000_000_300, '先看竞价逻辑。'),
      title(4, 1_700_000_000_400, '广告 SDK 排查'),
    ],
  })
}

/** Run one index pass and return its report. */
const runIndex = SessionsPlugin.runIndex

/** Read the sidecar summary the indexer leaves beside the index. */
function readStatus(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixture.indexRoot, SessionsPlugin.STATUS_RELATIVE_PATH), 'utf8')) as Record<
    string,
    unknown
  >
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

describe('runIndex', () => {
  it('indexes both log versions and makes their text searchable', async () => {
    await writeSession({
      workspace: '--Users-admin-www-demo--',
      id: 'session-aaaa',
      version: 4,
      records: [
        header('session-aaaa', '/Users/admin/www/demo'),
        event('turn/start', 1, 1_700_000_000_100, { turn: 1 }),
        userMessage(2, 1_700_000_000_200, '我今天在改广告SDK'),
        assistantMessage(3, 1_700_000_000_300, '先看竞价逻辑。'),
        title(4, 1_700_000_000_400, '广告 SDK 排查'),
      ],
    })
    await writeSession({
      workspace: '--Users-admin-www-old--',
      id: 'session-bbbb',
      version: 3,
      records: [
        header('session-bbbb', '/Users/admin/www/old'),
        event('turn/start', 1, 1_700_000_000_100, { turn: 1 }),
        userMessage(2, 1_700_000_000_200, '旧版会话也记录了域名'),
        title(3, 1_700_000_000_300, '旧版会话'),
      ],
    })

    const report = await runIndex(fixture.indexRoot, {}, undefined, config())

    expect(report.failed).toEqual([])
    expect(report).toMatchObject({ added: 2, updated: 0, skipped: 0, removed: 0, discovered: 2, sessions: 2, workspaces: 2 })
    expect(report.entries).toBeGreaterThan(0)
    expect(report.bytes).toBeGreaterThan(0)

    const sessions = query('SELECT id, workspace, title, turns, entries FROM session ORDER BY id')
    expect(sessions).toHaveLength(2)
    expect(sessions[0]).toMatchObject({
      id: 'session-aaaa',
      workspace: '/Users/admin/www/demo',
      title: '广告 SDK 排查',
      turns: 1,
    })
    expect(sessions[1]).toMatchObject({ id: 'session-bbbb', workspace: '/Users/admin/www/old' })

    const kinds = query('SELECT kind, text FROM entry WHERE session_id = ? ORDER BY id', 'session-aaaa').map(row => row.kind)
    expect(kinds).toEqual(['user', 'assistant', 'title'])

    // The bigram tokenizer is what makes a two-character Chinese query work at all.
    const hits = query(`SELECT rowid FROM entry_fts WHERE entry_fts MATCH ?`, '"广告"')
    expect(hits.length).toBeGreaterThan(0)

    // The index is contentless, so the token stream itself cannot be read back. Assert the same
    // property through the inverted index instead: the overlapping bigrams of `我今天在改广告` plus
    // the lowercased `sdk` all have to line up on exactly one row.
    const composed = query(
      'SELECT rowid FROM entry_fts WHERE entry_fts MATCH ?',
      '"我今" AND "今天" AND "天在" AND "在改" AND "改广" AND "广告" AND "sdk"',
    )
    expect(composed).toHaveLength(1)

    expect(readStatus()).toMatchObject({
      schemaVersion: 2,
      indexedAt: expect.any(Number),
      sessions: report.sessions,
      entries: report.entries,
      workspaces: report.workspaces,
      bytes: report.bytes,
    })

    const meta = query('SELECT key, value FROM meta ORDER BY key')
    expect(Object.fromEntries(meta.map(row => [row.key, row.value]))).toMatchObject({
      schema_version: '2',
      discovered: '2',
      failed: '0',
    })
  })

  it('skips sessions whose log did not change', async () => {
    await writeDemoSession()
    await runIndex(fixture.indexRoot, {}, undefined, config())

    const report = await runIndex(fixture.indexRoot, {}, undefined, config())

    expect(report).toMatchObject({ added: 0, updated: 0, skipped: 1, removed: 0, entries: 3, sessions: 1 })
    // The sidecar describes the whole index, so an incremental run that wrote nothing still refreshes it.
    expect(readStatus()).toMatchObject({ sessions: 1, entries: 3, workspaces: 1 })
  })

  it('rewrites a session whose log grew, replacing its old rows', async () => {
    const path = await writeDemoSession()
    await runIndex(fixture.indexRoot, {}, undefined, config())

    await writeFile(
      path,
      log([
        header('session-aaaa', '/Users/admin/www/demo'),
        event('turn/start', 1, 1_700_000_000_100, { turn: 1 }),
        userMessage(2, 1_700_000_000_200, '追加后的新内容'),
      ]),
    )
    const report = await runIndex(fixture.indexRoot, {}, undefined, config())

    expect(report).toMatchObject({ added: 0, updated: 1, skipped: 0, entries: 1 })
    const texts = query('SELECT text FROM entry WHERE session_id = ? ORDER BY id', 'session-aaaa').map(row => row.text)
    expect(texts).toEqual(['追加后的新内容'])
    // A rewritten session must not strand its previous FTS rows.
    expect(query('SELECT COUNT(*) AS n FROM entry_fts')[0]?.n).toBe(query('SELECT COUNT(*) AS n FROM entry')[0]?.n)
  })

  it('rebuilds everything through the temporary file when forced', async () => {
    await writeDemoSession()
    await runIndex(fixture.indexRoot, {}, undefined, config())

    const report = await runIndex(fixture.indexRoot, { force: true }, undefined, config())

    expect(report).toMatchObject({ added: 0, updated: 1, skipped: 0, sessions: 1 })
    expect(report.entries).toBe(3)
    expect(existsSync(join(fixture.indexRoot, `${INDEX_RELATIVE_PATH}.tmp`))).toBe(false)
    expect(existsSync(join(fixture.indexRoot, `${SessionsPlugin.STATUS_RELATIVE_PATH}.tmp`))).toBe(false)
    expect(readStatus()).toMatchObject({ sessions: 1, entries: 3, bytes: report.bytes })
  })

  it('drops sessions whose log disappeared', async () => {
    await writeDemoSession()
    await runIndex(fixture.indexRoot, {}, undefined, config())
    await rm(join(fixture.sessionsRoot, '--Users-admin-www-demo--'), { recursive: true, force: true })

    const report = await runIndex(fixture.indexRoot, {}, undefined, config())

    expect(report).toMatchObject({ removed: 1, skipped: 0, sessions: 0, entries: 0 })
    expect(readStatus()).toMatchObject({ sessions: 0, entries: 0, workspaces: 0 })
    expect(query('SELECT id FROM session')).toEqual([])
    expect(query('SELECT id FROM entry')).toEqual([])
  })

  it('ignores files that are not session logs', async () => {
    await writeDemoSession()
    await writeFile(join(fixture.sessionsRoot, '.DS_Store'), 'junk')
    await writeFile(join(fixture.sessionsRoot, '--Users-admin-www-demo--', 'notes.txt'), 'junk')
    await writeFile(
      join(fixture.sessionsRoot, '--Users-admin-www-demo--', 'session-aaaa', 'session.lock'),
      'junk',
    )

    const report = await runIndex(fixture.indexRoot, {}, undefined, config())

    expect(report).toMatchObject({ discovered: 1, sessions: 1, failed: [] })
  })

  it('reports a corrupt log in failed and keeps the other sessions', async () => {
    await writeDemoSession()
    await mkdir(join(fixture.sessionsRoot, '--Users-admin-www-broken--', 'session-broken'), { recursive: true })
    await writeFile(join(fixture.sessionsRoot, '--Users-admin-www-broken--', 'session-broken', 'session.v4.jsonl.zstd'), 'not zstd')

    const report = await runIndex(fixture.indexRoot, {}, undefined, config())

    expect(report.failed).toHaveLength(1)
    expect(report.failed[0]?.path).toContain('session-broken')
    expect(report.failed[0]?.reason).toMatch(/zstd/)
    expect(report).toMatchObject({ discovered: 2, sessions: 1 })
  })

  it('skips logs over maxFileBytes and reports them', async () => {
    await writeDemoSession()
    const limited: ResolvedConfig = { ...config(), maxFileBytes: 16 }

    const report = await runIndex(fixture.indexRoot, {}, undefined, limited)

    expect(report.failed).toHaveLength(1)
    expect(report.failed[0]?.reason).toMatch(/maxFileBytes/)
    expect(report).toMatchObject({ sessions: 0, added: 0 })
  })

  it('scopes an incremental run to one workspace without dropping the others', async () => {
    await writeDemoSession()
    await writeSession({
      workspace: '--Users-admin-www-other--',
      id: 'session-cccc',
      records: [header('session-cccc', '/Users/admin/www/other'), userMessage(1, 1_700_000_000_200, '别的工作区')],
    })

    const scoped = await runIndex(fixture.indexRoot, { workspace: '/Users/admin/www/demo' }, undefined, config())
    expect(scoped).toMatchObject({ added: 1, discovered: 2, sessions: 1 })

    const full = await runIndex(fixture.indexRoot, {}, undefined, config())
    expect(full).toMatchObject({ added: 1, skipped: 1, sessions: 2, workspaces: 2 })

    // A scoped rebuild must copy the out-of-scope rows forward instead of erasing them.
    const rebuilt = await runIndex(fixture.indexRoot, { force: true, workspace: '/Users/admin/www/demo' }, undefined, config())
    expect(rebuilt).toMatchObject({ updated: 1, skipped: 0, sessions: 2 })
    expect(query('SELECT session_id FROM entry WHERE text = ?', '别的工作区')).toHaveLength(1)
  })

  it('indexes only one session when asked by id prefix', async () => {
    await writeDemoSession('--Users-admin-www-demo--', 'session-aaaa')
    await writeSession({
      workspace: '--Users-admin-www-other--',
      id: 'session-cccc',
      records: [header('session-cccc', '/Users/admin/www/other'), userMessage(1, 1_700_000_000_200, '另一个会话')],
    })

    const report = await runIndex(fixture.indexRoot, { sessionId: 'session-cccc' }, undefined, config())

    expect(report).toMatchObject({ added: 1, discovered: 2, sessions: 1 })
    expect(query('SELECT id FROM session')).toEqual([{ id: 'session-cccc' }])
  })

  it('picks the newest log version inside one session directory', async () => {
    await writeSession({
      workspace: '--Users-admin-www-demo--',
      id: '01117944-7a1c-4a3d-944f-269a9c30fc4b',
      version: 3,
      records: [header('01117944-7a1c-4a3d-944f-269a9c30fc4b', '/Users/admin/www/demo'), title(1, 1_700_000_000_100, '旧版本号')],
    })
    await writeSession({
      workspace: '--Users-admin-www-demo--',
      id: '01117944-7a1c-4a3d-944f-269a9c30fc4b',
      version: 4,
      records: [header('01117944-7a1c-4a3d-944f-269a9c30fc4b', '/Users/admin/www/demo'), title(1, 1_700_000_000_100, '新版本号')],
    })

    const report = await runIndex(fixture.indexRoot, {}, undefined, config())

    expect(report).toMatchObject({ discovered: 1, sessions: 1 })
    expect(query('SELECT title FROM session')).toEqual([{ title: '新版本号' }])
  })
})

describe('apply', () => {
  it('registers an indexer the seam can route a build to', async () => {
    await writeDemoSession()
    const ctx = new Context()
    await ctx.plugin(ServicePlugin)
    await ctx.plugin(SessionsPlugin, { sessionsRoot: fixture.sessionsRoot, engine: 'typescript' })

    const seam = (ctx as unknown as { readonly sessiongraph: { index: typeof runIndex } }).sessiongraph
    const report = await seam.index(fixture.indexRoot, {})

    expect(report.sessions).toBe(1)
    expect(query('SELECT title FROM session')).toEqual([{ title: '广告 SDK 排查' }])
  })
})
