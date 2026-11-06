/**
 * Read one session log's events exactly as the harness wrote them — no clipping, no normalization.
 *
 * {@link parseSessionLog} answers a different question: it reduces a log to the few searchable entries
 * an index can hold, bounded by per-entry character caps. This module answers "what did the event
 * actually say", which is what `sessiongraph`'s `event` and `trace` operations need: a `tool/result`
 * payload is frequently tens of kilobytes, and a caller asking to read one event wants the bytes, not
 * a prefix of them.
 *
 * Reading is deliberately independent of the FTS index: the index stores *semantic text* (clipped,
 * and only for four entry kinds), while an event read must return the original log line, including
 * events the index never stores at all (`step/start`, `assistant/chunk`, …).
 *
 * Two structures beyond the raw line matter for tracing, and both are recorded by the harness on the
 * event object itself:
 *
 * - `surfaceOp` — how the event enters the *model surface*. `'append'` adds it; `{ op: 'replace',
 *   startSeq, endSeq }` replaces the contiguous run of surface nodes between two previous events, and
 *   is how the harness shadows an earlier message without rewriting history. {@link foldRawSurface}
 *   replays just enough of that fold to answer "which event replaced this one".
 * - `sourceEventSeqs` — sequence numbers this event cites as its sources (`tool/result` citing its
 *   `tool/call`, a rewritten message citing the events it derives from).
 *
 * A live session has no log on disk yet (`source_path` is the synthetic `live://<id>` marker), so
 * every reader here returns `undefined` for it rather than pretending the log is empty; the caller
 * turns that into an answer the model can act on.
 *
 * @module dsh-plugin-sessiongraph-sessions/raw
 */

import { readFileSync } from 'node:fs'
import { decompressSessionLog } from './parse.ts'
import { LIVE_SOURCE_PREFIX } from './live.ts'

/** One raw event, with the log's own fields preserved. */
export interface RawSessionEvent {
  /** Event sequence number inside the session. */
  readonly seq: number
  /** Event timestamp, epoch milliseconds (0 when the log line recorded none). */
  readonly time: number
  /** Event type as the log records it (`tool/call`, `assistant/message`, …). */
  readonly type: string
  /** The event's own `data` payload, exactly as parsed from the line. */
  readonly data: unknown
  /** Sequence numbers this event cites as sources, when the log records them. */
  readonly sourceEventSeqs?: readonly number[]
  /** How the event enters the model surface, when it is a surface event. */
  readonly surfaceOp?: unknown
}

/** One parsed session log: its flat header (when present) and every event, in log order. */
export interface RawSessionLog {
  /** Absolute path of the log the events came from. */
  readonly sourcePath: string
  /** The log's first-line header, when it carries one. */
  readonly header: Record<string, unknown> | undefined
  /** Every parsed event, in ascending log order. */
  readonly events: readonly RawSessionEvent[]
}

/** Options for {@link readRawEvents}. */
export interface ReadRawEventsOptions {
  /**
   * Keep only these sequence numbers. Omitted means every event — which is what a trace needs, since
   * a replacement chain is resolved from the whole log, not from the two events being compared.
   */
  readonly seqs?: readonly number[]
}

/** One event plus the neighbours immediately before and after it in log order. */
export interface RawEventWindow {
  /** The target event. */
  readonly event: RawSessionEvent
  /** Up to `beforeCount` events with a smaller sequence number, oldest first. */
  readonly before: readonly RawSessionEvent[]
  /** Up to `afterCount` events with a larger sequence number, oldest first. */
  readonly after: readonly RawSessionEvent[]
}

/** One event's surface relationships, as the log records them. */
export interface RawEventTrace {
  /** The target event. */
  readonly event: RawSessionEvent
  /** Replacements of the target, following the chain outward from it (nearest first). */
  readonly replacedBy: readonly number[]
  /** Surface events the target itself replaced, in surface order. */
  readonly shadowedSeqs: readonly number[]
  /** Sequence numbers the target cites as sources. */
  readonly sourceEventSeqs: readonly number[]
}

