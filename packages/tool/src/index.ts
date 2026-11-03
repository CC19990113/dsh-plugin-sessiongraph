/**
 * Model-facing `sessiongraph` tool family over `ctx.sessiongraph`. The `sessiongraph` tool is
 * read-only, with five operations — `search`, `session`, `timeline`, `workspaces`, `status` — that
 * answer from a pre-built index of every local conversation. A second tool, `sessiongraph_index`,
 * builds or refreshes that index on explicit request; it is separate so it can carry its own, much
 * larger timeout budget than a query, because `defineTool`'s `timeoutMs` is fixed per registration,
 * not per call, and one budget cannot fit both a millisecond query and a whole-machine index run.
 *
 * The tools own every default the seam refuses to guess — the per-operation result limits, the cap on
 * a snippet — so the seam's requests stay fully specified and a deployment can retune what the model
 * reads without touching a store. They inject only `tools`, `sessiongraph`, and `systemPrompt`, and
 * import no store: which index answers is the seam's routing decision.
 *
 * Namespace plugin (named exports, no default export).
 * @module dsh-plugin-sessiongraph-tool
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { INDEX_RELATIVE_PATH, SessiongraphError } from 'dsh-plugin-sessiongraph-service'
import type {
  SessiongraphIndexOptions,
  SessiongraphIndexReport,
  SessiongraphRequest,
  SessiongraphResult,
  SessiongraphSearchResult,
  SessiongraphService,
  SessiongraphSessionResult,
  SessiongraphSessionSummary,
  SessiongraphStatusResult,
  SessiongraphTimelineResult,
  SessiongraphWorkspacesResult,
} from 'dsh-plugin-sessiongraph-service'
import { isBackgroundIndexReport } from 'dsh-plugin-sessiongraph-sessions'
import type { SessiongraphBackgroundIndexReport } from 'dsh-plugin-sessiongraph-sessions'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { registerCommands } from './command.ts'
import { LazyIndexRefresher } from './refresh.ts'
import type { SynchronousIndexOptions } from './refresh.ts'
import { renderSessiongraph } from './render.ts'
import type { RenderOptions } from './render.ts'
import {
  SESSIONGRAPH_DEFAULT_LIMITS,
  SESSIONGRAPH_INDEX_PARAMETERS,
  SESSIONGRAPH_OUTPUT_SCHEMA,
  SESSIONGRAPH_PARAMETERS,
} from './schema.ts'
import type {
  SessiongraphIndexToolArgs,
  SessiongraphToolArgs,
  SessiongraphToolValue,
  SessiongraphValueFor,
} from './schema.ts'
import { indexStatusHint } from './status-hint.ts'

// The seam package does not publish this augmentation itself yet; declaring it here is what lets
// `ctx.sessiongraph` be typed as the facade the service class implements. It is a pure type-level
// merge, so it costs nothing at load and would merge harmlessly with the same declaration later.
declare module '@deepseek-ai/cordis' {
  interface Context {
    sessiongraph: SessiongraphService
  }
}

export {
  SESSIONGRAPH_DEFAULT_LIMITS,
  SESSIONGRAPH_ENTRY_KINDS,
  SESSIONGRAPH_INDEX_PARAMETERS,
  SESSIONGRAPH_OPERATIONS,
  SESSIONGRAPH_OUTPUT_SCHEMA,
  SESSIONGRAPH_PARAMETERS,
  SESSIONGRAPH_TOOL_OPERATIONS,
  type SessiongraphIndexToolArgs,
  type SessiongraphQueryOperation,
  type SessiongraphToolArgs,
  type SessiongraphToolOperation,
  type SessiongraphToolValue,
  type SessiongraphValueFor,
} from './schema.ts'
export {
  clipText,
  formatBytes,
  formatDuration,
  formatLiveReplay,
  formatLiveSessions,
  formatTime,
  renderSessiongraph,
  STALE_NOTE,
} from './render.ts'
export type { RenderOptions } from './render.ts'
export { LazyIndexRefresher } from './refresh.ts'
export type { LazyRefreshDeps, RefreshOutcome, SynchronousIndexOptions } from './refresh.ts'
export {
  COMMAND_DEFINITION_ID,
  COMMAND_DESCRIPTION,
  COMMAND_INPUT_HINT,
  COMMAND_NAME,
  COMMAND_USAGE,
  INJECTED_NOTICE_PLUGIN,
  indexReportText,
  invocationWorkspace,
  parseCommand,
  registerCommands,
  runCommand,
  searchText,
  statusText,
  workspacesText,
} from './command.ts'
export type {
  CommandDefinition,
  CommandDefinitionId,
  CommandInvocation,
  CommandOptions,
  CommandPlan,
  CommandRegistry,
  CommandResult,
} from './command.ts'
export { indexStatusHint, readIndexStatus } from './status-hint.ts'
export type { IndexStatusFile } from './status-hint.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'tool-sessiongraph'

/** Services required by this plugin. */
export const inject = ['tools', 'sessiongraph', 'systemPrompt']

