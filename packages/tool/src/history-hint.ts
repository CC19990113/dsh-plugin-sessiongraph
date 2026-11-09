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
 * @module dsh-plugin-sessiongraph-tool/history-hint
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
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
 * The reminder text.
 *
 * Written to hold for **any** deployment: it names no memory provider and assumes none is installed.
 * A host may have no recall plugin at all, or one whose output this module cannot recognize — naming
 * a provider or matching its storage format would make the advice work on one machine and quietly
 * stop working on the next. The part that is true everywhere is the part that is said: a summary is
 * not evidence, and the index holds the original conversation.
 */
export const HISTORY_HINT_TEXT =
  '[会话历史提醒] 这个问题像是在问本机过去会话里发生过什么。'
  + '注意：任何关于过去的**摘要**（记忆插件给的、系统上下文里的、更早对话里的复述，都算）都不是原文——'
  + '可能漏、可能旧、也可能把两件事混在一起。先用 sessiongraph 查原文再回答：'
  + 'search 跨会话检索、session 按 id 打开某个会话、event 读某一条原始事件；摘要只用来决定去哪儿查。'
  + '也不要 grep ~/.dsh/sessions（zstd 压缩，读不到正文）。'

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
 * Whether one piece of user text reads as a question about the past.
 * @param text - the user's own words (never injected context).
 * @returns true when any {@link HISTORY_QUESTION_TERMS} appears in it.
 */
export function looksLikeHistoryQuestion(text: string): boolean {
  const haystack = text.toLowerCase()
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

/**
 * Build the reminder message.
 * @returns a frozen, message-shaped reminder with its own id.
 */
export function buildHistoryHint(): HistoryHintMessage {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: HISTORY_HINT_TEXT }],
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

/**
 * Append the history reminder to the next admitted step, once per conversation.
 *
 * Registered per agent rather than globally for the same reason the update notice is: the host's hook
 * is agent-scoped, `next` only means something inside that scope, and one registration per
 * conversation is what keeps a reminder out of a session that never asked a history question.
 * @param ctx - the plugin context.
 * @param state - the per-registration bookkeeping shared with the tools.
 */
export function registerHistoryHint(ctx: Context, state: HistoryHintState): void {
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
      state.hintedTo.add(key)
      return { ...decision, messages: [...decision.messages, buildHistoryHint()] }
    })
  }))
}
