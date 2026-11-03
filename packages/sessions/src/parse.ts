/**
 * Read one harness session log into the normalized shape the indexer writes.
 *
 * The log is a zstd-compressed JSONL file whose first line is a flat session header and whose later
 * lines are events. It is NOT one zstd stream: the harness appends one complete zstd frame per write,
 * so a real log is thousands of concatenated frames. `zstdDecompressSync` stops at the first frame's
 * end, which is why {@link decompressSessionLog} walks the frames itself.
 *
 * What is indexed is the readable conversation, not the transcript feed: a human's messages, the
 * model's visible text (never its reasoning), tool invocations (name and arguments, never results),
 * and the session's final title. Injected context — runtime/skill/time blocks, team and agent
 * messages, plugin notifications — arrives as `user/message` events too, so the `source.kind` check
 * is what keeps them out of the index; on a real machine those injections outnumber real human
 * messages by more than an order of magnitude.
 *
 * Parsing is tolerant per line: a truncated or corrupt line is skipped rather than failing the whole
 * session, because an interrupted append must cost one event, not the conversation.
 * @module dsh-plugin-sessiongraph-sessions/parse
 */

import { zstdDecompressSync } from 'node:zlib'
import type { SessiongraphEntryKind } from 'dsh-plugin-sessiongraph-service'

/** zstd frame magic in numeric form, as read by `Buffer.readUInt32LE`. */
const ZSTD_FRAME_MAGIC = 0xfd2fb528

/** The same magic as bytes, for the fallback scanner. */
const ZSTD_MAGIC_BYTES = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Mask and value identifying a zstd skippable frame (0x184D2A50 … 0x184D2A5F). */
const ZSTD_SKIPPABLE_MASK = 0xfffffff0
const ZSTD_SKIPPABLE_MAGIC = 0x184d2a50

/** Frame-content-size field widths in bytes, indexed by the 2-bit flag minus one. */
const CONTENT_SIZE_BYTES: readonly number[] = [2, 4, 8]

/** Dictionary-id field widths in bytes, indexed by the 2-bit flag. */
const DICTIONARY_ID_BYTES: readonly number[] = [0, 1, 2, 4]

/** Byte widths of a zstd block header and of the checksum trailer. */
const BLOCK_HEADER_BYTES = 3
const CHECKSUM_BYTES = 4

/** Bounds applied while normalizing one session's entries. */
export interface SessionParseLimits {
  /** Longest message text stored whole; longer text is clipped. */
  readonly maxEntryChars: number
  /** Longest tool invocation text (name plus arguments) stored whole. */
  readonly toolCallChars: number
}

/** One searchable entry extracted from a session log. */
export interface ParsedEntry {
  /** Event sequence number inside the session. */
  readonly seq: number
  /** Event timestamp, epoch milliseconds. */
  readonly time: number
  /** Turn the entry belongs to, when the event records one. */
  readonly turn: number | undefined
  /** What the entry is. */
  readonly kind: SessiongraphEntryKind
  /** Entry text, already bounded by the parse limits. */
  readonly text: string
  /** True when the stored text is a clipped prefix. */
  readonly clipped: boolean
}

/** One session log, normalized for the index. */
export interface ParsedSession {
  /** Session id exactly as the header records it (`session-…` or bare uuid, never rewritten). */
  readonly id: string
  /** Working directory the session ran in. */
  readonly cwd: string
  /** Epoch milliseconds of the session's first event. */
  readonly createdAt: number
  /** Epoch milliseconds of the session's last event. */
  readonly lastAt: number
  /** Final session title, when the log records one. */
  readonly title: string | undefined
  /** Parent session id when this session was delegated from another. */
  readonly parentSession: string | undefined
  /** Session origin label (`user`, `subagent`, …), when recorded. */
  readonly origin: string | undefined
  /** Agent preset the session ran under, when recorded. */
  readonly agentPreset: string | undefined
  /** Number of turns the session contains. */
  readonly turns: number
  /** Searchable entries in chronological order. */
  readonly entries: ParsedEntry[]
}

/** A parsed JSON object, before field-by-field validation. */
type JsonRecord = Record<string, unknown>