/** Default directory the index lives in, before `~` expansion. */
export const DEFAULT_INDEX_ROOT = '~/.dsh/sessiongraph'

/** Default tool-call timeout budget (ms) for the query-side `sessiongraph` tool. */
export const DEFAULT_SESSIONGRAPH_TOOL_TIMEOUT_MS = 30_000

/** Default timeout budget (ms) for the `sessiongraph_index` tool. Indexing every local session is a different order of work than a query. */
export const DEFAULT_SESSIONGRAPH_INDEX_TIMEOUT_MS = 300_000

/** Largest `limit` honored when the plugin config names none. */
export const DEFAULT_MAX_LIMIT = 100

/** Default character cap for one rendered snippet or session entry. */
export const DEFAULT_MAX_SNIPPET_CHARS = 600

/**
 * Default age (ms) at which a query refreshes the index before answering. The indexer keeps a
 * brand-new *session* cheap to find by refreshing on session creation, but the session currently
 * being written has no successor yet; five minutes is the point where "did we just say that" would
 * otherwise land on an index that predates the conversation.
 */
export const DEFAULT_FRESHNESS_THRESHOLD_MS = 300_000

/** The stable system-prompt guidance positioning the session index against grepping session files. */
export const SESSIONGRAPH_PROMPT_TEXT =
  '查我自己过去的对话（「上次在哪个会话里说过/做过什么」）用 sessiongraph，不要 grep ~/.dsh/sessions：'
  + '那里的会话按工作区散在子目录里，是 zstd 压缩的 JSONL，grep 读不到正文，解压全量也慢。'
  + 'sessiongraph 从预建索引回答：search 跨会话全文检索（中文按双字切分，两字词即可命中，如「广告」）、'
  + 'session 按 id 或唯一前缀打开一个会话、timeline 按时间列会话、workspaces 列工作区统计。'
  + '索引超过几分钟没更新时，查询前会自动跑一次增量刷新（很快，失败也照常回答，只是结果可能少几条）。'
  + '索引包含正在进行的会话，所以刚才说的话通常也能查到（取决于上次刷新时间）；status 里的实时会话数会随会话启停变化，不是索引坏了。'
  + '索引不存在时 status 仍能回答，其它操作会失败；要强制全量重建用 sessiongraph_index，它有独立的更长预算（日志很多时它会转成后台 job 并返回 jobId，用 job_output 取报告）。'

