import { describe, expect, it } from 'vitest'
import { zstdCompressSync } from 'node:zlib'
import { parseCodexLines, parseCodexRollout } from '../src/codex.ts'
import type { CodexParseOptions } from '../src/codex.ts'

/** Wide enough that the clipping tests have to opt in explicitly. */
const LIMITS: CodexParseOptions = { maxEntryChars: 4_000, toolCallChars: 2_000 }

/** Compress one rollout as a single zstd frame, the way Codex writes it. */
function rollout(records: readonly unknown[]): Buffer {
  return zstdCompressSync(Buffer.from(records.map(record => `${JSON.stringify(record)}\n`).join('')))
}

/** One envelope, in the shape Codex writes it. */
function envelope(type: string, ordinal: number, payload: unknown, timestamp = '2026-03-18T02:04:36.252Z'): Record<string, unknown> {
  return { timestamp, ordinal, type, payload }
}

/** The `session_meta` line every rollout starts with. */
function meta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return envelope('session_meta', 0, {
    session_id: '019cfeae-fac8-7663-a1d1-9c9eadfd6541',
    id: '019cfeae-fac8-7663-a1d1-9c9eadfd6541',
    timestamp: '2026-03-18T02:04:30.000Z',
    cwd: '/Users/admin/Downloads/hm-app',
    originator: 'Codex Desktop',
    cli_version: '0.115.0-alpha.27',
    model_provider: 'openai',
    ...overrides,
  })
}

/** One `turn_context` envelope, which is what starts a turn. */
function turn(ordinal: number, turnId: string, model = 'gpt-5.4'): Record<string, unknown> {
  return envelope('turn_context', ordinal, { turn_id: turnId, model, cwd: '/Users/admin/Downloads/hm-app' })
}

/** One `response_item` envelope. */
function item(ordinal: number, payload: unknown): Record<string, unknown> {
  return envelope('response_item', ordinal, payload)
}

/** A user-role message carrying the given text blocks. */
function userText(ordinal: number, ...texts: string[]): Record<string, unknown> {
  return item(ordinal, {
    type: 'message',
    role: 'user',
    content: texts.map(text => ({ type: 'input_text', text })),
  })
}

/** An assistant-role message carrying the given text blocks. */
function assistantText(ordinal: number, ...texts: string[]): Record<string, unknown> {
  return item(ordinal, {
    type: 'message',
    role: 'assistant',
    content: texts.map(text => ({ type: 'output_text', text })),
  })
}

