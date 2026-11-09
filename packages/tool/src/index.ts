/**
 * The model-facing `sessiongraph` tool over `ctx.sessiongraph`: one tool, eight operations.
 *
 * Seven of them are the seam's read operations — `search`, `session`, `event`, `trace`, `timeline`,
 * `workspaces`, `status` — answered from a pre-built index of every local conversation (and, for
 * `event`, from the source log itself). The eighth, `index`, is a write: it routes to
 * `ctx.sessiongraph.index()` rather than pretending a query provider can build an index.
 *
 * One tool rather than two because a tool definition costs permanent schema tokens, and the host's
 * `timeoutMs` is fixed per registration, not per call. The old split existed only so indexing could
 * carry a three-hundred-second budget; that is now solved by measurement instead — a run on an index
 * whose sidecar already reports `backgroundIndexThreshold` sessions is handed to the host's job
 * registry through `ctx.jobs.start`, and the call answers at once with a job id. Everything else
 * runs inside the one thirty-second budget.
 *
 * The tool owns every default the seam refuses to guess — the per-operation result limits, the cap on
 * a snippet, the background threshold — so the seam's requests stay fully specified and a deployment
 * can retune what the model reads without touching a store. It injects only `tools`, `sessiongraph`,
 * and `systemPrompt`, and imports no store: which index answers is the seam's routing decision.
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
  SessiongraphEventResult,
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
  SessiongraphTraceNode,
  SessiongraphTraceResult,
  SessiongraphWorkspacesResult,
} from 'dsh-plugin-sessiongraph-service'
import {
  AUTO_INDEX_JOB_KIND,
  DEFAULT_BACKGROUND_INDEX_THRESHOLD as SESSIONS_BACKGROUND_INDEX_THRESHOLD,
  isBackgroundIndexReport,
} from 'dsh-plugin-sessiongraph-sessions'
import type { SessiongraphBackgroundIndexReport } from 'dsh-plugin-sessiongraph-sessions'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { registerCommands } from './command.ts'
import { applyPanel } from './panel.ts'
import { LazyIndexRefresher } from './refresh.ts'
import type { SynchronousIndexOptions } from './refresh.ts'
import { renderSessiongraph } from './render.ts'
import type { RenderOptions } from './render.ts'
import {
  SESSIONGRAPH_DEFAULT_LIMITS,
  SESSIONGRAPH_OUTPUT_SCHEMA,
  SESSIONGRAPH_PARAMETERS,
} from './schema.ts'
import type {
  SessiongraphToolArgs,
  SessiongraphToolOperation,
  SessiongraphToolValue,
  SessiongraphValueFor,
} from './schema.ts'
import { agentIdOf, indexStatusHint, readIndexStatus } from './status-hint.ts'
import { createUpdateChecker, defaultStateFile, DEFAULT_UPDATE_CHECK_INTERVAL_MS, readOwnVersion } from './version-check.ts'
import type { UpdateChecker } from './version-check.ts'
import { createHistoryHintState, noteHistoryToolUse, registerHistoryHint } from './history-hint.ts'
import { applyVisibility } from './visibility.ts'

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
  SESSIONGRAPH_OPERATIONS,
  SESSIONGRAPH_OUTPUT_SCHEMA,
  SESSIONGRAPH_PARAMETERS,
  SESSIONGRAPH_TOOL_OPERATIONS,
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

/** The npm package this code ships as; the registry is asked about this name's own releases. */
export const PACKAGE_NAME = 'dsh-plugin-sessiongraph'

/** Services required by this plugin. */
export const inject = ['tools', 'sessiongraph', 'systemPrompt']

/** Default directory the index lives in, before `~` expansion. */
export const DEFAULT_INDEX_ROOT = '~/.dsh/sessiongraph'

/** Tool-call timeout budget (ms) for the one `sessiongraph` tool. */
export const DEFAULT_SESSIONGRAPH_TOOL_TIMEOUT_MS = 30_000

/** Largest `limit` honored when the plugin config names none. */
export const DEFAULT_MAX_LIMIT = 100

/** Default character cap for one rendered snippet or session entry. */
export const DEFAULT_MAX_SNIPPET_CHARS = 600

/**
 * Index size (sessions) at or above which an `index` call is handed to the host's job registry
 * instead of running inside the tool's thirty-second budget.
 *
 * Measured off the sidecar the previous run wrote: it describes what the index actually holds, which
 * is the run's real size once an index exists. A root with no sidecar runs in place — a first build
 * has nothing to measure, and the model explicitly asked for it.
 */