/** Plugin configuration: the defaults and caps the seam requires the consumer to own. */
export interface Config {
  /** Directory holding the index (default `~/.dsh/sessiongraph`). `~` is expanded at load. */
  indexRoot?: string
  /** Largest `limit` honored, whatever the model asks for (default 100). */
  maxLimit?: number
  /** Longest snippet or session entry shown per item before it is clipped with `…` (default 600). */
  maxSnippetChars?: number
  /**
   * Age (ms) past which a query runs one incremental index before answering (default 300000). `0`
   * disables the lazy refresh entirely: queries then trust the indexer's own schedule.
   */
  freshnessThresholdMs?: number
  /** Tool-call timeout budget in ms for the query-side `sessiongraph` tool (default 30000). */
  timeoutMs?: number
  /** Tool-call timeout budget in ms for the `sessiongraph_index` tool (default 300000). */
  indexTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  indexRoot: z.string().default(DEFAULT_INDEX_ROOT),
  maxLimit: z.number().default(DEFAULT_MAX_LIMIT),
  maxSnippetChars: z.number().default(DEFAULT_MAX_SNIPPET_CHARS),
  freshnessThresholdMs: z.number().default(DEFAULT_FRESHNESS_THRESHOLD_MS),
  timeoutMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_SESSIONGRAPH_TOOL_TIMEOUT_MS),
  indexTimeoutMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_SESSIONGRAPH_INDEX_TIMEOUT_MS),
})

type ResolvedConfig = Required<Config>

/**
 * Register both tools and the system-prompt guidance.
 * @param ctx - the plugin context (must inject `tools`, `sessiongraph`, `systemPrompt`).
 * @param config - the resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveInteger('maxLimit', resolved.maxLimit)
  assertPositiveInteger('maxSnippetChars', resolved.maxSnippetChars)
  assertNonNegativeInteger('freshnessThresholdMs', resolved.freshnessThresholdMs)
  assertTimer('timeoutMs', resolved.timeoutMs)
  assertTimer('indexTimeoutMs', resolved.indexTimeoutMs)
  if (resolved.indexRoot.trim() === '') {
    throw new Error('tool-sessiongraph: indexRoot must be a non-empty directory path')
  }
  const indexRoot = expandHome(resolved.indexRoot)
  const renderOptions: RenderOptions = { maxSnippetChars: resolved.maxSnippetChars }

  // Process-local, one instance per registration: a second query in this process joins the run in
  // flight instead of starting a second incremental index. `sessiongraph_index` never goes through
  // it — an explicit refresh is asked for, not decided by a clock.
  const refresher = new LazyIndexRefresher({
    indexRoot,
    freshnessThresholdMs: resolved.freshnessThresholdMs,
    index: (options: SynchronousIndexOptions, signal?: AbortSignal) =>
      ctx.sessiongraph.index(indexRoot, options, signal),
  })

  // A function, not a string: the host re-evaluates it on every assembly, which is what lets the model
  // learn whether an index exists for free instead of spending a `status` round-trip. It does one
  // synchronous stat and never opens the index — see `status-hint.ts`.
  ctx.systemPrompt.section({
    name: 'tool:sessiongraph',
    order: 112,
    text: () => `${SESSIONGRAPH_PROMPT_TEXT}\n\n${indexStatusHint(indexRoot)}`,
  })

  ctx.tools.register(defineTool({
    name: 'sessiongraph',
    description:
      '检索本机全部 DSH 会话的历史对话（不是代码）：跨会话全文搜索「上次在哪个会话里说过/做过什么」、按 id 打开一个会话、按时间列会话、列工作区统计、看索引状态。答案来自预建索引，比 grep ~/.dsh/sessions 更快也更完整（那里的 JSONL 是 zstd 压缩的，grep 读不到）。中文按两字词检索即可命中（如「广告」）。要建或刷新索引请调用 sessiongraph_index；没有索引时除 status 外都会失败。',
    parameters: SESSIONGRAPH_PARAMETERS,
    output: {
      schema: SESSIONGRAPH_OUTPUT_SCHEMA,
      render: (args, value) => [{ type: 'text', text: renderSessiongraph(args, value, renderOptions) }],
    },
    timeoutMs: resolved.timeoutMs,
    async execute(args, exec) {
      return runQuery(ctx, refresher, indexRoot, resolved, args, exec)
    },
    presentCall: args => ({
      card: 'generic' as const,
      title: callTitle(args),
      kind: 'search' as const,
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'sessiongraph_index',
    description:
      '建立或刷新 sessiongraph 索引，让 sessiongraph 工具能检索本机会话历史。首次运行会扫描 ~/.dsh/sessions 下的全部会话，可能耗时几十秒到几分钟，所以它有独立的 300 秒预算，与查询的预算分开。源文件自上次索引后没有变化的会话会被跳过，重复调用很便宜；源会话消失时它的条目会从索引里移除。会话日志很多时，这次调用会转成宿主后台任务并立刻返回 jobId（status: started），用 job_output 取运行报告。',
    parameters: SESSIONGRAPH_INDEX_PARAMETERS,
    output: {
      schema: SESSIONGRAPH_OUTPUT_SCHEMA,
      render: (args, value) => [{ type: 'text', text: renderSessiongraph(args, value, renderOptions) }],
    },
    timeoutMs: resolved.indexTimeoutMs,
    async execute(args, exec) {
      return runIndex(ctx, indexRoot, args, exec)
    },
    presentCall: args => {
      const subject = args.session_id ?? args.workspace
      return {
        card: 'generic' as const,
        title: subject === undefined ? 'sessiongraph_index' : `sessiongraph_index ${subject}`,
        kind: 'execute' as const,
        rawInput: args,
      }
    },
  }))

  // The human surface is optional: `ctx.inject` waits for the command registry when the host has
  // one and silently does nothing when it does not, so a composition without it still gets both
  // tools. Registered last so nothing about the model-facing surface depends on it.
  registerCommands(ctx, {
    indexRoot,
    maxSnippetChars: resolved.maxSnippetChars,
  })
}

/**
 * The one-line label a pending call shows.
 * @param args - the validated tool arguments.
 * @returns the card title naming the operation and whichever subject the operation takes.
 */