/** The event surface a log folds to, plus the replacement relationships that fold discovered. */
export interface RawSurfaceFold {
  /** Sequence numbers still on the model surface, in surface order. */
  readonly current: readonly number[]
  /** `shadowed → replacement`: the event that removed it from the surface. */
  readonly replacedBy: ReadonlyMap<number, number>
  /** `replacement → shadowed`: the surface run that event replaced. */
  readonly shadowed: ReadonlyMap<number, readonly number[]>
}

/**
 * Whether a `session.source_path` names a conversation the host still holds in memory. Such a
 * session is re-indexed from the live view on every run and has no log to read.
 * @param sourcePath - the indexed session's source path.
 * @returns true for the synthetic `live://` marker.
 */
export function isLiveSource(sourcePath: string): boolean {
  return sourcePath.startsWith(LIVE_SOURCE_PREFIX)
}

/**
 * Read one session log's raw events.
 *
 * A live session returns `undefined` instead of throwing: "this conversation has not been written to
 * disk yet" is an answer the caller renders, not a failure of the store.
 * @param sourcePath - absolute path of the zstd JSONL log, or a `live://` marker.
 * @param options - sequence-number filter.
 * @returns the parsed log, or `undefined` for a live session.
 * @throws when the file cannot be read or is not a zstd JSONL log; the caller maps that to the seam.
 */
export function readRawEvents(sourcePath: string, options: ReadRawEventsOptions = {}): RawSessionLog | undefined {
  if (isLiveSource(sourcePath)) return undefined
  const buffer = readFileSync(sourcePath)
  return parseRawEvents(buffer, sourcePath, options.seqs)
}

/**
 * Parse already-read log bytes into raw events.
 *
 * Tolerant per line, exactly like {@link parseSessionLog}: a truncated append costs one event, never
 * the conversation. Unlike the indexer, nothing is clipped — the payload is the point.
 * @param buffer - the raw log file contents, or already-decompressed JSONL text.
 * @param sourcePath - path recorded on the returned log, for diagnostics.
 * @param seqs - when given, keep only these sequence numbers.
 * @returns the parsed log.
 */
export function parseRawEvents(
  buffer: Buffer | string,
  sourcePath: string,
  seqs?: readonly number[],
): RawSessionLog {
  const text = typeof buffer === 'string' ? buffer : decompressSessionLog(buffer).toString('utf8')
  const wanted = seqs === undefined ? undefined : new Set(seqs)
  const lines = text.split('\n')
  let header: Record<string, unknown> | undefined
  let start = 0
  const first = firstNonEmptyLine(lines)
  if (first !== undefined) {
    const record = parseRecord(lines[first] as string)
    if (record?.type === 'session') {
      header = record
      start = first + 1
    } else {
      start = first
    }
  }
  const events: RawSessionEvent[] = []
  for (let index = start; index < lines.length; index += 1) {
    const line = (lines[index] as string).trim()
    if (line === '') continue
    const event = toRawEvent(parseRecord(line))
    if (event === undefined) continue
    if (wanted !== undefined && !wanted.has(event.seq)) continue
    events.push(event)
  }
  return { sourcePath, header, events }
}

/**
 * Lift one parsed log line into a raw event, dropping a line without the identity fields.
 * @param record - the parsed line.
 * @returns the event, or undefined when the line is not an event.
 */
function toRawEvent(record: Record<string, unknown> | undefined): RawSessionEvent | undefined {
  const seq = numberField(record, 'seq')
  const type = stringField(record, 'type')
  if (seq === undefined || type === undefined) return undefined
  const sources = sourceSeqs(record)
  return {
    seq,
    time: numberField(record, 'time') ?? 0,
    type,
    data: record?.data,
    ...(sources === undefined ? {} : { sourceEventSeqs: sources }),
    ...(record?.surfaceOp === undefined ? {} : { surfaceOp: record.surfaceOp }),
  }
}

/**
 * Read an event's cited source sequence numbers, refusing a value that is not a number array.
 * @param record - the parsed event line.
 * @returns the sequence numbers, or undefined when the field is absent or malformed.
 */
function sourceSeqs(record: Record<string, unknown> | undefined): readonly number[] | undefined {
  const value = record?.sourceEventSeqs
  if (!Array.isArray(value)) return undefined
  return value.filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry))
}

/**
 * The target event and its immediate neighbours in log order.
 * @param log - the parsed log.
 * @param seq - target sequence number.
 * @param beforeCount - events to include before the target (default none).
 * @param afterCount - events to include after the target (default none).
 * @returns the window, or undefined when the log holds no such event.
 */
