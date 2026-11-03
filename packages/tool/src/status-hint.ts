/**
 * The one line of index state this plugin contributes to the system prompt on every request.
 *
 * A model that has to call `status` before every query spends a tool round-trip learning something the
 * host could have told it at assembly time. `ctx.systemPrompt.section` takes a function for exactly
 * this case (`packages/tool/src/index.ts` passes one), and that function runs synchronously on every
 * assembly — so this module must never reach the store: opening SQLite once per model request would
 * put a database on the prompt-assembly path. It does one `stat` of the index file, plus (when an
 * indexer left one) one small `status.json` read beside it.
 *
 * Nothing here is authoritative: the file system says an index exists, the index says what is in it.
 * Three outcomes are deliberately distinguished — a summary, an index without a summary (built by a
 * run that recorded no sidecar), and no index at all. Collapsing the middle case into "no index" would
 * invite rebuilding an index that is already there.
 * @module dsh-plugin-sessiongraph-tool/status-hint
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { INDEX_RELATIVE_PATH } from 'dsh-plugin-sessiongraph-service'
import { formatBytes, formatTime } from './render.ts'

/**
 * Optional summary an indexer may leave beside `index.db` after a successful run.
 *
 * The design contract only requires the `meta` table inside the index, which cannot be read without
 * opening the database — exactly what prompt assembly must not do. A writer that wants the richer
 * prompt line therefore persists the same facts as JSON here; a writer that does not leaves it absent,
 * and the hint degrades to the honest "index exists, no status record" wording instead of guessing.
 */
const STATUS_RELATIVE_PATH = 'status.json'

/** The facts a `status.json` sidecar carries, as this module reads them. */
export interface IndexStatusFile {
  /** Epoch milliseconds of the run that wrote the index. */
  indexedAt: number
  /** Sessions in the index after that run. */
  sessions: number
  /** Searchable entries after that run. */
  entries: number
  /** Distinct workspaces after that run. */
  workspaces: number
  /** Bytes the index file occupies. */
  bytes: number
}

/**
 * Read an indexing run's persisted summary.
 * @param indexRoot - the directory the index lives in.
 * @returns the summary, or `undefined` when the file is absent, unreadable, or not shaped like one.
 */
export function readIndexStatus(indexRoot: string): IndexStatusFile | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(indexRoot, STATUS_RELATIVE_PATH), 'utf8'))
  } catch {
    // Absent, unreadable, or not JSON: all three mean "no summary to trust", which the caller renders
    // as the weaker statement rather than as an error. A prompt line must never fail an assembly.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  const indexedAt = numberField(record, 'indexedAt')
  const sessions = numberField(record, 'sessions')
  const entries = numberField(record, 'entries')
  const workspaces = numberField(record, 'workspaces')
  const bytes = numberField(record, 'bytes')
  if (
    indexedAt === undefined || sessions === undefined || entries === undefined
    || workspaces === undefined || bytes === undefined
  ) return undefined
  return { indexedAt, sessions, entries, workspaces, bytes }
}

/**
 * One numeric field of a parsed object, or `undefined` when it is absent or not a finite number.
 * @param record - the parsed object.
 * @param field - the field name to read.
 * @returns the number, or `undefined`.
 */
function numberField(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** The size and modification time of one file, or `undefined` when it does not exist. */
function statFile(path: string): { size: number; mtimeMs: number } | undefined {
  try {
    const stats = statSync(path)
    return { size: stats.size, mtimeMs: stats.mtimeMs }
  } catch {
    // Missing, or a directory in the way, or no permission: all mean "cannot claim an index here".
    return undefined
  }
}

/**
 * The state of the session index, phrased for a system prompt.
 * @param indexRoot - the absolute directory holding the index (`~` already expanded by the caller).
 * @returns one sentence naming the state, or what the model should do about it.
 */
export function indexStatusHint(indexRoot: string): string {
  const indexPath = join(indexRoot, INDEX_RELATIVE_PATH)
  const index = statFile(indexPath)
  if (index === undefined) {
    return `这台机器还没有 sessiongraph 索引（${indexPath}）。新会话创建时会在后台自动建一次：`
      + '它会扫描 ~/.dsh/sessions 下的全部会话，首次可能要几十秒到几分钟，不阻塞会话。'
      + '要立刻建就调用 sessiongraph_index（它有独立的 300 秒预算）；建好之前除 status 外都会失败。'
  }
  const status = readIndexStatus(indexRoot)
  if (status !== undefined) {
    return `索引就绪（${indexPath}）：${status.sessions} 个会话、${status.entries} 条可检索条目、`
      + `${status.workspaces} 个工作区、${formatBytes(status.bytes)}；`
      + `最近一次建索引 ${formatTime(status.indexedAt)}。`
  }
  return `索引文件已存在（${indexPath}，${formatBytes(index.size)}，${formatTime(index.mtimeMs)} 更新），`
    + '但没有 status 记录——规模与新鲜度用 sessiongraph status 查；怀疑过期时用 sessiongraph_index 刷新。'
}

/**
 * The session identity a tool call or prompt assembly is running for.
 *
 * Read structurally rather than through `@deepseek-ai/dsh-agent`: this module needs one string off
 * the payload, and a static import of a host symbol is exactly what took this plugin's sibling off
 * the host once (the export moved between minor releases).
 * @param context - the tool-execution or assembly context the host passes in (`{ agent, scope, signal }`).
 * @returns the agent's id, or `undefined` when the payload carries none.
 */
export function agentIdOf(context: unknown): string | undefined {
  const agent = (context as { agent?: { id?: unknown } } | undefined)?.agent
  const id = agent?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}