export function callTitle(args: SessiongraphToolArgs): string {
  const subject = args.query ?? args.session_id ?? args.workspace
  return subject === undefined ? `sessiongraph ${args.operation}` : `sessiongraph ${args.operation} ${subject}`
}

/**
 * Turn the model's snake_case arguments into the seam's camelCase request, applying the per-operation
 * defaults the seam refuses to guess.
 *
 * Conditional requirements live here rather than in the parameter schema, because the parameter DSL
 * has no per-operation conditionals: `search` needs `query`, `session` needs `session_id`, and a call
 * missing either is rejected before it can reach a store.
 * @param args - the validated tool arguments.
 * @param indexRoot - absolute directory the index lives in.
 * @param maxLimit - largest `limit` honored, whatever the model asked for.
 * @returns the normalized request.
 */
export function buildRequest(
  args: SessiongraphToolArgs,
  indexRoot: string,
  maxLimit: number,
): SessiongraphRequest {
  const offset = offsetOf(args.offset)
  switch (args.operation) {
    case 'search':
      return {
        operation: 'search',
        indexRoot,
        query: required(args, 'query', 'search'),
        ...(args.workspace === undefined ? {} : { workspace: args.workspace }),
        ...(args.after === undefined ? {} : { after: timestamp('after', args.after) }),
        ...(args.before === undefined ? {} : { before: timestamp('before', args.before) }),
        ...(args.kinds === undefined || args.kinds.length === 0 ? {} : { kinds: args.kinds }),
        limit: bounded(args.limit, SESSIONGRAPH_DEFAULT_LIMITS.search, maxLimit),
        ...(offset === undefined ? {} : { offset }),
      }
    case 'session':
      return {
        operation: 'session',
        indexRoot,
        sessionId: required(args, 'session_id', 'session'),
        limit: bounded(args.limit, SESSIONGRAPH_DEFAULT_LIMITS.session, maxLimit),
        ...(offset === undefined ? {} : { offset }),
      }
    case 'timeline':
      return {
        operation: 'timeline',
        indexRoot,
        ...(args.workspace === undefined ? {} : { workspace: args.workspace }),
        ...(args.after === undefined ? {} : { after: timestamp('after', args.after) }),
        ...(args.before === undefined ? {} : { before: timestamp('before', args.before) }),
        limit: bounded(args.limit, SESSIONGRAPH_DEFAULT_LIMITS.timeline, maxLimit),
      }
    case 'workspaces':
      return {
        operation: 'workspaces',
        indexRoot,
        limit: bounded(args.limit, SESSIONGRAPH_DEFAULT_LIMITS.workspaces, maxLimit),
      }
    case 'status':
      return { operation: 'status', indexRoot }
    /* v8 ignore next 3 -- exhaustive over the parameter schema's closed operation enum. */
    default:
      throw new SessiongraphError(
        `unknown sessiongraph operation ${JSON.stringify(args.operation)}`,
        'SESSIONGRAPH_INVALID_REQUEST',
      )
  }
}

