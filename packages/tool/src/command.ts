/**
 * The human `/sessiongraph` slash command.
 *
 * The model-facing tools answer the same questions, but a person at the composer should not spend a
 * model turn asking "什么进索引了" or "上次谁提过广告". This command runs directly against
 * `ctx.sessiongraph` in the UI's command plane: nothing it returns becomes a model message or a
 * token.
 *
 * Registered through conditional injection (`ctx.inject(['commands'], …)`) — the command registry is
 * a host composition choice, and its absence must not hide the two tools this plugin also registers.
 * `@deepseek-ai/dsh-commands` is deliberately not imported: the service may be absent, so its public
 * shape is mirrored structurally here, exactly as the codegraph command does.
 * @module dsh-plugin-sessiongraph-tool/command
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { INDEX_RELATIVE_PATH, SessiongraphError } from 'dsh-plugin-sessiongraph-service'
import type {
  SessiongraphIndexReport,
  SessiongraphSearchResult,
  SessiongraphStatusResult,
  SessiongraphWorkspacesResult,
} from 'dsh-plugin-sessiongraph-service'
import { isBackgroundIndexReport } from 'dsh-plugin-sessiongraph-sessions'
import { formatBytes, formatDuration, formatTime, clipText } from './render.ts'
import { SESSIONGRAPH_DEFAULT_LIMITS } from './schema.ts'

/** Command name, without the leading slash. */
export const COMMAND_NAME = 'sessiongraph'

/** One-line discovery copy the UI shows in its command list. */
export const COMMAND_DESCRIPTION = '查看或重建本机会话历史索引，或直接检索过去聊过什么'

/** Input syntax the UI shows after the command name. */
export const COMMAND_INPUT_HINT = '[status|index [--force]|search <query>|workspaces]'

/** The usage line every rejection repeats, so one screen never offers half an answer. */
export const COMMAND_USAGE = `用法：/${COMMAND_NAME} ${COMMAND_INPUT_HINT}`

/** Longest snippet the human-facing `search` prints per hit; a terminal is not a transcript. */
export const COMMAND_MAX_SNIPPET_CHARS = 200

/** Where a subcommand's help ends and the list of what exists begins. */
const AVAILABLE = `可用子命令：status（索引状态）、index [--force]（建/刷新索引）、search <query>（直接检索）、workspaces（工作区列表）`

/**
 * Branded identity of this definition, mirroring `CommandDefinitionId` from
 * `@deepseek-ai/dsh-commands` without importing it. The registry treats the value as an opaque
 * string; the local brand only keeps a plain string from standing in for a stable identity.
 */
export type CommandDefinitionId = string & { readonly __commandDefinitionId: 'CommandDefinitionId' }

/** Stable identity, independent of the display name or the UI's per-run id. */
export const COMMAND_DEFINITION_ID = 'dsh-plugin-sessiongraph/command/sessiongraph' as CommandDefinitionId

/** What a handler settles with; mirrors the registry's `success | error` result. */
export type CommandResult =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

/**
 * The invocation face a command handler receives, declared structurally — only the members this
 * command reads. The workspace comes from here, never from the process working directory: the
 * command runs in a UI that may be driving several sessions.
 */
export interface CommandInvocation {
  /** Everything after the command name, including its leading separator whitespace. */
  readonly rawInput: string
  /** The receiving agent: its id owns any background job, its session carries the workspace. */
  readonly agent?: {
    readonly id?: string
    readonly session?: { readonly header?: { readonly cwd?: unknown } }
  }
  /** UI request cancellation, forwarded to every seam call. */
  readonly signal?: AbortSignal
}

/** One command registration, as the registry's `register` takes it. */
export interface CommandDefinition {
  /** Stable plugin-namespaced identity. */
  readonly definitionId: CommandDefinitionId
  /** Lowercase command name, without the slash. */
  readonly name: string
  /** Discovery copy, shown in the UI's command list. */
  readonly description: string
  /** Input syntax shown after the name. */
  readonly input: { readonly hint: string }
  /**
   * Run the command against the session index.
   * @param invocation - the accepted command line and its context.
   * @returns the settled result the UI renders.
   */
  readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}

