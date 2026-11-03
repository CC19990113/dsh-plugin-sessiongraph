import { describe, expect, it } from 'vitest'
import { zstdCompressSync } from 'node:zlib'
import { decompressSessionLog, parseSessionLog } from '../src/parse.ts'
import type { SessionParseLimits } from '../src/parse.ts'

/** Wide enough that the clipping tests have to opt in explicitly. */
const LIMITS: SessionParseLimits = { maxEntryChars: 4_000, toolCallChars: 2_000 }

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
    id: 'session-11111111-2222-3333-4444-555555555555',
    createdAt: 1_700_000_000_000,
    cwd: '/Users/admin/www/demo',
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
    ...overrides,
  }
}

/** One event line with a sequence number and timestamp. */
function event(type: string, seq: number, time: number, data: unknown): Record<string, unknown> {
  return { type, seq, time, data, surfaceOp: 'append' }
}

/** A user message carrying one text block from the given source. */
function userMessage(seq: number, time: number, text: string, kind = 'user'): Record<string, unknown> {
  return event('user/message', seq, time, {
    role: 'user',
    source: { kind },
    content: [{ type: 'text', text }],
  })
}

/** An assistant message carrying the given content blocks. */
function assistantMessage(seq: number, time: number, content: unknown[], turn = 1): Record<string, unknown> {
  return event('assistant/message', seq, time, {
    turn,
    step: 1,
    message: { role: 'assistant', content },
  })
}

/** A tool call event. */
function toolCall(seq: number, time: number, name: string, args: unknown, turn = 1): Record<string, unknown> {
  return event('tool/call', seq, time, { turn, step: 1, callId: `call-${seq}`, name, arguments: args })
}

describe('decompressSessionLog', () => {
  it('decodes every appended zstd frame, not just the first', () => {
    const buffer = log([header(), event('turn/start', 1, 1_700_000_000_100, { turn: 1 }), event('turn/end', 2, 1_700_000_000_200, { turn: 1 })])
    const text = decompressSessionLog(buffer).toString('utf8')
    expect(text.split('\n').filter(line => line !== '')).toHaveLength(3)
    expect(text).toContain('"type":"session"')
    expect(text).toContain('"type":"turn/start"')
    expect(text).toContain('"type":"turn/end"')
  })

  it('rejects bytes that are not a zstd stream', () => {
    expect(() => decompressSessionLog(Buffer.from('not a log'))).toThrow(/zstd/)
  })
})