/**
 * Read a required string argument, rejecting an absent or blank value.
 * @param args - the validated tool arguments.
 * @param field - the argument name the operation requires.
 * @param operation - the operation being built, named in the failure.
 * @returns the non-empty value.
 */
function required(args: SessiongraphToolArgs, field: 'query' | 'session_id', operation: string): string {
  const value = args[field]
  if (value === undefined || value.trim() === '') {
    throw new SessiongraphError(
      `the sessiongraph "${operation}" operation requires a non-empty "${field}"`,
      'SESSIONGRAPH_INVALID_REQUEST',
    )
  }
  return value
}

/**
 * Read an epoch-millisecond filter, rejecting a value that is not a finite number.
 * @param field - the filter name, named in the failure.
 * @param value - the model-supplied number.
 * @returns the truncated timestamp.
 */
function timestamp(field: 'after' | 'before', value: number): number {
  if (!Number.isFinite(value)) {
    throw new SessiongraphError(
      `the sessiongraph "${field}" filter must be a finite epoch-millisecond timestamp`,
      'SESSIONGRAPH_INVALID_REQUEST',
    )
  }
  return Math.trunc(value)
}

/**
 * Read a paging offset, dropping values that cannot mean one.
 * @param value - the model-supplied offset.
 * @returns the non-negative integer offset, or `undefined` when the model named none.
 */
function offsetOf(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.trunc(value))
}

/**
 * Clamp a model-supplied bound into the configured range. The per-operation default is the tool's own
 * choice and is returned untouched: `maxLimit` bounds what the *model* asks for, so a deployment that
 * lowers it never silently shrinks an operation's designed default (a session's 200 entries) into
 * something the operation was not meant to answer with.
 */
function bounded(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  const cap = Math.max(1, Math.trunc(max))
  return Math.min(cap, Math.max(1, Math.trunc(value)))
}

/**
 * Answer one query call.
 *
 * The request is validated first (a bad call must not spend a refresh), then the index is brought up
 * to date if the sidecar says it is older than the freshness threshold, and only then is the query
 * issued. Every refresh problem is non-fatal by construction: {@link LazyIndexRefresher.ensureFresh}
 * never rejects, and its outcome only adds the optional `stale` marker to the answer.
 * @param ctx - the plugin context.
 * @param refresher - the process-local lazy refresh coordinator for this index root.
 * @param indexRoot - absolute directory the index lives in.
 * @param config - the resolved plugin configuration.
 * @param args - the validated tool arguments.
 * @param exec - the tool-execution context.
 * @returns the canonical value for the requested operation.
 */
async function runQuery(
  ctx: Context,
  refresher: LazyIndexRefresher,
  indexRoot: string,
  config: ResolvedConfig,
  args: SessiongraphToolArgs,
  exec: ToolExecution,
): Promise<SessiongraphToolValue> {
  // `status` describes the index itself; refreshing first would make it report a state it just
  // changed, and the model uses it to decide whether to call `sessiongraph_index` at all.
  if (args.operation === 'status') return statusValue(ctx, indexRoot, exec.signal)
  const request = buildRequest(args, indexRoot, config.maxLimit)
  const refresh = await refresher.ensureFresh(exec.signal)
  try {
    return projectResult(await ctx.sessiongraph.query(request, exec.signal), refresh.stale)
  } catch (error) {
    // A damaged index is recoverable without asking anyone: the source logs still exist, only the
    // derived database is unusable. Rebuilding once and retrying is strictly better than surfacing
    // `database disk image is malformed` to the model, and it is exactly what a person would do by
    // hand. Every other failure keeps its existing explanation.
    if (!isCorruptIndexError(error)) throw explainQueryFailure(error, indexRoot)
    try {
      console.error(`sessiongraph: index at "${indexRoot}" is unreadable (${describeError(error)}); rebuilding it`)
      await ctx.sessiongraph.index(indexRoot, { force: true })
      return projectResult(await ctx.sessiongraph.query(request, exec.signal), refresh.stale)
    } catch (rebuildError) {
      console.error(`sessiongraph: rebuilding the index failed: ${describeError(rebuildError)}`)
      throw explainQueryFailure(error, indexRoot)
    }
  }
}