// Sourced from the package that also uses the same number for its own automatic refresh, so the two
// decisions can never drift into "the tool backgrounded it, the indexer did not".
export const DEFAULT_BACKGROUND_INDEX_THRESHOLD = SESSIONS_BACKGROUND_INDEX_THRESHOLD

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
  + '手上的摘要不是证据：要引用具体说过什么、跑过什么命令，就在这里查原文。'
  + '索引同时含两个 agent 的历史：本宿主的 DSH 会话与 OpenAI Codex 的 rollout 日志，'
  + '每条结果带 source（dsh / codex），需要只看一侧时给 search / timeline / workspaces 传 source。'
  + 'sessiongraph 从预建索引回答：search 跨会话全文检索（中文按双字切分，两字词即可命中，如「广告」）、'
  + 'session 按 id 或唯一前缀打开一个会话、event 读某一条原始事件（可带前后窗口）、'
  + 'trace 追会话血缘或事件的替换/引用关系、timeline 按时间列会话、workspaces 列工作区统计。'
  + '索引超过几分钟没更新时，查询前会自动跑一次增量刷新（很快，失败也照常回答，只是结果可能少几条）。'
  + '索引包含正在进行的会话，所以刚才说的话通常也能查到（取决于上次刷新时间）；status 里的实时会话数会随会话启停变化，不是索引坏了。'
  + '索引不存在时 status 仍能回答，其它操作会失败；要建或全量重建用 operation=index（可带 force），'
  + '日志很多时它会转成后台 job 并返回 jobId，用 job_output 取报告。'

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
  /**
   * Feed `/sessiongraph` command results back into the session as a plugin message (default false).
   * Off by default: calling `agent.inject` from inside a command handler drags the agent loop onto
   * the host's main thread, and `/sessiongraph status` was observed to hang the desktop shell that
   * way. Set true only if you want the model to see what you just searched.
   */
  injectCommandResults?: boolean
  /** Tool-call timeout budget in ms for the one `sessiongraph` tool (default 30000). */
  timeoutMs?: number
  /**
   * Session count at or above which an `index` call becomes a host background job (default 1000).
   * Below it the run happens inside the tool's own timeout budget, so a small or first-time index
   * still answers with its report in the same turn.
   */
  backgroundIndexThreshold?: number
  /**
   * Which session-reading surface this profile exposes: this plugin's `sessiongraph` tool only
   * (`sessiongraph`, the default), the host's built-in kernel session tools only (`kernel`), or
   * both (`both`). Visibility is applied by `visibility.ts`, which hides or shows the kernel tools;
   * this plugin's own tool is always registered.
   */
  toolSet?: 'sessiongraph' | 'kernel' | 'both'
  /**
   * Whether to ask the registry for a newer release after this plugin's tool is used, and append one
   * notice to the next step when there is one (default true). The notice is a user-role message, so it
   * reaches the model and the user both; it is emitted once per release and never blocks a tool call.
   * Turn this off in an offline or air-gapped deployment, where the check can only time out.
   */
  updateCheck?: boolean
  /**
   * Milliseconds a completed check stays trusted before the next one may start (default six hours).
   * Shorter intervals mean a notice lands sooner after a release; the request itself is one small
   * registry GET, so the cost of a shorter interval is latency nobody waits on, not tokens.
   */
  updateCheckIntervalMs?: number
  /**
   * Append one reminder to the model request whose user input looks like a question about past
   * conversations, when that conversation has not used the index yet (default true). The system
   * prompt already says to use the index; this is the moment-of-use nudge for a model that has just
   * been handed a memory summary and would otherwise answer from it. Once per conversation, never
   * after the tool itself ran.
   */
  historyHint?: boolean
}

export const Config: z<Config> = z.object({
  indexRoot: z.string().default(DEFAULT_INDEX_ROOT),
  maxLimit: z.number().default(DEFAULT_MAX_LIMIT),
  maxSnippetChars: z.number().default(DEFAULT_MAX_SNIPPET_CHARS),
  freshnessThresholdMs: z.number().default(DEFAULT_FRESHNESS_THRESHOLD_MS),
  injectCommandResults: z.boolean().default(false),
  timeoutMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_SESSIONGRAPH_TOOL_TIMEOUT_MS),
  backgroundIndexThreshold: z.number().default(DEFAULT_BACKGROUND_INDEX_THRESHOLD),
  toolSet: z.union([z.const('sessiongraph'), z.const('kernel'), z.const('both')]).default('sessiongraph'),
  updateCheck: z.boolean().default(true),
  updateCheckIntervalMs: z.number().default(DEFAULT_UPDATE_CHECK_INTERVAL_MS),
  historyHint: z.boolean().default(true),
})

/** The config shape `apply` actually sees: every field defaulted by {@link Config}. */
export type ResolvedConfig = Required<Config>

