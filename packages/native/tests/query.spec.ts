import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  event,
  search,
  session,
  status,
  timeline,
  trace,
  workspaces,
} from 'dsh-plugin-sessiongraph-sqlite'
import type { SessiongraphRequest } from 'dsh-plugin-sessiongraph-service'
import type { NativeQueryRequest, NativeQueryResponse } from '../src/index.ts'
import { loadNative, query as queryKernel } from '../src/index.ts'

/**
 * The query kernel is as optional as the index one: a checkout without a built `.node`, or a binary
 * built before the `query` export, skips these cases rather than failing. Every assertion compares the
 * native answer with the TypeScript store's own result for the same request — the native engine is an
 * accelerator, never a second source of truth.
 */
const kernel = loadNative()
const canQuery = typeof kernel?.query === 'function'

let work: string
let sessionsRoot: string
let indexRoot: string
let indexPath: string

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'sessiongraph-query-'))
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
  return { type: 'session', version: 4, id, createdAt: 1_700_000_000_000, cwd }
}

/** Write one session log as appended zstd frames, the way the harness does. */
async function writeSession(
  workspaceDir: string,
  sessionDir: string,
  records: readonly unknown[],
): Promise<void> {
  const directory = join(sessionsRoot, workspaceDir, sessionDir)
  await mkdir(directory, { recursive: true })
  const frames = records.map(record => zstdCompressSync(Buffer.from(`${JSON.stringify(record)}\n`)))
  await writeFile(join(directory, 'session.v4.jsonl.zstd'), Buffer.concat(frames))
}

/** Build one index through the native index kernel, so both engines read the same file. */
async function seedFixture(): Promise<void> {
  await writeSession('--Users-admin-www-demo--', 'aaaa1111-1111-4111-8111-111111111111', [
    header('aaaa1111-1111-4111-8111-111111111111', '/Users/admin/www/demo'),
    { type: 'user/message', seq: 0, time: 1_700_000_000_100, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我今天在改广告SDK' }] } },
    { type: 'turn/start', seq: 1, time: 1_700_000_000_150, data: { turn: 1 } },
    { type: 'assistant/message', seq: 2, time: 1_700_000_000_200, data: { turn: 1, message: { content: [{ type: 'text', text: '好的，我们看 codegraph_index 的实现' }, { type: 'reasoning', text: 'hidden' }] } } },
    { type: 'tool/call', seq: 3, time: 1_700_000_000_300, data: { name: 'read', arguments: { path: '/tmp/x' }, turn: 1 } },
    { type: 'session/title', seq: 4, time: 1_700_000_000_400, data: { title: '广告 SDK 调试' } },
  ])
  await writeSession('--Users-admin-www-other--', 'bbbb2222-2222-4222-8222-222222222222', [
    header('bbbb2222-2222-4222-8222-222222222222', '/Users/admin/www/other'),
    { type: 'user/message', seq: 5, time: 1_700_000_000_500, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '广告的第二个会话，会话' }] } },
  ])
  // Two sessions sharing one prefix, for the ambiguity error path.
  await writeSession('--Users-admin-www-demo--', 'dup-alpha-one', [
    header('dup-alpha-one', '/Users/admin/www/demo'),
    { type: 'user/message', seq: 1, time: 1_700_000_000_600, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '重复前缀甲' }] } },
  ])
  await writeSession('--Users-admin-www-demo--', 'dup-alpha-two', [
    header('dup-alpha-two', '/Users/admin/www/demo'),
    { type: 'user/message', seq: 1, time: 1_700_000_000_700, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '重复前缀乙' }] } },
  ])
  const report = await kernel!.indexSessions({ sessionsRoot, indexPath })
  expect(report.sessions).toBe(4)
}

/** Open the index the way the TypeScript store does. */
function openIndex(): DatabaseSync {
  return new DatabaseSync(indexPath, { readOnly: true })
}