/**
 * Decompress a session log, one zstd frame at a time.
 *
 * Node's `zstdDecompressSync` decodes the first frame of its input and stops, so a log written by
 * repeated appends must be split into frames first. The frame structure is parsed exactly (RFC 8878
 * header and block headers), which is why a magic-byte sequence inside a compressed block cannot
 * split a frame incorrectly; the magic scan remains as a fallback for a frame layout this parser
 * cannot describe.
 * @param buffer - the raw log file contents.
 * @returns the concatenated decompressed bytes of every frame.
 */
export function decompressSessionLog(buffer: Buffer): Buffer {
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === ZSTD_FRAME_MAGIC) {
    try {
      return decompressByWalkingFrames(buffer)
    } catch {
      // Fall through: the magic scan understands a few layouts the walker refuses, and a readable
      // index is worth more than a stricter parser.
    }
  }
  return decompressByMagic(buffer)
}

/**
 * Walk every zstd frame in `buffer` and decompress each one.
 * @param buffer - the raw log file contents, starting at a frame boundary.
 * @returns the concatenated decompressed bytes.
 */
function decompressByWalkingFrames(buffer: Buffer): Buffer {
  const parts: Buffer[] = []
  let at = 0
  while (at < buffer.length) {
    const magic = buffer.readUInt32LE(at)
    const end = frameEnd(buffer, at)
    if (end <= at) throw new Error(`zstd frame at byte ${at} does not advance`)
    if ((magic & ZSTD_SKIPPABLE_MASK) !== ZSTD_SKIPPABLE_MAGIC) parts.push(zstdDecompressSync(buffer.subarray(at, end)))
    at = end
  }
  return Buffer.concat(parts)
}

/**
 * Decompress by scanning for frame magics and decoding each slice.
 * @param buffer - the raw log file contents.
 * @returns the concatenated decompressed bytes.
 */
function decompressByMagic(buffer: Buffer): Buffer {
  const offsets: number[] = []
  let at = buffer.indexOf(ZSTD_MAGIC_BYTES)
  while (at !== -1) {
    offsets.push(at)
    at = buffer.indexOf(ZSTD_MAGIC_BYTES, at + ZSTD_MAGIC_BYTES.length)
  }
  if (offsets.length === 0) throw new Error('session log is not a zstd stream')
  const parts: Buffer[] = []
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index] as number
    const end = index + 1 < offsets.length ? (offsets[index + 1] as number) : buffer.length
    parts.push(zstdDecompressSync(buffer.subarray(start, end)))
  }
  return Buffer.concat(parts)
}

/**
 * Compute where the zstd frame beginning at `start` ends, from its header and block headers alone.
 * @param buffer - the raw log file contents.
 * @param start - byte offset of the frame magic.
 * @returns the exclusive end offset of the frame.
 */
function frameEnd(buffer: Buffer, start: number): number {
  const magic = buffer.readUInt32LE(start)
  if ((magic & ZSTD_SKIPPABLE_MASK) === ZSTD_SKIPPABLE_MAGIC) {
    return start + 8 + buffer.readUInt32LE(start + 4)
  }
  if (magic !== ZSTD_FRAME_MAGIC) throw new Error(`unexpected zstd magic at byte ${start}`)

  let at = start + 4
  const descriptor = readUInt8(buffer, at)
  at += 1
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = ((descriptor >>> 5) & 1) === 1
  const checksum = ((descriptor >>> 2) & 1) === 1
  const dictionaryFlag = descriptor & 0x03

  if (!singleSegment) at += 1
  at += DICTIONARY_ID_BYTES[dictionaryFlag] as number
  at += contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (CONTENT_SIZE_BYTES[contentSizeFlag - 1] as number)

  for (;;) {
    const header = readUIntLE(buffer, at, BLOCK_HEADER_BYTES)
    at += BLOCK_HEADER_BYTES
    const lastBlock = (header & 0x01) === 1
    const blockType = (header >>> 1) & 0x03
    const blockSize = header >>> 3
    if (blockType === 0 || blockType === 2) at += blockSize
    else if (blockType === 1) at += 1
    else throw new Error('reserved zstd block type')
    if (lastBlock) break
  }
  if (checksum) at += CHECKSUM_BYTES
  if (at > buffer.length) throw new Error('truncated zstd frame')
  return at
}