/**
 * Register the one tool, the system-prompt guidance, the optional human surface, and the optional
 * visibility/panel wiring.
 * @param ctx - the plugin context (must inject `tools`, `sessiongraph`, `systemPrompt`).
 * @param config - the resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveInteger('maxLimit', resolved.maxLimit)
  assertPositiveInteger('maxSnippetChars', resolved.maxSnippetChars)
  assertNonNegativeInteger('freshnessThresholdMs', resolved.freshnessThresholdMs)
  assertNonNegativeInteger('backgroundIndexThreshold', resolved.backgroundIndexThreshold)
  assertTimer('timeoutMs', resolved.timeoutMs)
  if (resolved.indexRoot.trim() === '') {
    throw new Error('tool-sessiongraph: indexRoot must be a non-empty directory path')
  }
  const indexRoot = expandHome(resolved.indexRoot)
  const renderOptions: RenderOptions = { maxSnippetChars: resolved.maxSnippetChars }

  // Version checking is a convenience, never a dependency: turned off, or with an unreachable
  // registry, the tool behaves exactly as before. It only ever speaks after the tool ran — see
  // `version-check.ts` for why that gate exists and what keeps it from repeating.
  const updateChecker = resolved.updateCheck
    ? createUpdateChecker({
        packageName: PACKAGE_NAME,
        currentVersion: readOwnVersion(),
        stateFile: defaultStateFile(PACKAGE_NAME),
        intervalMs: resolved.updateCheckIntervalMs,
      })
    : undefined

  // Process-local, one instance per registration: a second query in this process joins the run in
  // flight instead of starting a second incremental index. The `index` operation never goes through
  // it — an explicit refresh is asked for, not decided by a clock.
  const refresher = new LazyIndexRefresher({
    indexRoot,
    freshnessThresholdMs: resolved.freshnessThresholdMs,
    index: (options: SynchronousIndexOptions, signal?: AbortSignal) =>
      ctx.sessiongraph.index(indexRoot, options, signal),
  })

  // Shared between the tool and the pre-step hook: a conversation that already reached the index must
  // not be told the index exists. Kept even when the hint is off, so turning the reminder back on
  // mid-process cannot re-nag a conversation that has been using the tool all along.
  const historyHintState = createHistoryHintState()

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
      '检索本机全部 agent 会话的历史对话（不是代码）：DSH 自己的会话与 OpenAI Codex 的 rollout 日志索引在同一处，'
      + '结果带 source（dsh / codex）可按来源过滤。省略 operation 即 search（默认），只传 query 就能跨会话检索。'
      + '跨会话全文搜索「上次在哪个会话里说过/做过什么」、按 id 打开一个会话、'
      + '读某一条原始事件、追踪会话血缘或事件的替换/引用关系、按时间列会话、列工作区统计、看索引状态、建/刷新索引。'
      + '答案来自预建索引，比 grep ~/.dsh/sessions 更快也更完整（那里的 JSONL 是 zstd 压缩的，grep 读不到）。'
      + '中文按两字词检索即可命中（如「广告」）。索引不存在时除 status 外都会失败，先跑 operation=index；'
      + '日志很多时 index 会转成后台 job 返回 jobId，用 job_output 取报告。',
    parameters: SESSIONGRAPH_PARAMETERS,
    output: {
      schema: SESSIONGRAPH_OUTPUT_SCHEMA,
      render: (args, value) => [{ type: 'text', text: renderSessiongraph(args, value, renderOptions) }],
    },
    timeoutMs: resolved.timeoutMs,
    async execute(args, exec) {
      updateChecker?.noteToolUse(agentIdOf(exec))
      noteHistoryToolUse(historyHintState, exec)
      return runOperation(ctx, refresher, indexRoot, resolved, args, exec)
    },
    presentCall: args => ({
      card: 'generic' as const,
      title: callTitle(args),
      kind: operationOf(args) === 'index' ? 'execute' as const : 'search' as const,
      rawInput: args,
    }),
  }))

  // The human surface is optional: `ctx.inject` waits for the command registry when the host has
  // one and silently does nothing when it does not, so a composition without it still gets the tool.
  // Registered last so nothing about the model-facing surface depends on it.
  registerCommands(ctx, {
    indexRoot,
    maxSnippetChars: resolved.maxSnippetChars,
    injectResults: resolved.injectCommandResults,
  })

  // Which session-reading surface this profile exposes (this tool, the kernel's tools, or both).
  // Both helpers are optional-by-construction: they do nothing when the services they speak to are
  // absent, so a minimal composition still loads.
  applyVisibility(ctx, resolved)
  applyPanel(ctx, resolved)

  // The notice rides the host's step-admission waterfall: `agent/pre-step` is the one surface a
  // plugin has between a tool result and the next model request, and it is where the host itself
  // inserts its `[model changed: …]` notice. Registering it here (rather than at module scope) keeps
  // the listener tied to this plugin instance's lifetime.
  if (updateChecker !== undefined) registerUpdateNotice(ctx, updateChecker)

  // The history reminder rides the same waterfall: `agent/pre-step` is the one surface between the
  // user's input and the next model request, which is exactly where "this looks like a question about
  // the past, and no summary is allowed to be the evidence" belongs. Registered here for the same
  // lifetime reason as the notice above.
  if (resolved.historyHint) registerHistoryHint(ctx, historyHintState)
}

/**
 * Structural face of the agent lifecycle this plugin listens to.
 *
 * Declared locally rather than by importing the agent package: this module needs two event names and
 * two payload shapes, not the whole agent surface, and a static import of a host symbol is exactly
 * what took this plugin's sibling off the host once before.
 */
