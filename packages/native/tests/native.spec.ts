import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tokenize } from 'dsh-plugin-sessiongraph-service'
import { loadNative } from '../src/index.ts'

/**
 * The native kernel is an optional acceleration: `loadNative()` returns `undefined` on a machine
 * where `build-native.sh` was never run, and every case below skips rather than fails. That keeps
 * `pnpm test` green on a clean checkout while still running for real once the `.node` is present.
 */
const kernel = loadNative()

let work: string
let sessionsRoot: string
let indexRoot: string
let indexPath: string

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'sessiongraph-native-'))
  sessionsRoot = join(work, 'sessions')
  indexRoot = join(work, 'index')
  indexPath = join(indexRoot, 'index.db')
  await mkdir(sessionsRoot, { recursive: true })
})

afterEach(async () => {
  await rm(work, { recursive: true, force: true })
})

/** A session header in the harness's flat shape. */
function header(id: string, cwd: string): Record<string, unknown> {
  return { type: 'session', version: 4, id, createdAt: 1_700_000_000_000, cwd, isSeeded: false, delegationDepth: 0 }
}

/**
 * Write one session log as several zstd frames, the way the harness appends them. The multi-frame
 * layout is the whole point: a decompressor that stops at the first frame would see one event.
 */
async function writeSession(
  workspaceDir: string,
  sessionDir: string,
  version: number,
  records: readonly unknown[],
): Promise<string> {
  const directory = join(sessionsRoot, workspaceDir, sessionDir)
  await mkdir(directory, { recursive: true })
  const frames = records.map(record => zstdCompressSync(Buffer.from(`${JSON.stringify(record)}\n`)))
  const filePath = join(directory, `session.v${version}.jsonl.zstd`)
  await writeFile(filePath, Buffer.concat(frames))
  return filePath
}

/** A user message event from a real human. */
function humanMessage(seq: number, time: number, text: string): Record<string, unknown> {
  return { type: 'user/message', seq, time, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }
}

/** An `assistant/message` event with the given content blocks. */
function assistantMessage(seq: number, time: number, blocks: readonly unknown[]): Record<string, unknown> {
  return { type: 'assistant/message', seq, time, data: { turn: 1, message: { content: blocks } } }
}

/** Build the three-session fixture the assertions below expect. */
async function seedFixture(): Promise<{ a: string; b: string; c: string }> {
  const a = await writeSession('--Users-admin-www-demo--', 'aaaa1111-1111-4111-8111-111111111111', 4, [
    header('aaaa1111-1111-4111-8111-111111111111', '/Users/admin/www/demo'),
    humanMessage(1, 1_700_000_000_100, '我今天在改广告SDK'),
    assistantMessage(2, 1_700_000_000_200, [
      { type: 'reasoning', text: 'reasoning-must-not-be-indexed' },
      { type: 'text', text: '好的，我们看 codegraph_index 的实现' },
      { type: 'tool-call', name: 'read', arguments: '{}' },
    ]),
    { type: 'tool/call', seq: 3, time: 1_700_000_000_300, data: { name: 'read', arguments: '{"path":"/tmp/x"}', turn: 1 } },
    { type: 'session/title', seq: 4, time: 1_700_000_000_400, data: { title: '广告 SDK 调试' } },
  ])
  const b = await writeSession('--Users-admin-www-demo--', 'bbbb2222-2222-4222-8222-222222222222', 3, [
    header('session-bbbb2222-2222-4222-8222-222222222222', '/Users/admin/www/demo'),
    { type: 'user/message', seq: 1, time: 1, data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'injected-context' }] } },
    { type: 'user/message', seq: 2, time: 2, data: { source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: 'injected-skill' }] } },
    assistantMessage(3, 3, [{ type: 'reasoning', text: 'only-reasoning' }]),
    humanMessage(4, 4, '第二个会话的消息'),
  ])
  const c = await writeSession('--Users-admin-www-other--', 'cccc3333-3333-4333-8333-333333333333', 4, [
    header('cccc3333-3333-4333-8333-333333333333', '/Users/admin/www/other'),
    humanMessage(1, 1_700_000_000_500, 'Hello Native Kernel'),
  ])
  return { a, b, c }
}

