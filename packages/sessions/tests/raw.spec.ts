import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { foldRawSurface, isLiveSource, parseRawEvents, rawEventWindow, readRawEvents, traceRawEvent } from '../src/raw.ts'
import type { RawSessionEvent, RawSessionLog } from '../src/raw.ts'

/** Temp directories this file created, removed after each test. */
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** A temp directory that will be cleaned up. */
async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sessiongraph-raw-'))
  roots.push(root)
  return root
}

/** Compress one log line as its own frame, exactly how the harness appends them. */
function frame(record: unknown): Buffer {
  return zstdCompressSync(Buffer.from(`${JSON.stringify(record)}\n`))
}

/** Build a multi-frame log from records, each in a frame of its own. */
function log(records: readonly unknown[]): Buffer {
  return Buffer.concat(records.map(frame))
}

/** A session header in the shape the harness writes it (flat, no `data`). */
function header(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'session',
    version: 4,
    id: 'session-raw-0001',
    createdAt: 1_700_000_000_000,
    cwd: '/Users/admin/www/demo',
    ...overrides,
  }
}

/** One event carrying `surfaceOp: 'append'`. */
function event(type: string, seq: number, time: number, data: unknown): Record<string, unknown> {
  return { type, seq, time, data, surfaceOp: 'append' }
}

/** Write a log to a temp directory and return its path. */
async function logFile(root: string, records: readonly unknown[]): Promise<string> {
  const path = join(root, 'session.v4.jsonl.zstd')
  await writeFile(path, log(records))
  return path
}

describe('readRawEvents', () => {
  it('reads every appended zstd frame and keeps the log header apart from the events', async () => {
    const root = await scratch()
    const path = await logFile(root, [
      header(),
      event('turn/start', 1, 1_700_000_000_100, { turn: 1 }),
      event('user/message', 2, 1_700_000_000_200, { content: [{ type: 'text', text: '你好' }] }),
    ])
    const parsed = readRawEvents(path)
    expect(parsed?.sourcePath).toBe(path)
    expect(parsed?.header).toMatchObject({ type: 'session', id: 'session-raw-0001' })
    expect(parsed?.events.map(entry => entry.seq)).toEqual([1, 2])
    expect(parsed?.events[1]).toMatchObject({ type: 'user/message', time: 1_700_000_000_200 })
  })

  it('returns undefined for a live session instead of reading a log that does not exist', () => {
    expect(isLiveSource('live://session-abc')).toBe(true)
    expect(readRawEvents('live://session-abc')).toBeUndefined()
    expect(isLiveSource('/sessions/session-abc/session.v4.jsonl.zstd')).toBe(false)
  })

  it('keeps the payload unabridged, unlike the indexer which clips entries', async () => {
    const root = await scratch()
    const body = 'x'.repeat(20_000)
    const path = await logFile(root, [header(), event('tool/result', 1, 1_700_000_000_100, { text: body })])
    const parsed = readRawEvents(path)
    expect(parsed?.events[0]?.data).toEqual({ text: body })
    expect((parsed?.events[0]?.data as { text: string }).text).toHaveLength(20_000)
  })

  it('keeps only the requested sequence numbers when a filter is given', async () => {
    const root = await scratch()
    const path = await logFile(root, [
      header(),
      event('user/message', 1, 1_000, { text: 'a' }),
      event('assistant/message', 2, 2_000, { text: 'b' }),
      event('tool/call', 3, 3_000, { text: 'c' }),
    ])
    const parsed = readRawEvents(path, { seqs: [3, 1] })
    expect(parsed?.events.map(entry => entry.seq)).toEqual([1, 3])
  })

  it('skips a corrupt line without dropping the events around it', async () => {
    const root = await scratch()
    const path = join(root, 'broken.jsonl.zstd')
    await writeFile(
      path,
      Buffer.concat([
        frame(header()),
        Buffer.from('{"type":"user/message","seq":2,"time":\n'),
        frame(event('user/message', 3, 3_000, { text: '幸存' })),
      ]),
    )
    const parsed = readRawEvents(path)
    expect(parsed?.events.map(entry => entry.seq)).toEqual([3])
  })

  it('throws when the source log does not exist, so the caller can report it', () => {
    expect(() => readRawEvents('/no/such/session.v4.jsonl.zstd')).toThrow()
  })

  it('carries the surface marker and cited sources of an event', async () => {
    const root = await scratch()
    const path = await logFile(root, [
      header(),
      event('tool/call', 1, 1_000, { name: 'bash' }),
      { type: 'tool/result', seq: 2, time: 2_000, data: { text: 'ok' }, surfaceOp: 'append', sourceEventSeqs: [1] },
      { type: 'user/message', seq: 3, time: 3_000, data: { text: 'edited' }, surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 } },
    ])
    const parsed = readRawEvents(path)
    expect(parsed?.events[1]?.sourceEventSeqs).toEqual([1])
    expect(parsed?.events[2]?.surfaceOp).toEqual({ op: 'replace', startSeq: 3, endSeq: 3 })
  })
})