/** The command registry's registration surface, declared structurally. */
export interface CommandRegistry {
  /**
   * Register one command definition.
   * @param definition - discovery metadata and handler.
   * @returns the disposer unregistering it.
   */
  register(definition: CommandDefinition): () => void
}

/** What the command needs from the plugin configuration. */
export interface CommandOptions {
  /** Absolute directory holding the index. */
  readonly indexRoot: string
  /** Longest snippet the `search` subcommand prints per hit. */
  readonly maxSnippetChars: number
}

/** One parsed command line. */
export type CommandPlan =
  | { readonly kind: 'status' }
  | { readonly kind: 'workspaces' }
  | { readonly kind: 'index'; readonly force: boolean }
  | { readonly kind: 'search'; readonly query: string }
  | { readonly kind: 'unknown'; readonly subcommand: string }

/**
 * Parse one command line. Pure, so both the dispatcher and its tests agree on what a line means.
 *
 * The registry keeps the separator whitespace in `rawInput`, so a bare `/sessiongraph` arrives as an
 * empty string and must still mean `status`.
 * @param rawInput - everything after the command name, as the UI delivered it.
 * @returns the subcommand and its arguments.
 */
export function parseCommand(rawInput: string): CommandPlan {
  const trimmed = rawInput.trim()
  if (trimmed === '') return { kind: 'status' }
  const separator = trimmed.search(/\s/u)
  const subcommand = separator === -1 ? trimmed : trimmed.slice(0, separator)
  const rest = separator === -1 ? '' : trimmed.slice(separator).trim()
  switch (subcommand) {
    case 'status':
      return { kind: 'status' }
    case 'workspaces':
      return { kind: 'workspaces' }
    case 'index':
      return { kind: 'index', force: rest.split(/\s+/u).includes('--force') }
    // The query is free text, so it keeps its inner spacing instead of being re-joined from tokens.
    case 'search':
      return { kind: 'search', query: rest }
    default:
      return { kind: 'unknown', subcommand }
  }
}

/**
 * Register the `/sessiongraph` command when the host composition provides a command registry.
 * @param ctx - the plugin context (must carry `sessiongraph`; `commands` is optional).
 * @param options - the index root and the snippet cap the subcommands print with.
 */
export function registerCommands(ctx: Context, options: CommandOptions): void {
  try {
    ctx.inject(['commands'], child => {
      const commands = (child as Context & { commands: CommandRegistry }).commands
      child.effect(
        () => commands.register({
          definitionId: COMMAND_DEFINITION_ID,
          name: COMMAND_NAME,
          description: COMMAND_DESCRIPTION,
          input: { hint: COMMAND_INPUT_HINT },
          handler: invocation => runCommand(ctx, options, invocation),
        }),
        'sessiongraph: slash command',
      )
    })
  } catch {
    // Silent on purpose: the command registry is a host composition choice, and a composition
    // without it still gets both model-facing tools. A missing human convenience is not worth a
    // load-time failure, and a warning on every start would only teach people to ignore startup logs.
  }
}

/**
 * Parse and dispatch one invocation.
 *
 * A handler that throws makes the registry settle the command as an error from the thrown value, so
 * every expected failure is returned as `kind: 'error'` here; only a defect escapes.
 * @param ctx - the plugin context carrying `sessiongraph`.
 * @param options - the index root and rendering caps.
 * @param invocation - the accepted command line and its context.
 * @returns the settled result.
 */
export async function runCommand(
  ctx: Context,
  options: CommandOptions,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  const plan = parseCommand(invocation.rawInput)
  try {
    switch (plan.kind) {
      case 'status':
        return await statusCommand(ctx, options, invocation)
      case 'workspaces':
        return await workspacesCommand(ctx, options, invocation)
      case 'index':
        return await indexCommand(ctx, options, plan.force, invocation)
      case 'search':
        return await searchCommand(ctx, options, plan.query, invocation)
      case 'unknown':
        return { kind: 'error', text: `未知的子命令 "${plan.subcommand}"。${COMMAND_USAGE}\n${AVAILABLE}` }
    }
  } catch (error) {
    return { kind: 'error', text: describe(error) }
  }
}

