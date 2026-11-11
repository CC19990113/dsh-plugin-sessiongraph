/**
 * The "this looks like a question about past conversations" reminder.
 *
 * The system prompt already says to search the session index instead of grepping `~/.dsh/sessions`.
 * That is not enough in practice: a memory provider injects its own recall block on every step, so a
 * model that has just been handed a summary of the past reaches for the summary and never opens the
 * index. The summary is cheap and always present; the index is one tool call away. This module closes
 * that gap at the one moment it matters — right before a model request whose user input asks about
 * something that already happened.
 *
 * Three rules keep it from becoming noise:
 *
 * - **Only a genuine user input can trigger it.** Injected context, tool results and notices from
 *   other plugins are user-role messages too, and matching their text would let the reminder trigger
 *   itself. Only a message whose `source.kind` is `user` is read.
 * - **Once per conversation, and never after the tool was used.** A conversation that already called
 *   `sessiongraph` has demonstrated it knows the tool; repeating the advice would spend tokens to say
 *   nothing new. The state is keyed by agent id, so one session cannot silence another.
 * - **It rides the admission waterfall, never blocks it.** The listener answers only after `next()`
 *   resolved, appends to a batch that is already being sent, and returns a rejected decision
 *   untouched — the reminder can never veto a step or change what a user typed.
 *
 * The reminder points rather than just asserts when it can. A bounded search of the index (300 ms,
 * aborted together with the step) turns "you should search the index" into the sessions that
 * actually matched, one `· MM-DD workspace title · id` line each, so the model can read the original
 * conversation by id instead of being told one exists. The search is a bonus, never a dependency:
 * a rejection, the deadline, a malformed result or no matches all fall back to the static sentence,
 * and the listener still returns the step's own decision. A memory question — a preference, a habit,
 * a style — is excluded up front, because the memory layer already answers those and a second block
 * would only compete with its answer.
 * @module dsh-plugin-sessiongraph-tool/history-hint
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { SessiongraphHit } from 'dsh-plugin-sessiongraph-service'
import { agentIdOf } from './status-hint.ts'

/** `source.kind` of the reminder message, so a later step can tell it apart from real user input. */
export const HISTORY_HINT_SOURCE_KIND = 'sessiongraph-hint'

/**
 * Words that make a question about the past. Matched as substrings against the user's own text.
 *
 * Deliberately broad: a false positive costs one short sentence once per conversation, while a miss
 * sends the model back to grepping compressed logs and memory summaries. Terms that are equally at
 * home in a question about the current task (`进度`, `之前`) are kept, because those are exactly the
 * questions that were answered from memory before this reminder existed.
 */
export const HISTORY_QUESTION_TERMS: readonly string[] = [
  '进度',
  '上次',
  '之前',
  '昨天',
  '前天',
  '上周',
  '上个月',
  '那个会话',
  '哪个会话',
  '哪个对话',
  '说过',
  '做过',
  '干过',
  '聊过',
  '记得',
  '当时',
  '继续上次',
  '接着上次',
  '按上次',
  '继续做',
  '接着做',
  '继续弄',
  '接着弄',
  '继续搞',
  'last time',
  'previously',
  'pick up where',
]

/**
 * Words that make a question a question about the user, not about the past.
 *
 * These are the memory layer's subject: preferences, habits and styles are what it exists to recall,
 * and an index pointer on top of its answer is noise that competes for the model's attention. They
 * are an **exclusion only** — none of them are removed from {@link HISTORY_QUESTION_TERMS}. A miss
 * (the model never learns the index exists) sends it back to grepping compressed logs and trusting a
 * summary; a false positive costs one short notice, once per conversation. Missing is the expensive
 * failure, so the word list only ever grows.
 */
export const MEMORY_QUESTION_TERMS: readonly string[] = [
  '偏好',
  '喜欢',
  '习惯',
  '平时',
  '一般',
  '风格',
  '记住',
]

/**
 * A message-shaped reminder, structurally identical to what `dsh-llm`'s `createUserMessage` builds.
 *
 * Built as a plain object rather than through `@deepseek-ai/dsh-llm`: that package moves exports
 * between minor releases, and a static import of a symbol that later moves takes the whole plugin
 * out of the host. Four lines of local typing do not.
 */
export interface HistoryHintMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  readonly source: {
    readonly kind: string
    readonly form: 'notice'
    readonly summary: string
  }
}