/**
 * Whether a failure means the index file itself is unusable.
 * @param error - the error a query raised.
 * @returns true for the seam's corruption code and for SQLite's own corruption messages.
 */
function isCorruptIndexError(error: unknown): boolean {
  if (error instanceof SessiongraphError) return error.code === 'SESSIONGRAPH_CORRUPT'
  return /malformed|not a database|file is encrypted/i.test(describeError(error))
}

/**
 * One-line description of a thrown value.
 * @param error - whatever was caught.
 * @returns its message, or a stringified form for non-errors.
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The `status` answer, including the one case the seam may not answer: when no store claims the root
 * because no index file exists, "there is no index" is still an honest status, so the tool reports it
 * instead of failing the call.
 * @param ctx - the plugin context.
 * @param indexRoot - absolute directory the index lives in.
 * @param signal - aborts the query.
 * @returns the canonical `status` value.
 */
async function statusValue(ctx: Context, indexRoot: string, signal: AbortSignal): Promise<SessiongraphValueFor<'status'>> {
  try {
    return projectStatus(await ctx.sessiongraph.query({ operation: 'status', indexRoot }, signal))
  } catch (error) {
    if (error instanceof SessiongraphError && error.code === 'SESSIONGRAPH_UNAVAILABLE') {
      return {
        operation: 'status',
        indexed: false,
        index_path: join(indexRoot, INDEX_RELATIVE_PATH),
        sessions: 0,
        entries: 0,
        workspaces: 0,
        live_sessions: 0,
        bytes: 0,
      }
    }
    throw error
  }
}

/**
 * Translate a seam failure into something a model can act on. A `SESSIONGRAPH_UNAVAILABLE` on a query
 * means the index has never been built — the raw "no store indexes this root" wording reads like a
 * broken installation, while the actionable answer is one tool call away.
 * @param error - whatever the seam threw.
 * @param indexRoot - absolute directory the index lives in.
 * @returns the error to throw: a clearer one, or the original when it needs no translation.
 */
function explainQueryFailure(error: unknown, indexRoot: string): unknown {
  if (!(error instanceof SessiongraphError)) return error
  switch (error.code) {
    case 'SESSIONGRAPH_UNAVAILABLE':
      return new SessiongraphError(
        `还没有索引（${indexRoot}），请先调用 sessiongraph_index 建一次；建好之前除 status 外的查询都会失败。`,
        error.code,
      )
    case 'SESSIONGRAPH_NOT_FOUND':
      return new SessiongraphError(
        `索引里没有这个会话（${error.message}）。先用 search 或 timeline 找到正确的 id。`,
        error.code,
      )
    case 'SESSIONGRAPH_CORRUPT':
      return new SessiongraphError(
        `${error.message}。索引文件损坏或版本不认识，用 sessiongraph_index 的 force 重建。`,
        error.code,
      )
    default:
      return error
  }
}

/**
 * Build or refresh the on-disk index. The dedicated tool this backs carries its own, much larger
 * timeout budget than a query — indexing every session on the machine is a different order of work.
 * @param ctx - the plugin context.
 * @param indexRoot - absolute directory the index lives in.
 * @param args - the index tool's validated arguments.
 * @param exec - the tool-execution context.
 * @returns the index operation's canonical value.
 */