interface AgentLifecycleContext {
  on(name: 'agent/created', listener: (payload: AgentCreatedPayload) => void): () => boolean
}

/** The agent-created payload: the agent, and the scoped context its own hooks register on. */
interface AgentCreatedPayload {
  readonly agent?: {
    readonly id?: unknown
    /** The agent's scope. Registrations on it live and die with this agent. */
    readonly ctx?: AgentScopedContext
  }
}

/**
 * The per-agent context, whose `agent/pre-step` waterfall runs before every model request.
 *
 * `prepend` puts the listener first in the chain; the host's own `[model changed: …]` notice registers
 * the same way, which is why this shape is copied rather than invented.
 */
interface AgentScopedContext {
  on(
    name: 'agent/pre-step',
    listener: (payload: AgentPreStepPayload, next: () => Promise<AgentPreStepDecision>) => Promise<AgentPreStepDecision>,
    options?: { prepend?: boolean },
  ): () => boolean
}

/** What the host passes into the waterfall; only the agent identity is read here. */
interface AgentPreStepPayload {
  readonly agent?: { readonly id?: unknown }
  readonly signal?: AbortSignal
}

/**
 * The admitted-step decision. `reject` carries no messages and must be passed through untouched;
 * `enter` carries the batch that will be sent, which this plugin appends to.
 */
interface AgentPreStepDecision {
  readonly kind: string
  readonly messages: readonly unknown[]
}

/**
 * The slice of the host's background-job registry this tool calls.
 *
 * `@deepseek-ai/dsh-jobs` is deliberately not a dependency: the service is optional, and its absence
 * simply means a large index run happens inside the tool's budget instead. The shape is structural,
 * exactly as `packages/sessions` declares it, because the same registry backs both call sites.
 */
interface BackgroundJobRegistry {
  /**
   * Register a job and return its id immediately.
   * @param spec - the job's owner, kind, label, and producer body.
   * @returns the new job's id.
   */
  start(spec: BackgroundJobSpec): string
}

/** One index job's registration. */
interface BackgroundJobSpec {
  /** Session id of the agent that owns the job; its disposal cancels the work. */
  readonly owner: string
  /** Stable kind, used for retention and diagnostics. */
  readonly kind: string
  /** Human-readable label shown in job listings and completion notices. */
  readonly label: string
  /** The producer body, invoked once while the registration is being built. */
  readonly run: (handle: BackgroundJobHandle) => BackgroundJobHooks
}

/** What a producer may write while its job runs. */
interface BackgroundJobHandle {
  /**
   * Append one chunk of output to the job's log.
   * @param text - the text to append, verbatim.
   */
  append(text: string): void
}

/** What a producer hands back so the registry can stop and await it. */
interface BackgroundJobHooks {
  /**
   * Stop the work.
   * @param reason - why the job was stopped, when the caller has a reason.
   */
  cancel(reason?: string): void
  /** Settles once the producer is done, carrying the job's terminal outcome. */
  readonly done: Promise<BackgroundJobOutcome>
}

/** The terminal report a producer settles with. */
interface BackgroundJobOutcome {
  /** Terminal status the registry records. */
  readonly status: 'completed' | 'failed'
  /** Failure detail, when the job failed. */
  readonly detail?: string
}

/**
 * Append the "a newer release exists" notice to the next admitted step, once per release.
 *
 * Registered per agent rather than globally: the hook is agent-scoped in the host, its `next` only
 * means something inside that scope, and one registration per conversation is what keeps a notice
 * out of a session that never called the tool.
 * @param ctx - the plugin context.
 * @param checker - the shared checker the tool calls already report into.
 */