/** The session workspace an invocation runs for; `undefined` when the command has none. */
export function invocationWorkspace(invocation: CommandInvocation): string | undefined {
  const cwd = invocation.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : undefined
}

/**
 * Report the index at a glance: size, freshness, and whether live sessions are covered yet.
 * @param ctx - the plugin context carrying `sessiongraph`.
 * @param options - the index root.
 * @param invocation - the accepted command line and its context.
 * @returns one compact status block, or how to build the missing index.
 */
async function statusCommand(
  ctx: Context,
  options: CommandOptions,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  try {
    const result = await ctx.sessiongraph.query({ operation: 'status', indexRoot: options.indexRoot }, invocation.signal)
    return { kind: 'success', text: statusText(result, invocationWorkspace(invocation)) }
  } catch (error) {
    // Unlike the model tool, the command runs with a human watching: "no index yet" is an answer,
    // not a failure, and it comes with the one command that fixes it.
    if (error instanceof SessiongraphError && error.code === 'SESSIONGRAPH_UNAVAILABLE') {
      return { kind: 'success', text: noIndexText(join(options.indexRoot, INDEX_RELATIVE_PATH)) }
    }
    throw error
  }
}

/**
 * Render a status answer.
 * @param result - the seam's status answer.
 * @param workspace - the session's workspace, shown as context when there is one.
 * @returns the status block.
 */
export function statusText(result: SessiongraphStatusResult, workspace?: string): string {
  if (!result.indexed) return noIndexText(result.indexPath)
  const built = result.indexedAt === undefined ? '未知' : formatTime(result.indexedAt)
  const lines = [
    `索引：${result.indexPath}`,
    `${result.sessions} 个会话 · ${result.entries} 条可检索条目 · ${result.workspaces} 个工作区 · ${formatBytes(result.bytes)}`,
    `最近一次建索引：${built}`,
    '实时会话：未接入（索引器暂未提供 live 会话检索）',
  ]
  if (workspace !== undefined) lines.push(`当前工作区：${workspace}`)
  return lines.join('\n')
}

/**
 * The one sentence a person sees before an index exists.
 * @param indexPath - where the index would live.
 * @returns the hint naming the command that builds it.
 */
function noIndexText(indexPath: string): string {
  return `还没有索引（${indexPath}）。先跑 /${COMMAND_NAME} index 建一次。`
}

/**
 * Build or refresh the index right now.
 *
 * A human ran this and is willing to wait, so the synchronous report is the normal answer. A store
 * large enough for the host's job registry may still be delegated, in which case the call answers at
 * once with the job id instead of holding the composer open.
 * @param ctx - the plugin context carrying `sessiongraph`.
 * @param options - the index root.
 * @param force - rebuild every session instead of skipping unchanged ones.
 * @param invocation - the accepted command line and its context.
 * @returns the run's summary, or the started job's id.
 */
async function indexCommand(
  ctx: Context,
  options: CommandOptions,
  force: boolean,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  const owner = invocation.agent?.id
  const report = await ctx.sessiongraph.index(options.indexRoot, {
    ...(force ? { force: true } : {}),
    // The owning session id is a runtime extension of the seam's options: a job-capable indexer
    // delegates a large run only when the caller names one.
    ...(owner === undefined ? {} : { owner }),
  }, invocation.signal)
  if (isBackgroundIndexReport(report)) {
    return {
      kind: 'success',
      text: `已在后台建索引，jobId=${report.jobId}。稍后用 /${COMMAND_NAME} status 看规模；`
        + `job_output ${report.jobId} 可看这次运行的报告。`,
    }
  }
  return { kind: 'success', text: indexReportText(report) }
}

/**
 * Render a finished run.
 * @param report - the indexer's report.
 * @returns the two- or three-line summary.
 */
export function indexReportText(report: SessiongraphIndexReport): string {
  const lines = [
    `建索引完成，用时 ${formatDuration(report.elapsedMs)}：`
      + `新增 ${report.added}、更新 ${report.updated}、跳过 ${report.skipped}、移除 ${report.removed}`
      + `（发现 ${report.discovered} 个会话）。`,
    `${report.sessions} 个会话 · ${report.entries} 条可检索条目 · ${report.workspaces} 个工作区 · ${formatBytes(report.bytes)}`,
  ]
  if (report.failed.length > 0) lines.push(`解析失败 ${report.failed.length} 个会话。`)
  return lines.join('\n')
}