async function runIndex(
  ctx: Context,
  indexRoot: string,
  args: SessiongraphIndexToolArgs,
  exec: ToolExecution,
): Promise<SessiongraphValueFor<'index'>> {
  // The owning session id is a runtime extension of the seam's options, not part of its type: a
  // job-capable indexer hands a large run to the host's job registry only when the caller names an
  // owner, and this is the one call site that should allow it. Every indexer that does not read it
  // simply runs in place, which is why this stays a plain optional property rather than a seam edit.
  const options: SessiongraphIndexOptions & { readonly owner?: string } = {
    ...(args.force === undefined ? {} : { force: args.force }),
    ...(args.workspace === undefined ? {} : { workspace: args.workspace }),
    ...(args.session_id === undefined ? {} : { sessionId: args.session_id }),
    ...(exec.agent === undefined ? {} : { owner: exec.agent.id }),
  }
  try {
    const report = await ctx.sessiongraph.index(indexRoot, options, exec.signal)
    // The seam types `index()` as returning a report, so a delegated run comes back as a report
    // carrying `jobId`; the indexer's own guard is the one place that distinction is defined.
    return isBackgroundIndexReport(report) ? projectIndexStarted(report) : projectIndexReport(report)
  } catch (error) {
    if (error instanceof SessiongraphError && error.code === 'SESSIONGRAPH_UNAVAILABLE') {
      throw new SessiongraphError(
        `没有可用的 sessiongraph 索引器（${error.message}）：indexer 插件可能没装，或不能写 ${indexRoot}。`,
        error.code,
      )
    }
    throw error
  }
}

/**
 * Project one seam result into the model-facing value its operation declares.
 * @param result - the seam's answer.
 * @param stale - whether the answer may predate the conversation because the refresh did not finish.
 * @returns the canonical value for that operation.
 */
function projectResult(result: SessiongraphResult, stale: boolean): SessiongraphToolValue {
  switch (result.operation) {
    case 'search': return projectSearch(result, stale)
    case 'session': return projectSession(result, stale)
    case 'timeline': return projectTimeline(result, stale)
    case 'workspaces': return projectWorkspaces(result, stale)
    case 'status': return projectStatus(result)
  }
}

/** The optional staleness marker, present only when the answer could be behind the conversation. */
function staleField(stale: boolean): { stale?: true } {
  return stale ? { stale: true } : {}
}

/**
 * Project a search answer, dropping the optional fields the seam leaves `undefined` instead of
 * emitting a JSON null the output schema would reject.
 * @param result - the seam's answer.
 * @param stale - whether the answer may be behind the conversation.
 * @returns the canonical `search` value.
 */
function projectSearch(result: SessiongraphSearchResult, stale: boolean): SessiongraphValueFor<'search'> {
  return {
    operation: 'search',
    hits: result.hits.map(hit => ({
      session_id: hit.sessionId,
      ...(hit.title === undefined ? {} : { title: hit.title }),
      workspace: hit.workspace,
      time: hit.time,
      kind: hit.kind,
      seq: hit.seq,
      ...(hit.turn === undefined ? {} : { turn: hit.turn }),
      snippet: hit.snippet,
      length: hit.length,
    })),
    total: result.total,
    truncated: result.truncated,
    ...staleField(stale),
  }
}

/**
 * Project a session answer.
 * @param result - the seam's answer.
 * @param stale - whether the answer may be behind the conversation.
 * @returns the canonical `session` value.
 */
function projectSession(result: SessiongraphSessionResult, stale: boolean): SessiongraphValueFor<'session'> {
  return {
    operation: 'session',
    session: projectSummary(result.session),
    entries: result.entries.map(entry => ({
      seq: entry.seq,
      time: entry.time,
      kind: entry.kind,
      ...(entry.turn === undefined ? {} : { turn: entry.turn }),
      text: entry.text,
      clipped: entry.clipped,
    })),
    children: [...result.children],
    truncated: result.truncated,
    ...staleField(stale),
  }
}

/**
 * Project a timeline answer.
 * @param result - the seam's answer.
 * @param stale - whether the answer may be behind the conversation.
 * @returns the canonical `timeline` value.
 */