describe('rawEventWindow', () => {
  const parsed: RawSessionLog = parseRawEvents(
    Buffer.concat([
      frame(header()),
      frame(event('user/message', 1, 1_000, {})),
      frame(event('assistant/message', 2, 2_000, {})),
      frame(event('tool/call', 3, 3_000, {})),
      frame(event('tool/result', 4, 4_000, {})),
    ]),
    '/synthetic/log',
  )

  it('returns the neighbours immediately around the target', () => {
    const window = rawEventWindow(parsed, 3, 2, 1)
    expect(window?.event.seq).toBe(3)
    expect(window?.before.map(entry => entry.seq)).toEqual([1, 2])
    expect(window?.after.map(entry => entry.seq)).toEqual([4])
  })

  it('clamps at both ends of the log instead of running off it', () => {
    const first = rawEventWindow(parsed, 1, 5, 1)
    expect(first?.before).toEqual([])
    expect(first?.after.map(entry => entry.seq)).toEqual([2])

    const last = rawEventWindow(parsed, 4, 1, 5)
    expect(last?.before.map(entry => entry.seq)).toEqual([3])
    expect(last?.after).toEqual([])
  })

  it('ignores a negative or fractional window bound', () => {
    const window = rawEventWindow(parsed, 2, -3, 1.9)
    expect(window?.before).toEqual([])
    expect(window?.after.map(entry => entry.seq)).toEqual([3])
  })

  it('reports an unknown target as absent', () => {
    expect(rawEventWindow(parsed, 99, 1, 1)).toBeUndefined()
  })
})

describe('foldRawSurface', () => {
  /** Build events with only the fields the fold reads. */
  function events(specs: readonly { seq: number; surfaceOp?: unknown; sourceEventSeqs?: readonly number[] }[]): RawSessionEvent[] {
    return specs.map(spec => ({
      seq: spec.seq,
      time: spec.seq,
      type: 'user/message',
      data: undefined,
      ...(spec.surfaceOp === undefined ? {} : { surfaceOp: spec.surfaceOp }),
      ...(spec.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: spec.sourceEventSeqs }),
    }))
  }

  it('appends surface events and folds one range replacement', () => {
    const fold = foldRawSurface(
      events([
        { seq: 1, surfaceOp: 'append' },
        { seq: 2, surfaceOp: 'append' },
        { seq: 3, surfaceOp: 'append' },
        { seq: 4, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 3 } },
      ]),
    )
    expect(fold.current).toEqual([1, 4])
    expect(fold.replacedBy.get(2)).toBe(4)
    expect(fold.replacedBy.get(3)).toBe(4)
    expect(fold.shadowed.get(4)).toEqual([2, 3])
  })

  it('ignores events with no marker, and markers it cannot resolve', () => {
    const fold = foldRawSurface(
      events([
        // No `surfaceOp`: a log-only event (a chunk, a request header) is not part of the surface.
        { seq: 1 },
        { seq: 2, surfaceOp: 'append' },
        // A replacement naming an event the fold never put on the surface.
        { seq: 3, surfaceOp: { op: 'replace', startSeq: 9, endSeq: 9 } },
        // A marker shape this reader does not know.
        { seq: 4, surfaceOp: { op: 'highlight' } },
        // A range whose ends are out of order.
        { seq: 5, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 1 } },
      ]),
    )
    expect(fold.current).toEqual([2])
    expect(fold.shadowed.size).toBe(0)
  })
})

describe('traceRawEvent', () => {
  const parsed: RawSessionLog = parseRawEvents(
    Buffer.concat([
      frame(header()),
      frame(event('user/message', 1, 1_000, { text: 'original' })),
      frame(event('assistant/message', 2, 2_000, { text: 'answer' })),
      frame(event('tool/call', 3, 3_000, { name: 'bash' })),
      frame({ type: 'tool/result', seq: 4, time: 4_000, data: { text: 'ok' }, surfaceOp: 'append', sourceEventSeqs: [3] }),
      frame({
        type: 'user/message',
        seq: 5,
        time: 5_000,
        data: { text: 'edited' },
        surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 },
        sourceEventSeqs: [1],
      }),
    ]),
    '/synthetic/log',
  )

  it('follows the replacement chain outward from the target', () => {
    const traced = traceRawEvent(parsed, 1)
    expect(traced?.replacedBy).toEqual([5])
    expect(traced?.shadowedSeqs).toEqual([])
  })

  it('reports what a replacement shadowed and what it cited', () => {
    const traced = traceRawEvent(parsed, 5)
    expect(traced?.replacedBy).toEqual([])
    expect(traced?.shadowedSeqs).toEqual([1])
    expect(traced?.sourceEventSeqs).toEqual([1])
  })

  it('reports a cited source for an event that cites one', () => {
    const traced = traceRawEvent(parsed, 4)
    expect(traced?.sourceEventSeqs).toEqual([3])
    expect(traced?.replacedBy).toEqual([])
    expect(traced?.shadowedSeqs).toEqual([])
  })

  it('answers an unknown sequence number as absent', () => {
    expect(traceRawEvent(parsed, 99)).toBeUndefined()
  })
})
