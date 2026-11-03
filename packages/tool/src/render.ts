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
import type { SessiongraphToolValue } from './schema.ts'

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

/** One hit as the three lines a reader needs: when/who, where, and the matched text. */
function hitLines(hit: Extract<SessiongraphToolValue, { operation: 'search' }>['hits'][number], maxChars: number): string[] {
  const turn = hit.turn === undefined ? '' : ` · 第 ${hit.turn} 轮`
  return [
    `${formatTime(hit.time)} · [${hit.kind}] · ${titled(hit.title)}`,
    `  ${hit.workspace} · session ${hit.session_id} #${hit.seq}${turn}`,
    `  ${clipText(hit.snippet, maxChars)}`,
  ]
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
        return `还没有索引（${value.index_path}）。请先调用 sessiongraph_index 建一次索引；建好之前除 status 外的查询都会失败。`
      }
      const indexedAt = value.indexed_at === undefined ? '未知' : formatTime(value.indexed_at)
      return `索引就绪（${value.index_path}）：${value.sessions} 个会话、${value.entries} 条可检索条目、`
        + `${value.workspaces} 个工作区、${formatBytes(value.bytes)}。最近一次建索引 ${indexedAt}。`
    }
    case 'index': {
      const failed = value.failed.length === 0
        ? '没有会话解析失败。'
        : `解析失败 ${value.failed.length} 个：`
          + value.failed.map(entry => `\n  ${entry.path} — ${entry.reason}`).join('')
      return [
        `建索引完成，用时 ${formatDuration(value.elapsed_ms)}：`
          + `新增 ${value.added}、更新 ${value.updated}、跳过 ${value.skipped}、移除 ${value.removed}`
          + `（共发现 ${value.discovered} 个会话）。`,
        `${value.index_path}：${value.sessions} 个会话、${value.entries} 条可检索条目、`
          + `${value.workspaces} 个工作区、${formatBytes(value.bytes)}。`,
        failed,
      ].join('\n')
    }
    /* v8 ignore next -- exhaustive over the output schema's closed union; unreachable. */
    default:
      return assertNever(value)
  }
}