function projectTimeline(result: SessiongraphTimelineResult, stale: boolean): SessiongraphValueFor<'timeline'> {
  return {
    operation: 'timeline',
    sessions: result.sessions.map(session => projectSummary(session)),
    truncated: result.truncated,
    ...staleField(stale),
  }
}

/**
 * Project a workspaces answer.
 * @param result - the seam's answer.
 * @param stale - whether the answer may be behind the conversation.
 * @returns the canonical `workspaces` value.
 */
function projectWorkspaces(result: SessiongraphWorkspacesResult, stale: boolean): SessiongraphValueFor<'workspaces'> {
  return {
    operation: 'workspaces',
    workspaces: result.workspaces.map(workspace => ({
      workspace: workspace.workspace,
      sessions: workspace.sessions,
      entries: workspace.entries,
      first_at: workspace.firstAt,
      last_at: workspace.lastAt,
    })),
    total: result.total,
    ...staleField(stale),
  }
}

/**
 * Project a status answer.
 * @param result - the seam's answer.
 * @returns the canonical `status` value.
 */
function projectStatus(result: SessiongraphStatusResult): SessiongraphValueFor<'status'> {
  return {
    operation: 'status',
    indexed: result.indexed,
    index_path: result.indexPath,
    sessions: result.sessions,
    entries: result.entries,
    workspaces: result.workspaces,
    live_sessions: result.liveSessions ?? 0,
    ...(result.indexedAt === undefined ? {} : { indexed_at: result.indexedAt }),
    bytes: result.bytes,
  }
}

/**
 * Project one session's metadata.
 * @param summary - the seam's summary.
 * @returns the model-facing session object.
 */
function projectSummary(summary: SessiongraphSessionSummary): SessiongraphValueFor<'session'>['session'] {
  return {
    session_id: summary.sessionId,
    ...(summary.title === undefined ? {} : { title: summary.title }),
    workspace: summary.workspace,
    created_at: summary.createdAt,
    last_at: summary.lastAt,
    turns: summary.turns,
    entries: summary.entries,
    ...(summary.parentSession === undefined ? {} : { parent_session: summary.parentSession }),
    ...(summary.origin === undefined ? {} : { origin: summary.origin }),
    ...(summary.agentPreset === undefined ? {} : { agent_preset: summary.agentPreset }),
  }
}

/**
 * Project one finished index run.
 * @param report - the indexer's report.
 * @returns the canonical `index` value.
 */
function projectIndexReport(report: SessiongraphIndexReport): SessiongraphValueFor<'index'> {
  return {
    operation: 'index',
    index_path: report.indexPath,
    added: report.added,
    updated: report.updated,
    skipped: report.skipped,
    removed: report.removed,
    discovered: report.discovered,
    failed: report.failed.map(entry => ({ path: entry.path, reason: entry.reason })),
    live_sessions: report.liveSessions ?? 0,
    entries: report.entries,
    sessions: report.sessions,
    workspaces: report.workspaces,
    bytes: report.bytes,
    elapsed_ms: report.elapsedMs,
  }
}

/**
 * Project one delegated index run: the call started a job and has no report of its own.
 * @param report - the indexer's background report.
 * @returns the canonical `index` value's started member.
 */
function projectIndexStarted(report: SessiongraphBackgroundIndexReport): SessiongraphValueFor<'index'> {
  return { operation: 'index', status: 'started', job_id: report.jobId }
}

/**
 * Expand a configured index root: a leading `~` becomes the home directory, and a relative path is
 * resolved against the process working directory so the value handed to the seam is always absolute.
 * @param path - the configured path.
 * @returns the absolute path.
 */
function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return isAbsolute(path) ? path : resolve(path)
}

/** Reject a non-positive-integer config value at load, so misconfiguration fails loud. */
function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-sessiongraph: ${field} must be a positive integer`)
  }
}

/** Reject a config value that must be a whole number but may legitimately be zero (0 = disabled). */
function assertNonNegativeInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`tool-sessiongraph: ${field} must be a non-negative integer`)
  }
}

/** Reject a timer value Node would clamp instead of scheduling as configured. */
function assertTimer(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`tool-sessiongraph: ${field} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}