/**
 * The fallback reminder text, used whenever there is nothing concrete to point at: no search was
 * provided, or the search failed, timed out or matched nothing.
 *
 * Written to hold for **any** deployment: it names no memory provider and assumes none is installed.
 * A host may have no recall plugin at all, or one whose output this module cannot recognize — naming
 * a provider or matching its storage format would make the advice work on one machine and quietly
 * stop working on the next. The part that is true everywhere is the part that is said: a summary is
 * not evidence, and the index holds the original conversation.
 */
export const HISTORY_HINT_TEXT =
  '[会话历史提醒] 这是在问本机过去会话的事，手上的摘要不是原文，先 sessiongraph 查原文再回答。'

/**
 * The per-conversation bookkeeping a {@link registerHistoryHint} listener keeps.
 *
 * Shared between the pre-step hook and the tools on purpose: the tool reports that a conversation has
 * already reached the index, which is what turns the reminder off for the rest of that conversation.
 */
export interface HistoryHintState {
  /** Agents that already called the `sessiongraph` tool. */
  readonly usedBy: Set<string>
  /** Agents that already received the reminder. */
  readonly hintedTo: Set<string>
}

/** A fresh state object; one per plugin registration. */
export function createHistoryHintState(): HistoryHintState {
  return { usedBy: new Set(), hintedTo: new Set() }
}

/**
 * Record that a conversation already called the index, which disables the reminder for it.
 *
 * A conversation that has seen `sessiongraph` results does not need to be told the tool exists; the
 * advice would be paid for in tokens and answer a question nobody asked.
 * @param state - the per-registration bookkeeping.
 * @param context - the tool execution (or any record carrying `agent.id`).
 */
export function noteHistoryToolUse(state: HistoryHintState, context: unknown): void {
  const agentId = agentIdOf(context)
  if (agentId !== undefined) state.usedBy.add(agentId)
}

/**
 * The index search the reminder may ride on, structurally typed so this module needs no runtime
 * import from the service package (only its hit type, which erases at build time).
 * @param query - the user's own text, used verbatim.
 * @param signal - aborts when the host cancels the step or the search budget expires.
 * @returns matching sessions; empty means "nothing worth pointing at".
 */
export type HistoryHintSearch = (
  query: string,
  signal?: AbortSignal,
) => Promise<readonly SessiongraphHit[]>

/**
 * Whether one piece of user text reads as a question about the past.
 *
 * The memory terms win outright: `你记得我喜欢什么` matches `记得` (a history word) and `喜欢` (a
 * memory word), and that question belongs to the memory layer. Removal from the history list is not
 * the fix — a deleted trigger word stops the reminder from ever firing on the questions it was built
 * for — so the exclusion is applied at match time and the two lists stay independent.
 * @param text - the user's own words (never injected context).
 * @returns false when any {@link MEMORY_QUESTION_TERMS} appears, otherwise true when any
 *   {@link HISTORY_QUESTION_TERMS} appears.
 */
export function looksLikeHistoryQuestion(text: string): boolean {
  const haystack = text.toLowerCase()
  const isMemoryQuestion = MEMORY_QUESTION_TERMS.some(term => haystack.includes(term.toLowerCase()))
  if (isMemoryQuestion) return false
  return HISTORY_QUESTION_TERMS.some(term => haystack.includes(term.toLowerCase()))
}

/** Minimal structural read of a message the host put in the admission batch. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * The text of the last message the user actually typed in this batch.
 *
 * Only `role: 'user'` with `source.kind: 'user'` counts. Everything else that can carry the user role
 * — recall blocks, job notices, time context, this module's own reminder — is excluded, because
 * matching against injected text is how a reminder ends up triggering itself.
 * @param messages - the batch the host is about to send.
 * @returns the typed text, or undefined when this batch has none (a tool-only step, for instance).
 */
export function lastUserText(messages: readonly unknown[] | undefined): string | undefined {
  if (!Array.isArray(messages)) return undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isRecord(message) || message.role !== 'user') continue
    const source = message.source
    if (!isRecord(source) || source.kind !== 'user') continue
    const content = message.content
    if (!Array.isArray(content)) continue
    const text = content
      .filter((part): part is { type: string; text: string } =>
        isRecord(part) && part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('\n')
      .trim()
    if (text !== '') return text
  }
  return undefined
}

