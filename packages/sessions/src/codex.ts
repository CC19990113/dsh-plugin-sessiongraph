/**
 * Read one OpenAI Codex rollout log into the same normalized shape the DSH parser produces.
 *
 * Codex keeps its conversations under `~/.codex` as zstd-compressed JSONL whose lines are *envelopes*
 * (`{ timestamp, ordinal, type, payload }`) rather than the flat events DSH writes. Three envelope
 * types carry everything searchable:
 *
 * - `session_meta` — one per file, the conversation's identity: `session_id`, `cwd`, `timestamp`,
 *   `originator`, `cli_version`.
 * - `turn_context` — one per turn, with a fresh `turn_id` and the model the turn ran on.
 * - `response_item` — the transcript: `message` (role `user` / `assistant` / `developer`),
 *   `function_call`, `custom_tool_call`, `web_search_call`, and the `reasoning` / `*_output` records
 *   an index deliberately never stores.
 *
 * What is indexed mirrors the DSH parser on purpose — the human's own text, the model's visible
 * reply, and tool invocations — so one search cannot rank the same question differently depending on
 * which harness recorded it. Two Codex-specific traps are load-bearing:
 *
 * - **`developer` role is not a human.** Codex injects its whole instruction set as a `developer`
 *   message on every turn; indexing it would make the system prompt the most-matching document in
 *   the corpus.
 * - **`user` role is not always a human either.** Codex sends the environment block
 *   (`<environment_context>…</environment_context>`, and sometimes `<user_instructions>…`,
 *   `<permissions instructions>…`) through the same `user` role. Measured on this machine, 251 of
 *   1678 user-role records carried nothing but injected context, so the tags are stripped and a
 *   record that reduces to nothing is dropped rather than indexed as an empty question.
 *
 * A rollout carries no title. Codex records thread names in `~/.codex/session_index.jsonl`, which the
 * indexer reads once per run and passes in; the parser stays a pure function of its bytes.
 * @module dsh-plugin-sessiongraph-sessions/codex
 */

import type { SessiongraphEntryKind } from 'dsh-plugin-sessiongraph-service'
import { decompressSessionLog } from './parse.ts'
import type { ParsedEntry, ParsedSession, SessionParseLimits } from './parse.ts'

/** A parsed JSON object, before field-by-field validation. */
type JsonRecord = Record<string, unknown>

/**
 * Injected-context blocks Codex ships through the `user` role.
 *
 * Stripped rather than skipped wholesale: a single record can legitimately carry an environment
 * block *and* the question that followed it, and dropping the whole record would lose the question.
 * The list is deliberately short and literal — a tag this file does not know stays in the text,
 * which is a better failure than deleting text that turned out to be the user's own.
 */
const INJECTED_BLOCKS: readonly RegExp[] = [
  /<environment_context>[\s\S]*?<\/environment_context>/g,
  /<user_instructions>[\s\S]*?<\/user_instructions>/g,
  /<permissions instructions>[\s\S]*?<\/permissions instructions>/g,
  /<turn_aborted>[\s\S]*?<\/turn_aborted>/g,
]

/** What a caller may supply beyond the shared parse limits. */
export interface CodexParseOptions extends SessionParseLimits {
  /**
   * Codex's thread-name table (`~/.codex/session_index.jsonl`), keyed by session id.
   *
   * The rollout log records the conversation but never what Codex shows in its sidebar, so the title
   * has to come from that second file. It is passed in rather than read here so the parser stays a
   * pure function of the bytes it is handed, and so one run reads the index once for every log.
   */
  readonly titles?: ReadonlyMap<string, string> | undefined
}

/**
 * Parse one Codex rollout log.
 * @param buffer - the raw `.jsonl.zst` file contents.
 * @param fallbackId - id to use when the file has no `session_meta` (the rollout filename's uuid).
 * @param options - bounds applied to stored entry text, plus an optional title.
 * @returns the normalized session.
 * @throws when the bytes are not a zstd JSONL stream. A corrupt *line* costs one record, never the
 *   conversation — the same tolerance the DSH parser applies to a truncated append.
 */
export function parseCodexRollout(buffer: Buffer, fallbackId: string, options: CodexParseOptions): ParsedSession {
  const text = decompressSessionLog(buffer).toString('utf8')
  return parseCodexLines(text.split('\n'), fallbackId, options)
}