describe('parseCodexRollout', () => {
  it('reads identity from session_meta and leaves the id as recorded', () => {
    const parsed = parseCodexRollout(rollout([meta()]), 'fallback', LIMITS)

    expect(parsed.id).toBe('019cfeae-fac8-7663-a1d1-9c9eadfd6541')
    expect(parsed.cwd).toBe('/Users/admin/Downloads/hm-app')
    expect(parsed.createdAt).toBe(Date.parse('2026-03-18T02:04:30.000Z'))
    expect(parsed.origin).toBe('Codex Desktop')
  })

  it('falls back to the caller-supplied id when the file has no session_meta', () => {
    const parsed = parseCodexRollout(rollout([userText(1, '你好')]), 'file-uuid', LIMITS)

    expect(parsed.id).toBe('file-uuid')
    expect(parsed.cwd).toBe('')
    // No header timestamp, so the session starts at its first event.
    expect(parsed.createdAt).toBe(Date.parse('2026-03-18T02:04:36.252Z'))
  })

  it('counts turns from turn_context and records the model as the agent preset', () => {
    const parsed = parseCodexRollout(
      rollout([
        meta(),
        turn(1, 'turn-a'),
        turn(2, 'turn-a'),
        turn(3, 'turn-b', 'gpt-5.4-mini'),
      ]),
      'fallback',
      LIMITS,
    )

    // Two distinct turn ids, even though three turn_context envelopes were written.
    expect(parsed.turns).toBe(2)
    expect(parsed.agentPreset).toBe('gpt-5.4')
  })

  it('indexes a human question and the model reply, and drops the developer role', () => {
    const parsed = parseCodexRollout(
      rollout([
        meta(),
        turn(1, 'turn-a'),
        item(2, { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>full sandbox rules' }] }),
        userText(3, '我要开发一个鸿蒙APP'),
        assistantText(4, '先说结论'),
        item(5, { type: 'reasoning', summary: [{ type: 'summary_text', text: 'private thinking' }] }),
        item(6, { type: 'function_call_output', call_id: 'call-1', output: 'tool body' }),
      ]),
      'fallback',
      LIMITS,
    )

    expect(parsed.entries.map(entry => [entry.kind, entry.text])).toEqual([
      ['user', '我要开发一个鸿蒙APP'],
      ['assistant', '先说结论'],
    ])
  })

  it('strips injected context blocks and keeps the question that followed one', () => {
    const parsed = parseCodexRollout(
      rollout([
        meta(),
        userText(1, '<environment_context>\n  <cwd>/Users/admin/www/x</cwd>\n</environment_context>', '顺便问下缓存怎么配'),
        userText(2, '<environment_context>\n  <cwd>/Users/admin/www/x</cwd>\n</environment_context>'),
        userText(3, '<user_instructions>回答用中文</user_instructions>', '<permissions instructions>rules</permissions instructions>'),
      ]),
      'fallback',
      LIMITS,
    )

    // A record that reduces to nothing is dropped; a record with a real question keeps it.
    expect(parsed.entries.map(entry => entry.text)).toEqual(['顺便问下缓存怎么配'])
  })

  it('indexes tool invocations by name plus arguments, input or query', () => {
    const parsed = parseCodexRollout(
      rollout([
        meta(),
        item(1, { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: 'c1' }),
        item(2, { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n', call_id: 'c2' }),
        item(3, { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'HarmonyOS 上架' } }),
        item(4, { type: 'function_call_output', call_id: 'c1', output: 'not indexed' }),
      ]),
      'fallback',
      LIMITS,
    )

    expect(parsed.entries.map(entry => [entry.kind, entry.text])).toEqual([
      ['tool', 'shell {"command":["ls"]}'],
      ['tool', 'apply_patch *** Begin Patch\n'],
      ['tool', 'web_search HarmonyOS 上架'],
    ])
  })

  it('joins every search query when the action has no single one', () => {
    const parsed = parseCodexRollout(
      rollout([
        meta(),
        item(1, { type: 'web_search_call', action: { type: 'search', queries: ['one', 'two'] } }),
      ]),
      'fallback',
      LIMITS,
    )

    expect(parsed.entries[0]?.text).toBe('web_search one two')
  })

  it('adds the thread name from the title map as a title entry', () => {
    const titles = new Map([['019cfeae-fac8-7663-a1d1-9c9eadfd6541', '鸿蒙上架准备']])
    const parsed = parseCodexRollout(rollout([meta(), userText(1, '开始吧')]), 'fallback', { ...LIMITS, titles })

    expect(parsed.title).toBe('鸿蒙上架准备')
    const titleEntry = parsed.entries.find(entry => entry.kind === 'title')
    expect(titleEntry?.text).toBe('鸿蒙上架准备')
  })

  it('leaves the title undefined when the map has no entry for this session', () => {
    const parsed = parseCodexRollout(rollout([meta()]), 'fallback', { ...LIMITS, titles: new Map() })

    expect(parsed.title).toBeUndefined()
    expect(parsed.entries.some(entry => entry.kind === 'title')).toBe(false)
  })

  it('skips a corrupt line without failing the conversation', () => {
    const bytes = Buffer.concat([
      rollout([meta(), userText(1, '第一句')]),
      Buffer.from('{not json\n'),
      rollout([userText(2, '第二句')]),
    ])

    const parsed = parseCodexRollout(bytes, 'fallback', LIMITS)

    expect(parsed.entries.map(entry => entry.text)).toEqual(['第一句', '第二句'])
  })

  it('clips a message at the configured cap and flags it', () => {
    const parsed = parseCodexRollout(rollout([meta(), userText(1, 'x'.repeat(50))]), 'fallback', {
      maxEntryChars: 10,
      toolCallChars: 5,
    })

    expect(parsed.entries[0]).toMatchObject({ text: 'x'.repeat(10), clipped: true })
  })

  it('takes the session span from the events when the header records no timestamp', () => {
    const parsed = parseCodexRollout(
      rollout([
        envelope('session_meta', 0, { session_id: 'no-time', cwd: '/w' }),
        envelope('response_item', 1, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a' }] }, '2026-03-18T01:00:00.000Z'),
        envelope('response_item', 2, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'b' }] }, '2026-03-18T03:00:00.000Z'),
      ]),
      'fallback',
      LIMITS,
    )

    expect(parsed.createdAt).toBe(Date.parse('2026-03-18T01:00:00.000Z'))
    expect(parsed.lastAt).toBe(Date.parse('2026-03-18T03:00:00.000Z'))
  })

  it('parses already-split lines, so a caller that read the file itself can reuse it', () => {
    const lines = [meta(), userText(1, '直接给行')].map(record => JSON.stringify(record))
    const parsed = parseCodexLines(lines, 'fallback', LIMITS)

    expect(parsed.entries.map(entry => entry.text)).toEqual(['直接给行'])
  })
})