export function registerUpdateNotice(ctx: Context, checker: UpdateChecker): void {
  const events = ctx as unknown as AgentLifecycleContext
  // Registered inside this effect so the subscription follows the plugin's own lifetime: unloading
  // the plugin must stop future agents from calling into a checker that no longer exists.
  ctx.effect(() => events.on('agent/created', payload => {
    const agentCtx = payload.agent?.ctx
    if (agentCtx === undefined) return
    const agentId = agentIdOf(payload)
    agentCtx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      // A rejected step sends nothing, so there is no conversation to put a notice into.
      if (decision.kind !== 'enter') return decision
      const notice = checker.takeNotice(agentId)
      if (notice === undefined) return decision
      return { ...decision, messages: [...decision.messages, notice] }
    })
  }))
}

/**
 * The operation a call runs: the one the model named, or `search` when it named none.
 *
 * `operation` is optional on purpose. The overwhelmingly common call is a plain cross-session
 * search, and making the model restate that costs one decision per call (plus an enum retry when it
 * forgets). The default lives here and nowhere else: every entry point — `presentCall`,
 * `buildRequest`, `runOperation` — narrows through this function instead of testing `undefined`
 * per case.
 * @param args - the validated tool arguments, possibly without an explicit operation.
 * @returns the operation to run; never `undefined`.
 */
export function operationOf(args: SessiongraphToolArgs): SessiongraphToolOperation {
  return args.operation ?? 'search'
}

/**
 * The one-line label a pending call shows.
 * @param args - the validated tool arguments.
 * @returns the card title naming the operation and whichever subject the operation takes.
 */
export function callTitle(args: SessiongraphToolArgs): string {
  const operation = operationOf(args)
  const subject = args.query ?? args.session_id ?? args.workspace
  const seq = args.seq === undefined ? '' : ` #${String(Math.trunc(args.seq))}`
  return subject === undefined
    ? `sessiongraph ${operation}${seq}`
    : `sessiongraph ${operation}${seq} ${subject}`
}