/**
 * Parse already-split rollout lines.
 * @param lines - decompressed JSONL lines.
 * @param fallbackId - id to use when the file has no `session_meta`.
 * @param options - parse bounds and an optional title.
 * @returns the normalized session.
 */
export function parseCodexLines(lines: readonly string[], fallbackId: string, options: CodexParseOptions): ParsedSession {
  let meta: JsonRecord | undefined
  let model: string | undefined
  let turnSeq = 0
  let lastTurnId: string | undefined
  let lastAt = 0
  let firstAt: number | undefined
  const entries: ParsedEntry[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const record = parseRecord(trimmed)
    if (record === undefined) continue

    const time = timeField(record)
    if (time !== undefined) {
      // Earliest wins rather than first-seen: a rollout is normally monotonic, but the envelope on a
      // `session_meta` line carries its own `timestamp` that can precede the first real event, and a
      // session's start is the earliest instant any line names.
      if (firstAt === undefined || time < firstAt) firstAt = time
      if (time > lastAt) lastAt = time
    }
    const seq = numberField(record, 'ordinal') ?? 0
    const payload = asRecord(record['payload'])

    switch (record['type']) {
      case 'session_meta':
        meta = payload
        break
      case 'turn_context': {
        const turnId = stringField(payload, 'turn_id')
        if (turnId !== undefined && turnId !== lastTurnId) {
          turnSeq += 1
          lastTurnId = turnId
        }
        model ??= stringField(payload, 'model')
        break
      }
      case 'response_item':
        collectResponseItem(entries, payload, seq, time ?? lastAt, turnSeq, options)
        break
      default:
        // `event_msg` (token counts, task bookkeeping), `compacted` (a handoff summary another model
        // wrote) and anything a newer Codex adds are not the user's conversation.
        break
    }
  }

  const createdAt = meta === undefined ? (firstAt ?? 0) : (timeField(meta) ?? firstAt ?? 0)
  const id = stringField(meta, 'session_id') ?? fallbackId
  const titleText = options.titles?.get(id)?.trim()
  const title = titleText === undefined || titleText === '' ? undefined : titleText
  if (title !== undefined) {
    const clipped = clipText(title, options.maxEntryChars)
    entries.push({ seq: 0, time: lastAt, turn: undefined, kind: 'title', text: clipped.text, clipped: clipped.clipped })
  }

  return {
    id,
    cwd: stringField(meta, 'cwd') ?? '',
    createdAt,
    lastAt: Math.max(lastAt, createdAt),
    title,
    parentSession: undefined,
    // Codex records what launched it (`Codex Desktop`, `codex_cli_rs`) rather than a DSH-style
    // origin label; keeping the raw value is what lets a caller tell an IDE session from a CLI one.
    origin: stringField(meta, 'originator'),
    // Codex has no agent presets. The model each turn ran on is the closest equivalent and is what a
    // caller filtering by "which model was this conversation with" actually needs.
    agentPreset: model,
    turns: turnSeq,
    entries,
  }
}

/**
 * Lift one `response_item` into entries.
 * @param entries - destination list.
 * @param payload - the envelope's `payload` object.
 * @param seq - the envelope's ordinal.
 * @param time - epoch milliseconds of the envelope.
 * @param turn - the turn this record belongs to (0 before the first `turn_context`).
 * @param options - parse bounds.
 */
function collectResponseItem(
  entries: ParsedEntry[],
  payload: JsonRecord | undefined,
  seq: number,
  time: number,
  turn: number,
  options: CodexParseOptions,
): void {
  switch (payload?.['type']) {
    case 'message': {
      const role = stringField(payload, 'role')
      // See the module note: the instruction set and the environment block arrive as messages.
      if (role === 'developer') return
      const text = messageText(payload?.['content'])
      if (role === 'user') {
        const clean = stripInjected(text)
        if (clean === '') return
        pushEntry(entries, 'user', clean, seq, time, turn, options.maxEntryChars)
      } else if (role === 'assistant') {
        if (text.trim() === '') return
        pushEntry(entries, 'assistant', text, seq, time, turn, options.maxEntryChars)
      }
      return
    }
    case 'function_call': {
      const name = stringField(payload, 'name') ?? ''
      const text = callText(name, stringField(payload, 'arguments'))
      if (text !== '') pushEntry(entries, 'tool', text, seq, time, turn, options.toolCallChars)
      return
    }
    case 'custom_tool_call': {
      const name = stringField(payload, 'name') ?? ''
      // `custom_tool_call` carries its payload as `input` (a patch body, a shell script), not as JSON.
      const text = callText(name, stringField(payload, 'input'))
      if (text !== '') pushEntry(entries, 'tool', text, seq, time, turn, options.toolCallChars)
      return
    }
    case 'web_search_call': {
      const action = asRecord(payload?.['action'])
      const query = stringField(action, 'query') ?? stringList(action?.['queries']).join(' ')
      if (query.trim() === '') return
      pushEntry(entries, 'tool', `web_search ${query}`, seq, time, turn, options.toolCallChars)
      return
    }
    default:
      // `reasoning` and every `*_output` record: the model's private thinking and tool results, both
      // of which the DSH parser also excludes.
      return
  }
}