/** One `· MM-DD workspace title · id` line per hit, and no more than this many lines. */
const HISTORY_HINT_MAX_HITS = 3

/**
 * Longest workspace basename a navigation line shows, in characters.
 *
 * Twenty covers the repo names in daily use here (`dsh-plugin-codegraph` is 19). A shorter cap cut
 * real names mid-word, which made two different repositories render as the same string.
 */
const HISTORY_WORKSPACE_MAX_CHARS = 20

/** Longest session title a navigation line shows, in characters. */
const HISTORY_TITLE_MAX_CHARS = 24

/** First characters of a session id — enough to name one session unambiguously to the tool. */
const HISTORY_ID_MAX_CHARS = 8

/** Header of the navigation block; the static sentence stands in when no session is named. */
const HISTORY_NAVIGATION_HEADER = '[会话历史] 过去相关（调 sessiongraph 按 id 查原文）：'

/** Clip `text` to at most `max` characters; an ellipsis would be one more character than allowed. */
function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}

/** The last segment of a POSIX- or Windows-shaped workspace path. */
function basenameOf(workspace: string): string {
  const segments = workspace.split(/[\\/]+/).filter(segment => segment !== '')
  return segments[segments.length - 1] ?? workspace
}

/** The local-time `MM-DD` of a hit, which is how a person refers to the day. */
function formatDay(time: number): string {
  const date = new Date(time)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${month}-${day}`
}

/** One navigation line: the day, the workspace, the title and the id to read it by. */
function navigationLine(hit: SessiongraphHit): string {
  const workspace = truncate(basenameOf(hit.workspace), HISTORY_WORKSPACE_MAX_CHARS)
  const title = truncate(hit.title ?? '(无标题)', HISTORY_TITLE_MAX_CHARS)
  const sessionId = hit.sessionId.slice(0, HISTORY_ID_MAX_CHARS)
  return `· ${formatDay(hit.time)} ${workspace} ${title} · ${sessionId}`
}

/**
 * The navigation block: one header plus up to three session lines.
 *
 * Deliberately provider-free: it names no memory service and carries no URI scheme, so it reads the
 * same on every machine and cannot be mistaken for a storage address the model should open.
 */
function renderNavigation(hits: readonly SessiongraphHit[]): string {
  return [HISTORY_NAVIGATION_HEADER, ...hits.slice(0, HISTORY_HINT_MAX_HITS).map(navigationLine)].join('\n')
}

/**
 * Build the reminder message.
 *
 * With no hits — no search was provided, or it failed, timed out or matched nothing — the text is
 * the static sentence the reminder has always used. With hits it names up to three past sessions and
 * the ids to read them by, which is the difference between "the index exists" and "here is where you
 * were".
 * @param hits - the sessions the index matched for the user's question, when a search ran.
 * @returns a message-shaped reminder with its own id.
 */
export function buildHistoryHint(hits?: readonly SessiongraphHit[]): HistoryHintMessage {
  const text = hits === undefined || hits.length === 0 ? HISTORY_HINT_TEXT : renderNavigation(hits)
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: HISTORY_HINT_SOURCE_KIND,
      form: 'notice',
      summary: 'sessiongraph: 历史问题先查会话索引',
    },
  }
}

/** The agent lifecycle surface this module listens to; declared locally rather than imported. */
interface AgentLifecycleContext {
  on(name: 'agent/created', listener: (payload: AgentCreatedPayload) => void): () => boolean
}

/** The `agent/created` payload: the agent and the scoped context its own hooks live on. */
interface AgentCreatedPayload {
  readonly agent?: {
    readonly id?: unknown
    readonly ctx?: AgentScopedContext
  }
}

/** The per-agent context, whose `agent/pre-step` waterfall runs before every model request. */
interface AgentScopedContext {
  on(
    name: 'agent/pre-step',
    listener: (payload: AgentPreStepPayload, next: () => Promise<AgentPreStepDecision>) => Promise<AgentPreStepDecision>,
  ): () => boolean
}

/** What the host passes into the waterfall; the batch is read, the agent identifies the memory. */
interface AgentPreStepPayload {
  readonly agent?: { readonly id?: unknown }
  readonly messages?: readonly unknown[]
  readonly signal?: AbortSignal
}

/**
 * The admitted-step decision. `reject` carries no messages and must be passed through untouched;
 * `enter` carries the batch that will be sent, which this module appends to.
 */
interface AgentPreStepDecision {
  readonly kind: string
  readonly messages: readonly unknown[]
}

/** How long the reminder may spend asking the index before falling back to the static sentence. */
const HISTORY_SEARCH_TIMEOUT_MS = 300

/** Whether a failed search has already been reported, so one broken index is logged once. */
let searchFailureReported = false

/** Report the first failed search; later ones are the same fault and would only fill the log. */
function reportSearchFailure(error: unknown): void {
  if (searchFailureReported) return
  searchFailureReported = true
  console.error('[sessiongraph] 历史问题检索失败，回退静态提醒：', error)
}

/**
 * Settle `work` no later than `ms`, rejecting when the budget runs out.
 *
 * The search promise cannot really be cancelled — a provider may ignore its abort signal — so the
 * deadline only stops *waiting*. The abandoned promise keeps its rejection handled here, which is
 * what keeps a late failure from becoming an unhandled rejection after the reminder has moved on.
 * @param work - the search, already in flight.
 * @param ms - the deadline in milliseconds.
 * @returns the search's own result, or a rejection at the deadline.
 */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`history hint search timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Ask the index which past sessions relate to this question, never longer than the budget and never
 * throwing.
 *
 * Every failure — a rejection, the deadline, a provider returning something that is not an array, or
 * no matches at all — collapses to `undefined`, which is exactly what makes the reminder fall back to
 * its static sentence. The step is already admitted; failing to improve the reminder is not a reason
 * to change or veto what the user asked.
 * @param search - the index search, when the deployment provided one.
 * @param text - the user's own words, used verbatim as the query.
 * @param upstream - the step's abort signal, fused with the deadline.
 * @returns the hits worth naming, or undefined when there is nothing safe to name.
 */
async function searchHistory(
  search: HistoryHintSearch,
  text: string,
  upstream: AbortSignal | undefined,
): Promise<readonly SessiongraphHit[] | undefined> {
  const signals: AbortSignal[] = [AbortSignal.timeout(HISTORY_SEARCH_TIMEOUT_MS)]
  if (upstream !== undefined) signals.push(upstream)
  try {
    const found = await withTimeout(search(text, AbortSignal.any(signals)), HISTORY_SEARCH_TIMEOUT_MS)
    return Array.isArray(found) && found.length > 0 ? found : undefined
  } catch (error) {
    reportSearchFailure(error)
    return undefined
  }
}

/**
 * Append the history reminder to the next admitted step, once per conversation.
 *
 * Registered per agent rather than globally for the same reason the update notice is: the host's hook
 * is agent-scoped, `next` only means something inside that scope, and one registration per
 * conversation is what keeps a reminder out of a session that never asked a history question.
 * @param ctx - the plugin context.
 * @param state - the per-registration bookkeeping shared with the tools.
 * @param search - optional index search; without it the reminder stays the static sentence it was,
 *   so a deployment that has not wired the query keeps loading and behaving exactly as before.
 */
export function registerHistoryHint(ctx: Context, state: HistoryHintState, search?: HistoryHintSearch): void {
  const events = ctx as unknown as AgentLifecycleContext
  // Inside an effect so the subscription follows the plugin's own lifetime.
  ctx.effect(() => events.on('agent/created', payload => {
    const agentCtx = payload.agent?.ctx
    if (agentCtx === undefined) return
    const agentId = agentIdOf(payload)
    agentCtx.on('agent/pre-step', async (stepPayload, next) => {
      const decision = await next()
      // A rejected step sends nothing, so there is no batch to put a reminder into.
      if (decision.kind !== 'enter') return decision
      const text = lastUserText(stepPayload.messages)
      if (text === undefined || !looksLikeHistoryQuestion(text)) return decision
      const key = agentId ?? 'unknown-agent'
      if (state.usedBy.has(key) || state.hintedTo.has(key)) return decision
      // Claimed before the search: a search that times out must not make the next step retry, or one
      // slow query would put a 300 ms tax on every step of the conversation.
      state.hintedTo.add(key)
      const hits = search === undefined ? undefined : await searchHistory(search, text, stepPayload.signal)
      return { ...decision, messages: [...decision.messages, buildHistoryHint(hits)] }
    })
  }))
}