/**
 * Parse one session log.
 * @param buffer - the raw log file contents.
 * @param fallbackId - id to use when the header is missing or has none (the session directory name).
 * @param limits - bounds applied to stored entry text.
 * @returns the normalized session.
 */
export function parseSessionLog(buffer: Buffer, fallbackId: string, limits: SessionParseLimits): ParsedSession {
  return parseSessionLines(decompressSessionLog(buffer).toString('utf8').split('\n'), fallbackId, limits)
}

/**
 * Parse an already-split JSONL log, keeping the harness's first-line header convention.
 * @param lines - the decompressed log split on newline characters.
 * @param fallbackId - id to use when the header is missing or has none.
 * @param limits - bounds applied to stored entry text.
 * @returns the normalized session.
 */
export function parseSessionLines(lines: readonly string[], fallbackId: string, limits: SessionParseLimits): ParsedSession {
  const firstLine = firstNonEmptyLine(lines)
  let header: JsonRecord | undefined
  let start = 0
  if (firstLine !== undefined) {
    const record = parseRecord(lines[firstLine] as string)
    if (record?.type === 'session') {
      header = record
      start = firstLine + 1
    } else {
      start = firstLine
    }
  }
  const records: (JsonRecord | undefined)[] = []
  for (let index = start; index < lines.length; index += 1) {
    const line = (lines[index] as string).trim()
    records.push(line === '' ? undefined : parseRecord(line))
  }
  return normalizeSession(header, records, fallbackId, limits)
}

/**
 * Parse a session the host already holds in memory.
 *
 * The live view carries the header and the raw events as two values, which is the same information a
 * log's first line and remaining lines carry. Both paths normalize through {@link normalizeSession},
 * so a live session and its later on-disk copy cannot disagree about what is searchable.
 * @param header - the session header object, as the host reports it.
 * @param events - raw event objects, shaped like the JSONL lines that follow the header.
 * @param fallbackId - id to use when the header has none.
 * @param limits - bounds applied to stored entry text.
 * @returns the normalized session.
 */
export function parseSessionEvents(
  header: unknown,
  events: readonly unknown[],
  fallbackId: string,
  limits: SessionParseLimits,
): ParsedSession {
  return normalizeSession(asRecord(header), events.map(event => asRecord(event)), fallbackId, limits)
}

/**
 * Normalize a session header and its event stream into the shape the index writes.
 * @param header - the parsed session header, or undefined when the log carries none.
 * @param records - parsed events, where `undefined` stands for a line that failed to parse and is
 *   skipped without failing the session.
 * @param fallbackId - id to use when the header has none.
 * @param limits - bounds applied to stored entry text.
 * @returns the normalized session.
 */
