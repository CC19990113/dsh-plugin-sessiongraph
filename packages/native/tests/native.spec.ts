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
    { type: 'turn/start', seq: 2, time: 1_700_000_000_150, data: { turn: 1 } },
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

/**
 * Seed one live-session row the way the caller's live pass writes it: a synthetic `live://<id>`
 * source path, zero mtime/size (there is no file version), plus its entry and FTS row.
 */
function seedLiveRow(sessionId: string, text: string): void {
  const database = new DatabaseSync(indexPath)
  try {
    database
      .prepare(
        `INSERT INTO session
           (id, workspace, title, created_at, last_at, parent_session, origin, agent_preset, turns,
            entries, source_path, source_mtime, source_size)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sessionId, '/Users/admin/www/live', null, 1, 2, null, 'user', null, 0, 1, `live://${sessionId}`, 0, 0)
    const inserted = database
      .prepare('INSERT INTO entry (session_id, seq, time, turn, kind, text, clipped) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(sessionId, 1, 2, null, 'user', text, 0)
    database
      .prepare('INSERT INTO entry_fts (rowid, tokens) VALUES (?, ?)')
      .run(Number(inserted.lastInsertRowid), tokenize(text).join(' '))
  } finally {
    database.close()
  }
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
    // The native kernel has no host `sessionQuery`, so it reports the optional live fields as 0
    // rather than `undefined`: the caller's live pass owns those rows.
    expect(report.liveSessions).toBe(0)
    expect(report.liveSkipped).toBe(0)
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
    // Sessions B and C are untouched (one entry each); A now holds only its single rewritten message.
    expect(third.entries).toBe(3)
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

  it.skipIf(kernel === undefined)('accepts the camelCase parse limits and file cap', async () => {
    const long = 'x'.repeat(100)
    await writeSession('--Users-admin-www-limits--', 'limits', 4, [
      header('limits-id', '/Users/admin/www/limits'),
      humanMessage(1, 1, long),
      { type: 'tool/call', seq: 2, time: 2, data: { name: 'tool', arguments: long } },
    ])

    const report = kernel!.indexSessions({ sessionsRoot, indexPath, maxEntryChars: 20, toolCallChars: 10 })
    expect(report.entries).toBe(2)

    const database = openIndex()
    try {
      // napi maps the Rust `max_entry_chars`/`tool_call_chars` fields to these JS names; the entry
      // text proves the values crossed the boundary rather than silently defaulting to 4000/2000.
      expect(database.prepare('SELECT kind, text, clipped FROM entry ORDER BY id').all()).toEqual([
        { kind: 'user', text: 'x'.repeat(20), clipped: 1 },
        { kind: 'tool', text: 'tool xxxxx', clipped: 1 },
      ])
    } finally {
      database.close()
    }

    // A log larger than the cap is reported, not parsed, and the run still writes a valid index.
    const capped = kernel!.indexSessions({ sessionsRoot, indexPath, force: true, maxFileBytes: 10 })
    expect(capped.failed).toHaveLength(1)
    expect(capped.failed[0]!.reason).toContain('maxFileBytes')
    expect(capped.failed[0]!.reason.length).toBeLessThanOrEqual(200)
    expect(capped.sessions).toBe(0)
  })

  it.skipIf(kernel === undefined)('keeps the newer source when one session id appears twice', async () => {
    // A v3 → v4 migration or a workspace move can leave the same id under two paths. Scan order is
    // deterministic (workspace, then session dir), so this asserts the newer *mtime* wins, not the
    // later path.
    await writeSession('--Users-admin-www-one--', 'dup', 4, [
      header('dup-id', '/Users/admin/www/one'),
      humanMessage(1, 1, 'older copy'),
    ])
    await new Promise(resolve => setTimeout(resolve, 25))
    await writeSession('--Users-admin-www-two--', 'dup', 4, [
      header('dup-id', '/Users/admin/www/two'),
      humanMessage(1, 1, 'newer copy'),
    ])

    const report = kernel!.indexSessions({ sessionsRoot, indexPath })
    expect(report.discovered).toBe(2)
    expect(report.sessions).toBe(1)
    expect(report.entries).toBe(1)
    // The superseded copy is not written at all: it is reported as skipped.
    expect(report.skipped).toBe(1)

    const database = openIndex()
    try {
      expect(database.prepare('SELECT workspace FROM session WHERE id = ?').get('dup-id')).toEqual({
        workspace: '/Users/admin/www/two',
      })
      expect(database.prepare('SELECT text FROM entry').all()).toEqual([{ text: 'newer copy' }])
    } finally {
      database.close()
    }
  })

  it.skipIf(kernel === undefined)('preserves live rows written by the caller\'s live pass', async () => {
    await seedFixture()
    kernel!.indexSessions({ sessionsRoot, indexPath })
    seedLiveRow('live-session-1', '实时会话里的广告改动')

    const report = kernel!.indexSessions({ sessionsRoot, indexPath })
    // A file scan cannot see a live session, so "not in this scan" must not delete it.
    expect(report.removed).toBe(0)
    expect(report.skipped).toBe(3)
    expect(report.sessions).toBe(4)
    expect(report.entries).toBe(7)

    const database = openIndex()
    try {
      expect(database.prepare('SELECT source_path, source_mtime, source_size FROM session WHERE id = ?').get('live-session-1')).toEqual({
        source_path: 'live://live-session-1',
        source_mtime: 0,
        source_size: 0,
      })
      // The live entry is still searchable through the same bigram index.
      expect(database.prepare('SELECT rowid FROM entry_fts WHERE entry_fts MATCH ?').all('"广告"')).toHaveLength(3)
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