/**
 * Run one search and print its first page.
 * @param ctx - the plugin context carrying `sessiongraph`.
 * @param options - the index root and snippet cap.
 * @param query - the free-text query.
 * @param invocation - the accepted command line and its context.
 * @returns the hit list, or the empty-result hint.
 */
async function searchCommand(
  ctx: Context,
  options: CommandOptions,
  query: string,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  if (query === '') return { kind: 'error', text: `search 需要一个检索词。用法：/${COMMAND_NAME} search <query>` }
  const result = await ctx.sessiongraph.query({
    operation: 'search',
    indexRoot: options.indexRoot,
    query,
    limit: SESSIONGRAPH_DEFAULT_LIMITS.search,
  }, invocation.signal)
  return {
    kind: 'success',
    text: searchText(result, query, Math.min(options.maxSnippetChars, COMMAND_MAX_SNIPPET_CHARS)),
  }
}

/**
 * Render a search answer for a human: title, time, workspace, snippet.
 * @param result - the seam's search answer.
 * @param query - the query text, echoed in the header.
 * @param maxSnippetChars - cap on the snippet printed per hit.
 * @returns the hit list, or the empty-result hint.
 */
export function searchText(result: SessiongraphSearchResult, query: string, maxSnippetChars: number): string {
  if (result.hits.length === 0) {
    return `没有命中「${query}」。换个词试试；中文两字词即可命中（如「广告」）。`
  }
  const page = result.truncated ? `（共 ${result.total} 条，只显示前 ${result.hits.length} 条）` : `（共 ${result.total} 条）`
  const lines = [`命中「${query}」${page}：`]
  for (const hit of result.hits) {
    const title = hit.title === undefined || hit.title.trim() === '' ? '（无标题）' : `《${hit.title}》`
    lines.push(`${formatTime(hit.time)} · ${title} · ${hit.workspace}`)
    lines.push(`  ${clipText(hit.snippet, maxSnippetChars)}`)
  }
  return lines.join('\n')
}

/**
 * List the workspaces the index covers, marking the caller's own.
 * @param ctx - the plugin context carrying `sessiongraph`.
 * @param options - the index root.
 * @param invocation - the accepted command line and its context.
 * @returns the workspace list.
 */
async function workspacesCommand(
  ctx: Context,
  options: CommandOptions,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  const result = await ctx.sessiongraph.query({
    operation: 'workspaces',
    indexRoot: options.indexRoot,
    limit: SESSIONGRAPH_DEFAULT_LIMITS.workspaces,
  }, invocation.signal)
  return { kind: 'success', text: workspacesText(result, invocationWorkspace(invocation)) }
}

/**
 * Render a workspace census.
 * @param result - the seam's workspaces answer.
 * @param current - the session's own workspace, marked with `*` when it appears.
 * @returns the census.
 */
export function workspacesText(result: SessiongraphWorkspacesResult, current?: string): string {
  if (result.workspaces.length === 0) return `索引里还没有工作区。先跑 /${COMMAND_NAME} index 建一次。`
  const shown = result.total > result.workspaces.length
    ? `${result.workspaces.length} / ${result.total} 个工作区，最近活跃在前`
    : `${result.workspaces.length} 个工作区，最近活跃在前`
  const marked = current !== undefined && result.workspaces.some(entry => entry.workspace === current)
  const lines = [marked ? `${shown}（* 为当前工作区）：` : `${shown}：`]
  for (const entry of result.workspaces) {
    const marker = entry.workspace === current ? '*' : ' '
    lines.push(
      `${marker} ${entry.workspace} · ${entry.sessions} 会话 · ${entry.entries} 条`
        + ` · ${formatTime(entry.firstAt)} → ${formatTime(entry.lastAt)}`,
    )
  }
  return lines.join('\n')
}

/**
 * One line describing a thrown value, without a stack.
 * @param error - whatever the seam threw.
 * @returns the message when there is one, else the string form.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