export function rawEventWindow(
  log: RawSessionLog,
  seq: number,
  beforeCount = 0,
  afterCount = 0,
): RawEventWindow | undefined {
  const index = log.events.findIndex(event => event.seq === seq)
  if (index === -1) return undefined
  const before = Math.max(0, Math.floor(beforeCount))
  const after = Math.max(0, Math.floor(afterCount))
  return {
    event: log.events[index] as RawSessionEvent,
    before: log.events.slice(Math.max(0, index - before), index),
    after: log.events.slice(index + 1, index + 1 + after),
  }
}

/**
 * Fold a log's event surface and keep the replacement relationships the fold discovered.
 *
 * This is the tolerant reader's version of the harness's surface fold: it understands the two marker
 * shapes the log carries (`'append'` and `{ op: 'replace', startSeq, endSeq }`) and ignores anything
 * it cannot resolve instead of rejecting the whole log. A log written by a newer harness must still
 * answer "what replaced what" for the events this reader does understand; refusing the log would make
 * every trace fail over one unrecognized marker.
 * @param events - the log's events, in log order.
 * @returns the folded surface and the replacement maps.
 */
export function foldRawSurface(events: readonly RawSessionEvent[]): RawSurfaceFold {
  const nodes: number[] = []
  const replacedBy = new Map<number, number>()
  const shadowed = new Map<number, readonly number[]>()
  for (const event of events) {
    const op = event.surfaceOp
    if (op === 'append') {
      nodes.push(event.seq)
      continue
    }
    const range = replacementRange(op)
    if (range === undefined) continue
    const startIdx = nodes.indexOf(range.startSeq)
    const endIdx = nodes.indexOf(range.endSeq)
    // A replacement naming an event this reader did not put on the surface (an older index, a marker
    // shape it does not know) is skipped rather than guessed at: an empty trace beats a wrong one.
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) continue
    const removed = nodes.slice(startIdx, endIdx + 1)
    shadowed.set(event.seq, removed)
    for (const seq of removed) replacedBy.set(seq, event.seq)
    nodes.splice(startIdx, endIdx - startIdx + 1, event.seq)
  }
  return { current: nodes, replacedBy, shadowed }
}

/**
 * Read a replacement marker's range.
 * @param op - the event's `surfaceOp` value.
 * @returns the range, or undefined when it is not a replace marker.
 */
function replacementRange(op: unknown): { startSeq: number; endSeq: number } | undefined {
  if (typeof op !== 'object' || op === null || Array.isArray(op)) return undefined
  const record = op as Record<string, unknown>
  if (record['op'] !== 'replace') return undefined
  const startSeq = record['startSeq']
  const endSeq = record['endSeq']
  if (typeof startSeq !== 'number' || !Number.isFinite(startSeq)) return undefined
  if (typeof endSeq !== 'number' || !Number.isFinite(endSeq)) return undefined
  return { startSeq, endSeq }
}

/**
 * Trace one event's replacement chain and cited sources.
 * @param log - the parsed log.
 * @param seq - target sequence number.
 * @returns the relationships, or undefined when the log holds no such event.
 */
export function traceRawEvent(log: RawSessionLog, seq: number): RawEventTrace | undefined {
  const event = log.events.find(candidate => candidate.seq === seq)
  if (event === undefined) return undefined
  const fold = foldRawSurface(log.events)
  const replacedBy: number[] = []
  const seen = new Set<number>([seq])
  let next = fold.replacedBy.get(seq)
  // A cyclic log (a replacement chain that loops) must terminate: the harness never writes one, but
  // an event read is not the place to hang on corrupt input.
  while (next !== undefined && !seen.has(next) && replacedBy.length < log.events.length) {
    replacedBy.push(next)
    seen.add(next)
    next = fold.replacedBy.get(next)
  }
  return {
    event,
    replacedBy,
    shadowedSeqs: fold.shadowed.get(seq) ?? [],
    sourceEventSeqs: event.sourceEventSeqs ?? [],
  }
}

/** Index of the first non-blank line. */
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
function parseRecord(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** Read a string field from a record. */
function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' ? value : undefined
}

/** Read a finite number field from a record. */
function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
