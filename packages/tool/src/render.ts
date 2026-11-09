/**
 * Model-facing text for each operation's canonical value.
 *
 * Every line is meant to be acted on directly: a hit names the full session id, so the next call can
 * be `session` without a search round-trip, and every timestamp is rendered in the machine's local
 * zone (`2026-11-03 10:37`) rather than as a bare epoch, which the model would have to convert before
 * it could reason about "last week". A truncated answer always says so — a capped list that reads as
 * complete is worse than a short one, because the model concludes it has seen everything.
 * @module dsh-plugin-sessiongraph-tool/render
 */

import { assertNever } from 'dsh-plugin-sessiongraph-service'
import type { SessiongraphToolValue, SessiongraphValueFor } from './schema.ts'

/**
 * The arguments rendering may look at: the few model-supplied facts the canonical value does not echo
 * back (the query text, the workspace filter).
 *
 * Deliberately structural rather than `SessiongraphToolArgs`: the index tool shares this renderer and
 * its arguments carry no `operation` at all. Both tools' argument objects satisfy this shape.
 */
export interface RenderArgs {
  /** The search text, when the call was a search. */
  readonly query?: string
  /** The workspace filter, when the model named one. */
  readonly workspace?: string
}

/** Caps applied while rendering; the tool owns them so a deployment can retune answer size. */
export interface RenderOptions {
  /** Longest snippet (or session entry) shown per item before it is clipped with `…`. */
  maxSnippetChars: number
}

/**
 * Render one epoch-millisecond timestamp in the machine's local zone, minute precision.
 * @param epochMs - epoch milliseconds.
 * @returns `YYYY-MM-DD HH:mm` in local time.
 */
export function formatTime(epochMs: number): string {
  const date = new Date(epochMs)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Two-digit zero pad.
 * @param value - the number to pad.
 * @returns the padded decimal string.
 */
function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * Render a byte count in binary units, at most one decimal.
 * @param bytes - the byte count.
 * @returns a short human-readable size.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const unit = units[exponent] ?? 'B'
  const value = bytes / 1024 ** exponent
  const rounded = exponent === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded} ${unit}`
}

/**
 * Render a duration in the unit a reader thinks in: seconds under a minute, minutes above it.
 * @param ms - duration in milliseconds.
 * @returns a short human-readable duration.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 秒'
  if (ms < 60_000) return `${Math.round(ms / 100) / 10} 秒`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes} 分 ${seconds} 秒`
}

/**
 * Report how many of the indexed sessions are still running.
 *
 * Always rendered, even at zero: "no live sessions" and "this store cannot tell" are different
 * states, and a reader who wanted to know whether the conversation they are in right now is
 * searchable must be able to tell them apart. The caller supplies `0` for a store that omits the
 * count, which is the honest reading of a store that predates live indexing.
 * @param live - live sessions the index holds.
 * @returns the one status line.
 */
export function formatLiveSessions(live: number): string {
  return live === 0
    ? '实时会话：0（当前没有正在跑的会话）'
    : `实时会话：${live} 个（当前还在跑、未落盘）`
}

/**
 * One line a finished index run adds when it replayed sessions that are still running.
 *
 * Omitted at zero on purpose: an empty run is the normal case, and a line that almost always says
 * "replayed 0 live sessions" trains a reader to skip the block it sits in.
 * @param live - live sessions replayed by the run.
 * @returns the sentence, or an empty string when there were none.
 */
export function formatLiveReplay(live: number): string {
  return live === 0 ? '' : `本次重放 ${live} 个实时会话。`
}

/**
 * Clip one blob of text to a character cap, marking the cut.
 * @param text - the text to bound.
 * @param maxChars - characters allowed, ellipsis included.
 * @returns the text, or its clipped prefix with `…`.
 */
export function clipText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`
}

/** The `N shown of M` suffix a truncatable list carries. */
function counted(shown: number, total: number, truncated: boolean): string {
  return truncated ? `（共 ${total} 条，显示前 ${shown} 条；用 offset 翻页）` : `（共 ${total} 条）`
}

/** A session title for a line, with an explicit placeholder when the log never recorded one. */
function titled(title: string | undefined): string {
  return title === undefined || title.trim() === '' ? '（无标题）' : `《${title}》`
}

/**
 * The harness a session came from, marked only when it is not this host's own.
 *
 * An index holds DSH's logs and Codex's rollout logs side by side. Prefixing every DSH line would be
 * noise on a machine whose history is mostly DSH, while an unmarked Codex line reads as a
 * conversation this harness cannot open — so the mark appears exactly where it changes the answer.
 * @param source - the session's recorded source.
 * @returns a bracketed tag plus a separator, or an empty string for `dsh`.
 */
function sourceTag(source: string): string {
  return source === 'dsh' ? '' : `[${source}] `
}

/** One session as a single line: when it last spoke, its id, title, workspace, and size. */
function sessionLine(session: SessiongraphValueFor<'session'>['session']): string {
  return `${formatTime(session.last_at)} · ${sourceTag(session.source)}session ${session.session_id}`
    + ` · ${titled(session.title)} · ${session.workspace} · ${session.turns} 轮 / ${session.entries} 条`
}

/** One event summary as a single line. */
function eventLine(event: { readonly seq: number; readonly time: number; readonly type: string }): string {
  return `#${event.seq} · ${formatTime(event.time)} · ${event.type}`
}