/**
 * Turn the model's snake_case arguments into the seam's camelCase request, applying the per-operation
 * defaults the seam refuses to guess. An omitted `operation` means `search` (see {@link operationOf}),
 * so a call that names only `query` builds the ordinary search request.
 *
 * Conditional requirements live here rather than in the parameter schema, because the parameter DSL
 * has no per-operation conditionals: `search` needs `query`, `session`/`event`/`trace` need
 * `session_id`, and `event` needs `seq`; a call missing one is rejected before it can reach a store.
 * The `index` operation is not built here at all: it is a write, and `runIndexOperation` owns it.
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
  const operation = operationOf(args)
  switch (operation) {
    case 'search': {
      const sessionId = optionalString(args.session_id)
      return {
        operation: 'search',
        indexRoot,
        query: required(args, 'query', 'search'),
        ...(args.workspace === undefined ? {} : { workspace: args.workspace }),
        ...(args.source === undefined ? {} : { source: args.source }),
        ...(args.after === undefined ? {} : { after: timestamp('after', args.after) }),
        ...(args.before === undefined ? {} : { before: timestamp('before', args.before) }),
        ...(args.kinds === undefined || args.kinds.length === 0 ? {} : { kinds: args.kinds }),
        ...(sessionId === undefined ? {} : { sessionId }),
        // One hit per session is the useful default across conversations; inside one session it
        // would answer with a single line, which is never what "search this conversation" means.
        dedupeBySession: args.dedupe_by_session ?? sessionId === undefined,
        limit: bounded(args.limit, SESSIONGRAPH_DEFAULT_LIMITS.search, maxLimit),
        ...(offset === undefined ? {} : { offset }),
      }
    }
    case 'session':
      return {
        operation: 'session',
        indexRoot,
        sessionId: required(args, 'session_id', 'session'),
        limit: bounded(args.limit, SESSIONGRAPH_DEFAULT_LIMITS.session, maxLimit),
        ...(offset === undefined ? {} : { offset }),
      }
    case 'event': {
      const windowBefore = windowCount('window_before', args.window_before)
      const windowAfter = windowCount('window_after', args.window_after)
      return {
        operation: 'event',
        indexRoot,
        sessionId: required(args, 'session_id', 'event'),
        seq: requiredSeq(args, 'event'),
        ...(windowBefore === undefined ? {} : { windowBefore }),
        ...(windowAfter === undefined ? {} : { windowAfter }),
      }
    }
    case 'trace': {
      const eventSeq = optionalSeq(args)
      const depth = windowCount('depth', args.depth)
      return {
        operation: 'trace',
        indexRoot,
        sessionId: required(args, 'session_id', 'trace'),
        ...(eventSeq === undefined ? {} : { seq: eventSeq }),
        ...(depth === undefined ? {} : { depth }),
      }
    }
    case 'timeline':
      return {
        operation: 'timeline',
        indexRoot,
        ...(args.workspace === undefined ? {} : { workspace: args.workspace }),
        ...(args.source === undefined ? {} : { source: args.source }),
        ...(args.after === undefined ? {} : { after: timestamp('after', args.after) }),
        ...(args.before === undefined ? {} : { before: timestamp('before', args.before) }),
        limit: bounded(args.limit, SESSIONGRAPH_DEFAULT_LIMITS.timeline, maxLimit),
        ...(offset === undefined ? {} : { offset }),
      }
    case 'workspaces':
      return {
        operation: 'workspaces',
        indexRoot,
        ...(args.source === undefined ? {} : { source: args.source }),
        limit: bounded(args.limit, SESSIONGRAPH_DEFAULT_LIMITS.workspaces, maxLimit),
        ...(offset === undefined ? {} : { offset }),
      }
    case 'status':
      return { operation: 'status', indexRoot }
    /* v8 ignore next 4 -- `index` never reaches the query path, and the rest is exhaustive over the
       parameter schema's closed operation enum. */
    default:
      throw new SessiongraphError(
        `unknown sessiongraph operation ${JSON.stringify(operation)}`,
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
 * Read a required event sequence number.
 * @param args - the validated tool arguments.
 * @param operation - the operation being built, named in the failure.
 * @returns the non-negative integer seq.
 */
function requiredSeq(args: SessiongraphToolArgs, operation: string): number {
  const seq = optionalSeq(args)
  if (seq === undefined) {
    throw new SessiongraphError(
      `the sessiongraph "${operation}" operation requires a numeric "seq"`,
      'SESSIONGRAPH_INVALID_REQUEST',
    )
  }
  return seq
}

/**
 * Read an optional event sequence number, dropping values that cannot name one.
 * @param args - the validated tool arguments.
 * @returns the non-negative integer seq, or `undefined` when absent.
 */
function optionalSeq(args: SessiongraphToolArgs): number | undefined {
  if (args.seq === undefined) return undefined
  if (!Number.isFinite(args.seq)) {
    throw new SessiongraphError(
      'the sessiongraph "seq" argument must be a finite number',
      'SESSIONGRAPH_INVALID_REQUEST',
    )
  }
  return Math.max(0, Math.trunc(args.seq))
}

/**
 * Read an optional window or depth bound, rejecting a value that is not a finite number.
 * @param field - the argument name, named in the failure.
 * @param value - the model-supplied number.
 * @returns the non-negative integer, or `undefined` when absent.
 */
function windowCount(field: 'window_before' | 'window_after' | 'depth', value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value)) {
    throw new SessiongraphError(
      `the sessiongraph "${field}" argument must be a finite number`,
      'SESSIONGRAPH_INVALID_REQUEST',
    )
  }
  return Math.max(0, Math.trunc(value))
}

/**
 * Read an optional non-empty string argument.
 * @param value - the model-supplied string.
 * @returns the trimmed-non-empty value, or `undefined` when the model named none.
 */