/**
 * Translate a seam request into the kernel's flat request, exactly as `native-query.ts` does.
 *
 * Kept in the test rather than imported so the test asserts the wire shape the store advertises
 * (snake_case fields), not whatever helper the store happens to use today.
 * @param request - the seam request.
 * @returns the kernel request.
 */
function nativeRequest(request: SessiongraphRequest): NativeQueryRequest {
  const base: NativeQueryRequest = { index_root: indexRoot, operation: request.operation }
  switch (request.operation) {
    case 'search':
      return {
        ...base,
        query: request.query,
        ...(request.sessionId === undefined ? {} : { session_id: request.sessionId }),
        ...(request.workspace === undefined ? {} : { workspace: request.workspace }),
        ...(request.after === undefined ? {} : { since: request.after }),
        ...(request.before === undefined ? {} : { until: request.before }),
        ...(request.kinds === undefined ? {} : { kinds: [...request.kinds] }),
        dedupe_by_session: request.dedupeBySession !== false,
        limit: request.limit,
        offset: request.offset ?? 0,
      }
    case 'session':
      return { ...base, session_id: request.sessionId, limit: request.limit, offset: request.offset ?? 0 }
    case 'event':
      return {
        ...base,
        session_id: request.sessionId,
        seq: request.seq,
        window_before: request.windowBefore ?? 0,
        window_after: request.windowAfter ?? 0,
      }
    case 'trace':
      return {
        ...base,
        session_id: request.sessionId,
        ...(request.seq === undefined ? {} : { seq: request.seq }),
        ...(request.depth === undefined ? {} : { depth: request.depth }),
      }
    case 'timeline':
      return {
        ...base,
        ...(request.workspace === undefined ? {} : { workspace: request.workspace }),
        ...(request.after === undefined ? {} : { since: request.after }),
        ...(request.before === undefined ? {} : { until: request.before }),
        limit: request.limit,
      }
    case 'workspaces':
      return { ...base, limit: request.limit }
    case 'status':
      return base
  }
}

/** Answer one request natively; fails the test on `ok: false`. */
async function nativeAnswer(request: SessiongraphRequest): Promise<unknown> {
  const response = (await kernel!.query!(nativeRequest(request))) as NativeQueryResponse
  expect(response.ok, `${response.error_code}: ${response.error_message}`).toBe(true)
  return JSON.parse(response.payload_json) as unknown
}

/** What the TypeScript store answers for the same request, normalized through JSON. */
function typescriptAnswer(request: SessiongraphRequest): unknown {
  const database = openIndex()
  try {
    switch (request.operation) {
      case 'search':
        return normalize(search(database, request, 240))
      case 'session':
        return normalize(session(database, request))
      case 'event':
        return normalize(event(database, request))
      case 'trace':
        return normalize(trace(database, request))
      case 'timeline':
        return normalize(timeline(database, request))
      case 'workspaces':
        return normalize(workspaces(database, request))
      case 'status':
        return normalize(status({ acquire: () => database }, indexRoot))
    }
  } finally {
    database.close()
  }
}

/** Drop `undefined` properties exactly like the JSON payload does. */
function normalize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown
}