/** Render a JSON value for a fenced block, never returning `undefined`. */
function jsonText(value: unknown): string {
  const text = JSON.stringify(value, null, 2)
  return text === undefined ? 'null' : text
}

/**
 * Render one event-trace answer: the event's identity, then the three relationship sets.
 * @param value - the canonical `trace` value of `kind: 'event'`.
 * @returns the rendered text.
 */
function eventTraceText(value: Extract<SessiongraphValueFor<'trace'>, { kind: 'event' }>): string {
  const session = value.session
  return [
    `事件关系：会话 ${session.session_id} · ${titled(session.title)}`,
    `${session.workspace} · ${eventLine(value.event)}`,
    sequenceLine('被这些事件替换（replacedBy）', value.replaced_by, '没有被替换。'),
    sequenceLine('它替换了（shadowedSeqs）', value.shadowed_seqs, '没有替换任何事件。'),
    sequenceLine('引用来源（sourceEventSeqs）', value.source_event_seqs, '没有引用其它事件。'),
  ].join('\n')
}

/**
 * Render one labelled list of event sequence numbers.
 * @param label - the relationship's name.
 * @param seqs - the sequence numbers.
 * @param empty - what to say instead when there are none.
 * @returns one line.
 */
function sequenceLine(label: string, seqs: readonly number[], empty: string): string {
  return seqs.length === 0 ? `${label}：${empty}` : `${label}：${seqs.map(seq => `#${seq}`).join(', ')}`
}

/** One hit as the three lines a reader needs: when/who, where, and the matched text. */
function hitLines(hit: Extract<SessiongraphToolValue, { operation: 'search' }>['hits'][number], maxChars: number): string[] {
  const turn = hit.turn === undefined ? '' : ` · 第 ${hit.turn} 轮`
  return [
    `${formatTime(hit.time)} · [${hit.kind}] · ${titled(hit.title)}`,
    `  ${hit.workspace} · ${sourceTag(hit.source)}session ${hit.session_id} #${hit.seq}${turn}`,
    `  ${clipText(hit.snippet, maxChars)}`,
  ]
}

/** The one line an answer carries when the index could not be brought up to date before querying. */
export const STALE_NOTE =
  '（注意：本次增量刷新没有完成，答案可能不是最新——索引里可能还没有刚才的对话。'
  + '确实需要最新结果时可以调用 sessiongraph 的 index 操作（force: true）强制重建。）'

/** Whether a value was served from an index the query path could not refresh first. */
function isStale(value: SessiongraphToolValue): boolean {
  return 'stale' in value && value.stale === true
}

/**
 * Render one result as the text the model reads.
 * @param args - the validated arguments, used for the few facts the value does not echo back.
 * @param value - the canonical value the operation returned.
 * @param options - rendering caps.
 * @returns the rendered text.
 */
export function renderSessiongraph(
  args: RenderArgs,
  value: SessiongraphToolValue,
  options: RenderOptions,
): string {
  const text = renderValue(args, value, options)
  const notes: string[] = []
  if (foreignSources(value).has('codex')) notes.push(FOREIGN_SOURCE_NOTE)
  if (isStale(value)) notes.push(STALE_NOTE)
  return notes.length === 0 ? text : `${text}\n${notes.join('\n')}`
}

/**
 * What a reader has to know before acting on a Codex row.
 *
 * An index holds two harnesses, and a conversation that exists only as a Codex rollout is not a
 * DSH session: it has no entry in the host's sidebar and no DSH session id to jump to. Without the
 * note, "I found it in session <id>" sends the user looking for something that is not there — so the
 * note says where the bytes actually are.
 */