/** Open the written index read-only. */
function openIndex(): DatabaseSync {
  return new DatabaseSync(indexPath, { readOnly: true })
}

describe('loadNative', () => {
  it('never throws and reports the same answer twice', () => {
    expect(() => loadNative()).not.toThrow()
    expect(loadNative()).toBe(loadNative())
  })
})

describe('native index kernel', () => {
  it.skipIf(kernel === undefined)('writes the shared schema and a matching status sidecar', async () => {
    await seedFixture()
    const report = kernel!.indexSessions({ sessionsRoot, indexPath })

    // camelCase is what napi-rs produces from the Rust snake_case fields; the loader's types and
    // the seam's SessiongraphIndexReport both rely on it.
    expect(report).toHaveProperty('indexPath')
    expect(report).toHaveProperty('elapsedMs')
    expect('index_path' in report).toBe(false)

    expect(report.indexPath).toBe(indexPath)
    expect(report.discovered).toBe(3)
    expect(report.added).toBe(3)
    expect(report.updated).toBe(0)
    expect(report.skipped).toBe(0)
    expect(report.removed).toBe(0)
    expect(report.failed).toEqual([])
    expect(report.sessions).toBe(3)
    expect(report.workspaces).toBe(2)
    expect(report.entries).toBe(6)
    expect(report.bytes).toBeGreaterThan(0)
    expect(report.elapsedMs).toBeGreaterThanOrEqual(0)

    const database = openIndex()
    try {
      expect(database.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')).toEqual({ value: '1' })
      expect(database.prepare('SELECT value FROM meta WHERE key = ?').get('discovered')).toEqual({ value: '3' })
      expect(database.prepare('SELECT value FROM meta WHERE key = ?').get('failed')).toEqual({ value: '0' })
      expect(database.prepare('SELECT value FROM meta WHERE key = ?').get('indexed_at')).toBeTruthy()

      const session = database
        .prepare('SELECT workspace, title, created_at, last_at, turns, entries, source_size FROM session WHERE id = ?')
        .get('aaaa1111-1111-4111-8111-111111111111')
      expect(session).toMatchObject({
        workspace: '/Users/admin/www/demo',
        title: '广告 SDK 调试',
        created_at: 1_700_000_000_000,
        last_at: 1_700_000_000_400,
        turns: 1,
        entries: 4,
      })
      expect((session as { source_size: number }).source_size).toBeGreaterThan(0)

      // Reasoning, tool results, and injected context stay out of the entry table.
      const texts = database.prepare('SELECT text FROM entry').all().map(row => (row as { text: string }).text)
      expect(texts).toContain('我今天在改广告SDK')
      expect(texts).toContain('好的，我们看 codegraph_index 的实现')
      expect(texts).toContain('read {"path":"/tmp/x"}')
      expect(texts.some(text => text.includes('reasoning-must-not-be-indexed'))).toBe(false)
      expect(texts.some(text => text.includes('injected-context'))).toBe(false)

      // The bigram write side: a two-character Chinese word finds its sentence.
      const cjk = database.prepare('SELECT rowid FROM entry_fts WHERE entry_fts MATCH ?').all('"广告"')
      expect(cjk).toHaveLength(2)
      const latin = database.prepare('SELECT rowid FROM entry_fts WHERE entry_fts MATCH ?').all('"codegraph"')
      expect(latin).toHaveLength(1)

      // Token streams must be identical to the seam tokenizer's, or the TS store cannot answer.
      const rows = database
        .prepare('SELECT e.text AS text, f.tokens AS tokens FROM entry e JOIN entry_fts f ON f.rowid = e.id')
        .all() as { text: string; tokens: string }[]
      expect(rows.length).toBe(6)
      for (const row of rows) expect(row.tokens).toBe(tokenize(row.text).join(' '))
    } finally {
      database.close()
    }

    const status = JSON.parse(readFileSync(join(indexRoot, 'status.json'), 'utf8')) as Record<string, unknown>
    expect(status).toMatchObject({ schemaVersion: 1, sessions: 3, entries: 6, workspaces: 2, bytes: report.bytes })
    expect(status.indexedAt).toBeGreaterThan(0)

    expect(existsSync(`${indexPath}.tmp`)).toBe(false)
  })

  it.skipIf(kernel === undefined)('is incremental and re-writes only changed sources', async () => {
    const files = await seedFixture()
    const first = kernel!.indexSessions({ sessionsRoot, indexPath })
    expect(first.added).toBe(3)

    const second = kernel!.indexSessions({ sessionsRoot, indexPath })
    expect(second.added).toBe(0)
    expect(second.updated).toBe(0)
    expect(second.skipped).toBe(3)
    expect(second.entries).toBe(6)

    // Rewrite one session with an extra event: size and mtime both move, so it is re-read.
    await writeFile(
      files.a,
      Buffer.concat(
        [header('aaaa1111-1111-4111-8111-111111111111', '/Users/admin/www/demo'), humanMessage(1, 1, '一条更长的正文')].map(
          record => zstdCompressSync(Buffer.from(`${JSON.stringify(record)}\n`)),
        ),
      ),
    )
    const third = kernel!.indexSessions({ sessionsRoot, indexPath })
    expect(third.updated).toBe(1)
    expect(third.skipped).toBe(2)
    expect(third.sessions).toBe(3)
    expect(third.entries).toBe(4)
  })

  it.skipIf(kernel === undefined)('removes sessions whose source file disappeared', async () => {
    const files = await seedFixture()
    kernel!.indexSessions({ sessionsRoot, indexPath })

    await rm(files.c)
    const report = kernel!.indexSessions({ sessionsRoot, indexPath })
    expect(report.discovered).toBe(2)
    expect(report.removed).toBe(1)
    expect(report.sessions).toBe(2)
    expect(report.entries).toBe(5)

    const database = openIndex()
    try {
      expect(database.prepare('SELECT COUNT(*) AS n FROM session WHERE id = ?').get('cccc3333-3333-4333-8333-333333333333')).toEqual({ n: 0 })
      expect(database.prepare('SELECT COUNT(*) AS n FROM entry WHERE session_id = ?').get('cccc3333-3333-4333-8333-333333333333')).toEqual({ n: 0 })
    } finally {
      database.close()
    }
  })

  it.skipIf(kernel === undefined)('force rebuilds through index.db.tmp and keeps out-of-scope rows', async () => {
    await seedFixture()
    kernel!.indexSessions({ sessionsRoot, indexPath })

    const report = kernel!.indexSessions({
      sessionsRoot,
      indexPath,
      force: true,
      workspaceFilter: '/Users/admin/www/demo',
    })

    // Every scanned session was re-read, so `updated` counts them; the scoped rebuild copied the
    // out-of-scope workspace from the previous index instead of deleting it.
    expect(report.updated).toBe(2)
    expect(report.added).toBe(0)
    expect(report.sessions).toBe(3)
    expect(report.workspaces).toBe(2)
    expect(existsSync(`${indexPath}.tmp`)).toBe(false)

    const database = openIndex()
    try {
      expect(database.prepare('SELECT COUNT(*) AS n FROM session WHERE id = ?').get('cccc3333-3333-4333-8333-333333333333')).toEqual({ n: 1 })
    } finally {
      database.close()
    }
  })

  it.skipIf(kernel === undefined)('treats a missing sessions root as an empty index', async () => {
    const report = kernel!.indexSessions({ sessionsRoot: join(work, 'never-existed'), indexPath })
    expect(report.discovered).toBe(0)
    expect(report.sessions).toBe(0)
    expect(report.entries).toBe(0)
    expect(existsSync(indexPath)).toBe(true)
    expect(JSON.parse(await readFile(join(indexRoot, 'status.json'), 'utf8'))).toMatchObject({ sessions: 0, entries: 0 })
  })
})