describe('native query kernel', () => {
  it.skipIf(!canQuery)('is exposed by the same loader as the indexer', () => {
    expect(typeof queryKernel).toBe('function')
    expect(queryKernel({ index_root: indexRoot, operation: 'status' })).toBeDefined()
  })

  it.skipIf(!canQuery)('answers search identically to the TypeScript store', async () => {
    await seedFixture()
    const request: SessiongraphRequest = { operation: 'search', indexRoot, query: '广告', limit: 5 }
    expect(await nativeAnswer(request)).toEqual(typescriptAnswer(request))

    // A latin token exercises the other half of the tokenizer, and `undefined` optional fields must
    // be absent rather than present-and-null on both sides.
    const latin: SessiongraphRequest = { operation: 'search', indexRoot, query: 'codegraph_index', limit: 5 }
    expect(await nativeAnswer(latin)).toEqual(typescriptAnswer(latin))

    // One hit per session is the default; turning it off pages every entry.
    const plain: SessiongraphRequest = { operation: 'search', indexRoot, query: '广告', limit: 10, dedupeBySession: false }
    expect(await nativeAnswer(plain)).toEqual(typescriptAnswer(plain))

    const filtered: SessiongraphRequest = {
      operation: 'search',
      indexRoot,
      query: '广告',
      limit: 10,
      kinds: ['tool'],
      workspace: '/Users/admin/www/demo',
    }
    expect(await nativeAnswer(filtered)).toEqual(typescriptAnswer(filtered))
  })

  it.skipIf(!canQuery)('answers session, event and trace identically to the TypeScript store', async () => {
    await seedFixture()
    const sessionRequest: SessiongraphRequest = {
      operation: 'session',
      indexRoot,
      sessionId: 'aaaa1111',
      limit: 3,
      offset: 1,
    }
    expect(await nativeAnswer(sessionRequest)).toEqual(typescriptAnswer(sessionRequest))

    const eventRequest: SessiongraphRequest = {
      operation: 'event',
      indexRoot,
      sessionId: 'aaaa1111',
      seq: 2,
      windowBefore: 1,
      windowAfter: 2,
    }
    expect(await nativeAnswer(eventRequest)).toEqual(typescriptAnswer(eventRequest))

    const traceSession: SessiongraphRequest = { operation: 'trace', indexRoot, sessionId: 'aaaa1111' }
    expect(await nativeAnswer(traceSession)).toEqual(typescriptAnswer(traceSession))

    const traceEvent: SessiongraphRequest = { operation: 'trace', indexRoot, sessionId: 'aaaa1111', seq: 2 }
    expect(await nativeAnswer(traceEvent)).toEqual(typescriptAnswer(traceEvent))
  })

  it.skipIf(!canQuery)('answers timeline, workspaces and status identically to the TypeScript store', async () => {
    await seedFixture()
    const timelineRequest: SessiongraphRequest = { operation: 'timeline', indexRoot, limit: 3 }
    expect(await nativeAnswer(timelineRequest)).toEqual(typescriptAnswer(timelineRequest))

    const workspacesRequest: SessiongraphRequest = { operation: 'workspaces', indexRoot, limit: 5 }
    expect(await nativeAnswer(workspacesRequest)).toEqual(typescriptAnswer(workspacesRequest))

    const statusRequest: SessiongraphRequest = { operation: 'status', indexRoot }
    expect(await nativeAnswer(statusRequest)).toEqual(typescriptAnswer(statusRequest))
  })

  it.skipIf(!canQuery)('reports an ambiguous prefix as a typed failure instead of guessing', async () => {
    await seedFixture()
    const ambiguous = (await kernel!.query!({
      index_root: indexRoot,
      operation: 'session',
      session_id: 'dup-alpha',
      limit: 5,
    })) as NativeQueryResponse
    expect(ambiguous.ok).toBe(false)
    expect(ambiguous.error_code).toBe('SESSIONGRAPH_NOT_FOUND')
    expect(ambiguous.error_message).toContain('ambiguous')

    // The search session filter calls the same situation a bad request.
    const filtered = (await kernel!.query!({
      index_root: indexRoot,
      operation: 'search',
      query: '广告',
      session_id: 'dup-alpha',
      limit: 5,
    })) as NativeQueryResponse
    expect(filtered.ok).toBe(false)
    expect(filtered.error_code).toBe('SESSIONGRAPH_INVALID_REQUEST')
  })

  it.skipIf(!canQuery)('answers status for a root with no index instead of failing', async () => {
    const emptyRoot = join(work, 'empty')
    const answer = (await kernel!.query!({ index_root: emptyRoot, operation: 'status' })) as NativeQueryResponse
    expect(answer.ok).toBe(true)
    const payload = JSON.parse(answer.payload_json) as Record<string, unknown>
    expect(payload['indexed']).toBe(false)
    expect(payload['sessions']).toBe(0)
  })
})