const FOREIGN_SOURCE_NOTE =
  '注：标 [codex] 的会话来自 OpenAI Codex（~/.codex 下的 rollout 日志），不是本机 DSH 会话 —— '
  + 'DSH 侧边栏里找不到它，也没有能跳转的本机会话 id。正文可以用 session / event 读，'
  + '要接着聊得去 Codex 那边。'

/**
 * Every session source one answer mentions.
 *
 * `workspaces`, `status` and `index` answer about the index itself rather than about conversations,
 * so they contribute nothing: a note there would describe rows the answer never showed.
 * @param value - the canonical value the operation returned.
 * @returns the distinct sources it named.
 */
function foreignSources(value: SessiongraphToolValue): ReadonlySet<string> {
  switch (value.operation) {
    case 'search':
      return new Set(value.hits.map(hit => hit.source))
    case 'session':
    case 'event':
      return new Set([value.session.source])
    case 'timeline':
      return new Set(value.sessions.map(session => session.source))
    case 'trace':
      return value.kind === 'event'
        ? new Set([value.session.source])
        : new Set([
            value.target.source,
            ...value.ancestors.map(ancestor => ancestor.source),
            ...value.descendants.map(node => node.session.source),
          ])
    default:
      return new Set()
  }
}

/**
 * The per-operation rendering, without the cross-cutting staleness note.
 * @param args - the validated arguments.
 * @param value - the canonical value the operation returned.
 * @param options - rendering caps.
 * @returns the rendered text.
 */