function normalizeSession(
  header: JsonRecord | undefined,
  records: readonly (JsonRecord | undefined)[],
  fallbackId: string,
  limits: SessionParseLimits,
): ParsedSession {
  const id = stringField(header, 'id') ?? fallbackId
  let createdAt = numberField(header, 'createdAt') ?? 0
  const parentSession = stringField(header, 'parentSession')
  const origin = stringField(header, 'origin')
  const agentPreset = stringField(header, 'agentPreset')
  const headerCwd = stringField(header, 'cwd') ?? ''

  const entries: ParsedEntry[] = []
  let title: string | undefined
  let titleSeq = 0
  let titleTime = 0
  let firstEventTime: number | undefined
  let lastAt = createdAt
  let turns = 0

  for (const record of records) {
    if (record === undefined) continue

    const seq = numberField(record, 'seq') ?? 0
    const time = numberField(record, 'time')
    if (time !== undefined) {
      firstEventTime ??= time
      if (time > lastAt) lastAt = time
    }
    const eventTime = time ?? lastAt
    const data = asRecord(record.data)

    switch (record.type) {
      case 'turn/start':
        turns += 1
        break
      case 'session/title': {
        const next = stringField(data, 'title')
        if (next !== undefined && next.trim() !== '') {
          title = next
          titleSeq = seq
          titleTime = eventTime
        }
        break
      }
      case 'user/message': {
        // Injected context travels as user messages too; only a human's own input is indexed.
        if (stringField(asRecord(data?.source), 'kind') !== 'user') break
        const text = textBlocks(data?.content)
        if (text !== '') pushEntry(entries, 'user', text, seq, eventTime, numberField(data, 'turn'), limits.maxEntryChars)
        break
      }
      case 'assistant/message': {
        // One entry per visible text block: a reasoning block and a tool-call block are not prose.
        const message = asRecord(data?.message)
        const blocks = message?.content
        if (!Array.isArray(blocks)) break
        for (const block of blocks) {
          const record = asRecord(block)
          if (stringField(record, 'type') !== 'text') continue
          const text = stringField(record, 'text')
          if (text === undefined || text.trim() === '') continue
          pushEntry(entries, 'assistant', text, seq, eventTime, numberField(data, 'turn'), limits.maxEntryChars)
        }
        break
      }
      case 'tool/call': {
        const name = stringField(data, 'name') ?? ''
        const args = argumentText(data?.arguments)
        const text = args === '' ? name : `${name} ${args}`
        if (text.trim() === '') break
        pushEntry(entries, 'tool', text, seq, eventTime, numberField(data, 'turn'), limits.toolCallChars)
        break
      }
      default:
        break
    }
  }

  if (createdAt === 0 && firstEventTime !== undefined) createdAt = firstEventTime
  if (lastAt < createdAt) lastAt = createdAt
  if (title !== undefined) {
    const clipped = clipText(title, limits.maxEntryChars)
    entries.push({ seq: titleSeq, time: titleTime, turn: undefined, kind: 'title', text: clipped.text, clipped: clipped.clipped })
  }

  return {
    id,
    cwd: headerCwd,
    createdAt,
    lastAt,
    title,
    parentSession,
    origin,
    agentPreset,
    turns,
    entries,
  }
}

/**
 * Append one bounded entry, unless its text is blank.
 * @param entries - destination list.
 * @param kind - entry kind.
 * @param text - raw entry text.
 * @param seq - event sequence number.
 * @param time - event timestamp.
 * @param turn - turn number, when known.
 * @param maxChars - longest text stored whole.
 */
function pushEntry(
  entries: ParsedEntry[],
  kind: SessiongraphEntryKind,
  text: string,
  seq: number,
  time: number,
  turn: number | undefined,
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
 * Concatenate the text blocks of a message's content array.
 * @param content - the event's `content` value.
 * @returns the joined text, or an empty string when there is none.
 */
function textBlocks(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (stringField(record, 'type') !== 'text') continue
    const text = stringField(record, 'text')
    if (text !== undefined && text !== '') parts.push(text)
  }
  return parts.join('\n')
}

/**
 * Render a tool call's arguments for indexing.
 * @param value - the event's `arguments` value, normally a JSON string.
 * @returns the arguments text, or an empty string when absent.
 */
function argumentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

/**
 * Index of the first non-blank line.
 * @param lines - split log lines.
 * @returns the index, or undefined for an empty log.
 */
function firstNonEmptyLine(lines: readonly string[]): number | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    if ((lines[index] as string).trim() !== '') return index
  }
  return undefined
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
 * @returns the string, or undefined when the field is absent or not a string.
 */
function stringField(record: JsonRecord | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Read a finite number field from a record.
 * @param record - the record, possibly absent.
 * @param key - field name.
 * @returns the number, or undefined when the field is absent or not a finite number.
 */
function numberField(record: JsonRecord | undefined, key: string): number | undefined {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Read one byte, failing with a readable message at a truncated frame.
 * @param buffer - the raw log file contents.
 * @param at - byte offset.
 * @returns the byte value.
 */
function readUInt8(buffer: Buffer, at: number): number {
  if (at + 1 > buffer.length) throw new Error('truncated zstd frame header')
  return buffer.readUInt8(at)
}

/**
 * Read an unsigned little-endian integer of 1–6 bytes.
 * @param buffer - the raw log file contents.
 * @param at - byte offset.
 * @param width - field width in bytes.
 * @returns the value.
 */
function readUIntLE(buffer: Buffer, at: number, width: number): number {
  if (at + width > buffer.length) throw new Error('truncated zstd frame body')
  return buffer.readUIntLE(at, width)
}