/**
 * Concatenate a Codex message's text blocks.
 *
 * Codex content blocks are typed `input_text` (what the user sent) and `output_text` (what the model
 * replied); a block of any other type — an image reference, a future addition — is skipped rather
 * than stringified.
 * @param content - the message's `content` value.
 * @returns the joined text, or an empty string when there is none.
 */
function messageText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    const type = stringField(record, 'type')
    if (type !== 'input_text' && type !== 'output_text') continue
    const text = stringField(record, 'text')
    if (text !== undefined && text !== '') parts.push(text)
  }
  return parts.join('\n')
}

/**
 * Render one tool invocation for indexing.
 * @param name - the tool's name.
 * @param argument - its arguments or input, when recorded.
 * @returns `name arguments`, or just the name.
 */
function callText(name: string, argument: string | undefined): string {
  if (argument === undefined || argument === '') return name
  return `${name} ${argument}`
}

/**
 * Remove the injected context blocks Codex ships through the `user` role.
 * @param text - the message's joined text.
 * @returns the remaining text, trimmed.
 */
function stripInjected(text: string): string {
  let clean = text
  for (const pattern of INJECTED_BLOCKS) clean = clean.replace(pattern, '')
  return clean.trim()
}

/**
 * Append one bounded entry, unless its text is blank.
 * @param entries - destination list.
 * @param kind - entry kind.
 * @param text - raw entry text.
 * @param seq - envelope ordinal.
 * @param time - envelope timestamp.
 * @param turn - turn number.
 * @param maxChars - longest text stored whole.
 */
function pushEntry(
  entries: ParsedEntry[],
  kind: SessiongraphEntryKind,
  text: string,
  seq: number,
  time: number,
  turn: number,
  maxChars: number,
): void {
  if (text.trim() === '') return
  const clipped = clipText(text, maxChars)
  entries.push({ seq, time, turn, kind, text: clipped.text, clipped: clipped.clipped })
}

/**
 * Bound one text to the configured character cap.
 * @param text - raw text.
 * @param maxChars - longest text kept whole.
 * @returns the stored text and whether it was clipped.
 */
function clipText(text: string, maxChars: number): { text: string; clipped: boolean } {
  if (text.length <= maxChars) return { text, clipped: false }
  return { text: text.slice(0, maxChars), clipped: true }
}

/**
 * Join a string array, ignoring non-string entries.
 * @param value - candidate array.
 * @returns the strings it held.
 */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/**
 * Parse one JSONL line into an object, tolerating a corrupt line.
 * @param line - one trimmed, non-empty line.
 * @returns the record, or undefined when the line is not a JSON object.
 */
function parseRecord(line: string): JsonRecord | undefined {
  try {
    const value: unknown = JSON.parse(line)
    return asRecord(value)
  } catch {
    return undefined
  }
}

/**
 * Narrow a value to a plain object.
 * @param value - candidate.
 * @returns the object, or undefined.
 */
function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRecord) : undefined
}

/**
 * Read a string field from a record.
 * @param record - the record, possibly absent.
 * @param key - field name.
 * @returns the string, or undefined.
 */
function stringField(record: JsonRecord | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Read a finite number field from a record.
 * @param record - the record, possibly absent.
 * @param key - field name.
 * @returns the number, or undefined.
 */
function numberField(record: JsonRecord | undefined, key: string): number | undefined {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Read a record's ISO-8601 `timestamp` as epoch milliseconds.
 * @param record - the record, possibly absent.
 * @returns epoch milliseconds, or undefined when absent or unparseable.
 */
function timeField(record: JsonRecord | undefined): number | undefined {
  const raw = stringField(record, 'timestamp')
  if (raw === undefined) return undefined
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}