function renderValue(
  args: RenderArgs,
  value: SessiongraphToolValue,
  options: RenderOptions,
): string {
  const maxChars = options.maxSnippetChars
  switch (value.operation) {
    case 'search': {
      if (value.hits.length === 0) {
        const where = args.workspace === undefined ? '' : `（工作区 ${args.workspace}）`
        return `会话历史里没有命中「${args.query ?? ''}」${where}。换个词，或省略 workspace 扩大范围。`
      }
      const header = `命中 ${value.hits.length} 条${counted(value.hits.length, value.total, value.truncated)}`
        + `${args.query === undefined ? '' : `，查询「${args.query}」`}：`
      const lines: string[] = [header]
      value.hits.forEach((hit, index) => {
        lines.push(`${index + 1}. ${hitLines(hit, maxChars).join('\n')}`)
      })
      return lines.join('\n')
    }
    case 'session': {
      const session = value.session
      const lines = [
        `会话 ${session.session_id} · ${titled(session.title)}`,
        `${session.workspace} · ${formatTime(session.created_at)} → ${formatTime(session.last_at)}`
          + ` · ${session.turns} 轮 · ${session.entries} 条`,
      ]
      const meta: string[] = []
      if (session.parent_session !== undefined) meta.push(`父会话 ${session.parent_session}`)
      if (session.origin !== undefined) meta.push(`来源 ${session.origin}`)
      if (session.agent_preset !== undefined) meta.push(`预设 ${session.agent_preset}`)
      if (meta.length > 0) lines.push(meta.join(' · '))
      if (value.children.length > 0) {
        lines.push(`子会话 ${value.children.length} 个：${value.children.join(', ')}`)
      }
      if (value.entries.length === 0) {
        lines.push('索引里没有这个会话的可读条目。')
        return lines.join('\n')
      }
      const clipped = value.truncated ? '（已截断；用 offset 继续翻页）' : ''
      lines.push(`条目 ${value.entries.length} 条${clipped}：`)
      for (const entry of value.entries) {
        const turn = entry.turn === undefined ? '' : ` 第 ${entry.turn} 轮`
        const cut = entry.clipped ? ' [索引里只存了前缀]' : ''
        lines.push(`${formatTime(entry.time)} #${entry.seq} [${entry.kind}]${turn}${cut}:`)
        lines.push(`  ${clipText(entry.text, maxChars)}`)
      }
      return lines.join('\n')
    }
    case 'event': {
      const session = value.session
      const lines = [
        `会话 ${session.session_id} · ${titled(session.title)}`,
        `${session.workspace} · 事件 #${value.event.seq} · ${formatTime(value.event.time)} · ${value.event.type}`,
      ]
      if (value.before.length > 0) {
        lines.push(`之前 ${value.before.length} 条事件（旧→新）：`)
        for (const summary of value.before) lines.push(`  ${eventLine(summary)}`)
      }
      // The payload is the original bytes: an event read exists so the model can see what the index
      // clipped, so it goes into a fenced JSON block verbatim rather than through `clipText`.
      lines.push('```json')
      lines.push(jsonText(value.event.data))
      lines.push('```')
      if (value.after.length > 0) {
        lines.push(`之后 ${value.after.length} 条事件（旧→新）：`)
        for (const summary of value.after) lines.push(`  ${eventLine(summary)}`)
      }
      return lines.join('\n')
    }
    case 'trace': {
      if (value.kind === 'event') {
        return eventTraceText(value)
      }
      const target = value.target
      const lines = [
        `会话血缘：${titled(target.title)} · session ${target.session_id}`,
        `${target.workspace} · ${formatTime(target.created_at)} → ${formatTime(target.last_at)}`
          + ` · ${target.turns} 轮 · ${target.entries} 条`,
      ]
      if (value.ancestors.length === 0) {
        lines.push('没有父会话（这条血缘的根）。')
      } else {
        lines.push(`祖先 ${value.ancestors.length} 个（近→远）：`)
        for (const ancestor of value.ancestors) lines.push(`  ${sessionLine(ancestor)}`)
      }
      if (value.descendants.length === 0) {
        lines.push('没有子会话。')
      } else {
        lines.push(`后代 ${value.descendants.length} 个：`)
        // `depth` is the distance from the target, so the indent is the tree shape itself.
        for (const node of value.descendants) lines.push(`${'  '.repeat(node.depth + 1)}${sessionLine(node.session)}`)
      }
      if (!value.complete) lines.push('（追踪未完成：命中 depth 上限，或父会话不在索引里。）')
      return lines.join('\n')
    }
    case 'timeline': {
      if (value.sessions.length === 0) {
        return args.workspace === undefined ? '索引里还没有会话。' : `工作区 ${args.workspace} 还没有被索引的会话。`
      }
      const header = `最近 ${value.sessions.length} 个会话${value.truncated ? '（还有更旧的；用 limit 扩大）' : ''}，最新在前：`
      const lines = [header]
      for (const session of value.sessions) {
        lines.push(
          `${formatTime(session.last_at)} · session ${session.session_id} · ${titled(session.title)}`
            + ` · ${session.workspace} · ${session.turns} 轮 / ${session.entries} 条`,
        )
      }
      return lines.join('\n')
    }
    case 'workspaces': {
      if (value.workspaces.length === 0) return '索引里还没有工作区。'
      const header = `工作区 ${value.workspaces.length} 个${value.total > value.workspaces.length ? `（共 ${value.total} 个）` : ''}，最近活跃在前：`
      const lines = [header]
      for (const workspace of value.workspaces) {
        lines.push(
          `${workspace.workspace} · ${workspace.sessions} 会话 · ${workspace.entries} 条`
            + ` · ${formatTime(workspace.first_at)} → ${formatTime(workspace.last_at)}`,
        )
      }
      return lines.join('\n')
    }
    case 'status': {
      if (!value.indexed) {
        return `还没有索引（${value.index_path}）。请先调用 sessiongraph 的 index 操作建一次；建好之前除 status 外的操作都会失败。`
      }
      const indexedAt = value.indexed_at === undefined ? '未知' : formatTime(value.indexed_at)
      return `索引就绪（${value.index_path}）：${value.sessions} 个会话、${value.entries} 条可检索条目、`
        + `${value.workspaces} 个工作区、${formatBytes(value.bytes)}。最近一次建索引 ${indexedAt}。`
        + `\n${formatLiveSessions(value.live_sessions)}`
    }
    case 'index': {
      // A delegated run has no report yet. Saying so, and naming the job that will carry it, is the
      // whole answer: the model must not read "started" as "indexed" and query an index that is
      // still being replaced.
      if ('status' in value) {
        return `已在后台建索引，jobId=${value.job_id}。可以稍后查 sessiongraph status 看规模；`
          + `job_output ${value.job_id} 能取这次运行的报告。`
      }
      const failed = value.failed.length === 0
        ? '没有会话解析失败。'
        : `解析失败 ${value.failed.length} 个：`
          + value.failed.map(entry => `\n  ${entry.path} — ${entry.reason}`).join('')
      const replayed = formatLiveReplay(value.live_sessions)
      return [
        `建索引完成，用时 ${formatDuration(value.elapsed_ms)}：`
          + `新增 ${value.added}、更新 ${value.updated}、跳过 ${value.skipped}、移除 ${value.removed}`
          + `（共发现 ${value.discovered} 个会话）。`,
        `${value.index_path}：${value.sessions} 个会话、${value.entries} 条可检索条目、`
          + `${value.workspaces} 个工作区、${formatBytes(value.bytes)}。`,
        ...(replayed === '' ? [] : [replayed]),
        failed,
      ].join('\n')
    }
    /* v8 ignore next -- exhaustive over the output schema's closed union; unreachable. */
    default:
      return assertNever(value)
  }
}