function optionalString(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined
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
 * Answer one call: the `index` write, the `status` self-description, or an index-backed query.
 * @param ctx - the plugin context.
 * @param refresher - the process-local lazy refresh coordinator for this index root.
 * @param indexRoot - absolute directory the index lives in.
 * @param config - the resolved plugin configuration.
 * @param args - the validated tool arguments.
 * @param exec - the tool-execution context.
 * @returns the canonical value for the requested operation.
 */
async function runOperation(
  ctx: Context,
  refresher: LazyIndexRefresher,
  indexRoot: string,
  config: ResolvedConfig,
  args: SessiongraphToolArgs,
  exec: ToolExecution,
): Promise<SessiongraphToolValue> {
  // One normalization for the whole call: an omitted operation is a search, and every branch below
  // (as well as `buildRequest`) sees the resolved name rather than `undefined`.
  const operation = operationOf(args)
  if (operation === 'index') return runIndexOperation(ctx, indexRoot, config, args, exec)
  // `status` describes the index itself; refreshing first would make it report a state it just
  // changed, and the model uses it to decide whether to call `index` at all.
  if (operation === 'status') return statusValue(ctx, indexRoot, exec.signal)
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
      await ctx.sessiongraph.index(indexRoot, { force: true }, exec.signal)
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
 * broken installation, while the actionable answer is one operation away.
 * @param error - whatever the seam threw.
 * @param indexRoot - absolute directory the index lives in.
 * @returns the error to throw: a clearer one, or the original when it needs no translation.
 */
function explainQueryFailure(error: unknown, indexRoot: string): unknown {
  if (!(error instanceof SessiongraphError)) return error
  switch (error.code) {
    case 'SESSIONGRAPH_UNAVAILABLE':
      return new SessiongraphError(
        `还没有索引（${indexRoot}），请先调用 sessiongraph 的 index 操作建一次；建好之前除 status 外的操作都会失败。`,
        error.code,
      )
    case 'SESSIONGRAPH_NOT_FOUND':
      return new SessiongraphError(
        `索引里没有这个会话（${error.message}）。先用 search 或 timeline 找到正确的 id。`,
        error.code,
      )
    case 'SESSIONGRAPH_CORRUPT':
      return new SessiongraphError(
        `${error.message}。索引文件损坏或版本不认识，用 index 操作的 force 重建。`,
        error.code,
      )
    default:
      return error
  }
}

/**
 * Build or refresh the on-disk index.
 *
 * A large index is not answered inside a tool budget: when the sidecar says the index already holds
 * `backgroundIndexThreshold` sessions, the run goes to the host's job registry and this call returns
 * with a job id, which `job_output` later turns into the report. Every reason not to start a job —
 * no registry, no owning session, a scoped run, a small index — falls back to running in place, so a
 * first build still answers with its counts instead of costing a second round trip.
 * @param ctx - the plugin context.
 * @param indexRoot - absolute directory the index lives in.
 * @param config - the resolved plugin configuration.
 * @param args - the validated tool arguments.
 * @param exec - the tool-execution context.
 * @returns the index operation's canonical value.
 */
async function runIndexOperation(
  ctx: Context,
  indexRoot: string,
  config: ResolvedConfig,
  args: SessiongraphToolArgs,
  exec: ToolExecution,
): Promise<SessiongraphValueFor<'index'>> {
  const options: SessiongraphIndexOptions = {
    ...(args.force === undefined ? {} : { force: args.force }),
    ...(args.workspace === undefined ? {} : { workspace: args.workspace }),
    ...(args.session_id === undefined ? {} : { sessionId: args.session_id }),
  }
  const owner = agentIdOf(exec)
  if (owner !== undefined && shouldRunInBackground(indexRoot, config, options)) {
    const jobId = startIndexJob(ctx, indexRoot, options, owner)
    if (jobId !== undefined) return { operation: 'index', status: 'started', job_id: jobId }
  }
  try {
    const report = await ctx.sessiongraph.index(indexRoot, options, exec.signal)
    // An indexer may still delegate a run on its own (the sessions indexer does when it is handed an
    // owner, which this call never does); a report carrying a job id is that escape hatch, not a
    // finished run, and must not be rendered as one.
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
 * Whether an index run is large enough to outlive a tool call.
 *
 * The sidecar is the measure, not the source file count: it describes what the index actually holds,
 * which is the run's real size once one exists, and it is one synchronous file read — the same one
 * prompt assembly already does. A root with no sidecar (a first build) runs in place. A scoped run
 * touches one workspace or one session, so the round trip through `job_output` would cost more than
 * the run itself.
 * @param indexRoot - absolute directory the index lives in.
 * @param config - the resolved plugin configuration.
 * @param options - this call's index switches.
 * @returns true when the run should be delegated to the host's job registry.
 */
function shouldRunInBackground(
  indexRoot: string,
  config: ResolvedConfig,
  options: SessiongraphIndexOptions,
): boolean {
  if (options.workspace !== undefined || options.sessionId !== undefined) return false
  const sessions = readIndexStatus(indexRoot)?.sessions
  return sessions !== undefined && sessions >= config.backgroundIndexThreshold
}

/**
 * Hand one index run to the host's background-job registry.
 * @param ctx - the plugin context, consulted for the optional registry.
 * @param indexRoot - absolute directory the index lives in.
 * @param options - this call's index switches.
 * @param owner - the owning session id, without which no job can be registered.
 * @returns the started job's id, or `undefined` when this call must index in place.
 */
function startIndexJob(
  ctx: Context,
  indexRoot: string,
  options: SessiongraphIndexOptions,
  owner: string,
): string | undefined {
  try {
    const jobs = ctx.get('jobs') as BackgroundJobRegistry | undefined
    if (jobs === undefined) return undefined
    return jobs.start({
      owner,
      kind: AUTO_INDEX_JOB_KIND,
      label: `sessiongraph index ${indexRoot}`,
      run: handle => runIndexJob(ctx, indexRoot, options, handle),
    })
  } catch {
    // No controller serves this session, or the owner already holds its maximum number of jobs: both
    // mean "do the work here instead", never "fail the model's call".
    return undefined
  }
}

/**
 * The producer body of one index job: run the index synchronously, report its summary into the job's
 * log, and settle the job with the outcome the registry records.
 * @param ctx - the plugin context.
 * @param indexRoot - absolute directory the index lives in.
 * @param options - this call's index switches.
 * @param handle - the job handle, for appending output.
 * @returns the job's cancellation hook and settlement.
 */
function runIndexJob(
  ctx: Context,
  indexRoot: string,
  options: SessiongraphIndexOptions,
  handle: BackgroundJobHandle,
): BackgroundJobHooks {
  const controller = new AbortController()
  const done = (async (): Promise<BackgroundJobOutcome> => {
    try {
      // Deliberately not the caller's signal: a background run outlives the call that started it, so
      // aborting that call must not abort the job. The job's own cancel does.
      const report = await ctx.sessiongraph.index(indexRoot, options, controller.signal)
      handle.append(
        `Indexed ${indexRoot}: ${report.sessions} sessions, ${report.entries} entries `
        + `(${report.added} added, ${report.updated} updated, ${report.removed} removed).\n`,
      )
      return { status: 'completed' }
    } catch (error) {
      const message = describeError(error)
      handle.append(`sessiongraph index failed for ${indexRoot}: ${message}\n`)
      return { status: 'failed', detail: message }
    }
  })()
  return { cancel: () => controller.abort(), done }
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
    case 'event': return projectEvent(result, stale)
    case 'trace': return projectTrace(result, stale)
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
      source: hit.source,
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
 * Project an event answer. The payload is passed through untouched: the whole point of this operation
 * is the original bytes, which the index's clipped text could never give back.
 * @param result - the seam's answer.
 * @param stale - whether the answer may be behind the conversation.
 * @returns the canonical `event` value.
 */
function projectEvent(result: SessiongraphEventResult, stale: boolean): SessiongraphValueFor<'event'> {
  return {
    operation: 'event',
    session: projectSummary(result.session),
    event: {
      seq: result.event.seq,
      time: result.event.time,
      type: result.event.type,
      // The seam types the payload as `unknown` on purpose (the log's vocabulary is `dsh-session`'s);
      // the output schema declares it as arbitrary JSON, so this cast is the one place the two
      // descriptions meet.
      data: result.event.data as SessiongraphValueFor<'event'>['event']['data'],
    },
    before: result.before.map(projectRawEventSummary),
    after: result.after.map(projectRawEventSummary),
    ...staleField(stale),
  }
}

/**
 * Project one raw event summary.
 * @param summary - the seam's summary.
 * @returns the model-facing event identity.
 */
function projectRawEventSummary(summary: SessiongraphEventResult['before'][number]): SessiongraphValueFor<'event'>['before'][number] {
  return { seq: summary.seq, time: summary.time, type: summary.type }
}

/**
 * Project a trace answer, flattening the seam's recursive descendant tree into depth-first entries.
 *
 * The output schema DSL has no `$ref`, so a recursive value type cannot be expressed; flattening keeps
 * every fact (order and distance) while still rendering as an indented tree.
 * @param result - the seam's answer.
 * @param stale - whether the answer may be behind the conversation.
 * @returns the canonical `trace` value.
 */
function projectTrace(result: SessiongraphTraceResult, stale: boolean): SessiongraphValueFor<'trace'> {
  if (result.kind === 'event') {
    return {
      operation: 'trace',
      kind: 'event',
      session: projectSummary(result.session),
      event: projectRawEventSummary(result.event),
      replaced_by: [...result.replacedBy],
      shadowed_seqs: [...result.shadowedSeqs],
      source_event_seqs: [...result.sourceEventSeqs],
      ...staleField(stale),
    }
  }
  return {
    operation: 'trace',
    kind: 'session',
    target: projectSummary(result.target),
    ancestors: result.ancestors.map(projectSummary),
    descendants: flattenDescendants(result.descendants, 0),
    complete: result.complete,
    ...staleField(stale),
  }
}

/**
 * Walk a descendant tree depth-first into `{ session, depth }` entries.
 * @param nodes - the tree level to flatten.
 * @param depth - this level's distance from the target.
 * @returns the flattened entries, in tree order.
 */
function flattenDescendants(
  nodes: readonly SessiongraphTraceNode[],
  depth: number,
): Array<{ session: SessiongraphValueFor<'session'>['session']; depth: number }> {
  const flat: Array<{ session: SessiongraphValueFor<'session'>['session']; depth: number }> = []
  for (const node of nodes) {
    flat.push({ session: projectSummary(node.session), depth })
    flat.push(...flattenDescendants(node.descendants, depth + 1))
  }
  return flat
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
    source: summary.source,
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