describe('parseSessionLog', () => {
  it('indexes only human messages, visible assistant text, tool calls and the final title', () => {
    const parsed = parseSessionLog(
      log([
        header({ id: 'abcd-1234', cwd: '/repo', origin: 'subagent', parentSession: 'session-parent', agentPreset: 'researcher' }),
        event('turn/start', 3, 1_700_000_000_300, { turn: 1 }),
        userMessage(4, 1_700_000_000_400, '帮我看看广告 SDK'),
        // Injected context travels as user messages; none of it is conversation.
        userMessage(5, 1_700_000_000_500, '<runtime-context>noise</runtime-context>', 'runtime-context'),
        userMessage(6, 1_700_000_000_600, 'skill catalog noise', 'skill-catalog'),
        userMessage(7, 1_700_000_000_700, '从 subagent 来的消息', 'agent-message'),
        event('request/header', 8, 1_700_000_000_800, { header: { tools: [] } }),
        assistantMessage(9, 1_700_000_000_900, [
          { type: 'reasoning', text: 'thinking hard about nothing' },
          { type: 'text', text: '先看广告 SDK 的实现。' },
          { type: 'tool-call', name: 'bash', arguments: '{"command":"ls"}' },
        ]),
        toolCall(10, 1_700_000_001_000, 'bash', '{"command":"ls -la"}'),
        event('tool/result', 11, 1_700_000_001_100, { message: { content: [{ type: 'text', text: 'tool body noise' }] } }),
        event('session/title', 12, 1_700_000_001_200, { title: '工作区标题', source: { kind: 'fallback' } }),
        event('turn/end', 13, 1_700_000_001_300, { turn: 1 }),
        event('session/title', 14, 1_700_000_001_400, { title: '广告 SDK 排查', source: { kind: 'provider' } }),
      ]),
      'fallback-id',
      LIMITS,
    )

    expect(parsed.id).toBe('abcd-1234')
    expect(parsed.cwd).toBe('/repo')
    expect(parsed.origin).toBe('subagent')
    expect(parsed.parentSession).toBe('session-parent')
    expect(parsed.agentPreset).toBe('researcher')
    expect(parsed.createdAt).toBe(1_700_000_000_000)
    expect(parsed.lastAt).toBe(1_700_000_001_400)
    expect(parsed.turns).toBe(1)

    expect(parsed.entries.map(entry => entry.kind)).toEqual(['user', 'assistant', 'tool', 'title'])
    expect(parsed.entries.map(entry => entry.text)).toEqual([
      '帮我看看广告 SDK',
      '先看广告 SDK 的实现。',
      'bash {"command":"ls -la"}',
      '广告 SDK 排查',
    ])
    expect(parsed.title).toBe('广告 SDK 排查')
    expect(parsed.entries[0]).toMatchObject({ seq: 4, time: 1_700_000_000_400, kind: 'user', clipped: false })
    expect(parsed.entries[2]).toMatchObject({ seq: 10, turn: 1, kind: 'tool' })
    expect(parsed.entries[3]).toMatchObject({ seq: 14, turn: undefined, kind: 'title' })
  })

  it('keeps the last title even when an earlier one came first', () => {
    const parsed = parseSessionLog(
      log([
        header(),
        event('session/title', 2, 1_700_000_000_200, { title: '旧标题' }),
        event('session/title', 5, 1_700_000_000_900, { title: '新标题' }),
      ]),
      'fallback',
      LIMITS,
    )
    expect(parsed.title).toBe('新标题')
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.entries[0]).toMatchObject({ kind: 'title', text: '新标题' })
  })

  it('clips message text and tool calls to their separate caps', () => {
    const parsed = parseSessionLog(
      log([
        header(),
        userMessage(2, 1_700_000_000_200, 'x'.repeat(50)),
        toolCall(3, 1_700_000_000_300, 'bash', 'y'.repeat(50)),
      ]),
      'fallback',
      { maxEntryChars: 10, toolCallChars: 20 },
    )
    const [user, tool] = parsed.entries
    expect(user).toMatchObject({ kind: 'user', text: 'x'.repeat(10), clipped: true })
    expect(tool).toMatchObject({ kind: 'tool', clipped: true })
    expect(tool?.text).toHaveLength(20)
    expect(tool?.text.startsWith('bash ')).toBe(true)
  })

  it('skips a corrupt line without dropping the session around it', () => {
    const buffer = Buffer.concat([
      frame(header()),
      Buffer.from('{"type":"user/message","seq":2,"data":{"source":{"kind":"user"}\n'),
      frame(userMessage(3, 1_700_000_000_300, '坏行前后的消息')),
    ])
    const parsed = parseSessionLog(buffer, 'fallback', LIMITS)
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.entries[0]?.text).toBe('坏行前后的消息')
  })

  it('falls back to the directory id and the first event time when the header is missing', () => {
    const parsed = parseSessionLog(
      log([userMessage(1, 1_700_000_000_500, '无头日志')]),
      '037ad8fc-29b8-4a69-9a02-e75f9cc8fb45',
      LIMITS,
    )
    expect(parsed.id).toBe('037ad8fc-29b8-4a69-9a02-e75f9cc8fb45')
    expect(parsed.cwd).toBe('')
    expect(parsed.createdAt).toBe(1_700_000_000_500)
    expect(parsed.lastAt).toBe(1_700_000_000_500)
    expect(parsed.entries).toHaveLength(1)
  })

  it('drops empty assistant text blocks and non-text user blocks', () => {
    const parsed = parseSessionLog(
      log([
        header(),
        event('user/message', 2, 1_700_000_000_200, {
          source: { kind: 'user' },
          content: [{ type: 'image', url: 'file:///x.png' }],
        }),
        assistantMessage(3, 1_700_000_000_300, [
          { type: 'text', text: '   ' },
          { type: 'reasoning', text: 'hidden' },
        ]),
      ]),
      'fallback',
      LIMITS,
    )
    expect(parsed.entries).toEqual([])
    expect(parsed.title).toBeUndefined()
  })

  it('joins the text blocks of one message and records its turn', () => {
    const parsed = parseSessionLog(
      log([
        header(),
        event('user/message', 2, 1_700_000_000_200, {
          turn: 3,
          source: { kind: 'user' },
          content: [
            { type: 'text', text: '第一段' },
            { type: 'text', text: '第二段' },
          ],
        }),
      ]),
      'fallback',
      LIMITS,
    )
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.entries[0]).toMatchObject({ kind: 'user', text: '第一段\n第二段', turn: 3 })
  })
})
