/**
 * Which session-reading surface a profile exposes to the model at runtime.
 *
 * Two implementations answer "what did I say last time": the host's kernel session tools
 * (`session_search` and friends, backed by the raw session logs) and this plugin's own
 * `sessiongraph` tool (backed by the pre-built index). A profile should not make the model choose
 * between two overlapping vocabularies, so exactly one of them is offered — or both, on request.
 *
 * The lever is `ctx.tools.restrict({ deny })`, which is scoped-only by construction: a context-global
 * restriction would mask every agent. Everything here therefore registers through `agent.ctx`, and
 * the resulting disposer is remembered per agent so flipping the setting lifts the old mask instead
 * of stacking a second one (restrictions intersect — a stale deny would outlive its reason).
 *
 * Every host surface this module reaches for is optional by construction: `agents`, the kernel's
 * tools, and the prompt registry may all be absent in a given composition, and none of them may take
 * the plugin down. A missing service means "nothing to hide", never an error.
 * @module dsh-plugin-sessiongraph-tool/visibility
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from './index.ts'

/**
 * The three mutually exclusive session-tool sets the settings page offers.
 *
 * `sessiongraph` is the default because the index answers faster and more completely than a raw-log
 * grep; `kernel` exists for a user who prefers the host's own tools; `both` is the escape hatch for a
 * profile that wants the model to have every route to the history.
 */
export type ToolSet = 'sessiongraph' | 'kernel' | 'both'

/**
 * The kernel's five session-reading tools, as the host registers them.
 *
 * Denying them is the whole of `toolSet: 'sessiongraph'`. The names are verified against the live
 * registry before use — a host without those tools (or one that renamed them) must not turn a
 * settings choice into a startup failure.
 */
export const KERNEL_SESSION_TOOLS = [
  'session_search',
  'session_event_search',
  'session_trace',
  'session_event_trace',
  'session_event_read',
] as const

/** This plugin's own model-facing tool, the one `toolSet: 'kernel'` hides. */
export const SESSIONGRAPH_TOOL = 'sessiongraph'

/** Effective choice when neither the plugin config nor a persisted panel choice names one. */
export const DEFAULT_TOOL_SET: ToolSet = 'sessiongraph'

/**
 * Name of the kernel's fixed session-tool prompt section.
 *
 * The host registers it globally, so the only way to stop the prompt from advertising tools the
 * model cannot see is a scoped section of the same name — the prompt registry resolves a scoped
 * section over a global one. This module never registers it globally (that throws on the duplicate).
 */
export const KERNEL_PROMPT_SECTION = 'tool:session-query'

/**
 * Name of this plugin's own prompt section (`index.ts` registers it globally).
 *
 * Shadowed per agent under `toolSet: 'kernel'` for the same reason as the kernel section: a section
 * that tells the model to call a hidden tool is worse than no section at all.
 */
export const OWN_PROMPT_SECTION = 'tool:sessiongraph'

/** Prompt order the replacement text renders at: the tool-guidance band. */
const PROMPT_ORDER = 112

/**
 * Text that replaces the kernel's session guidance while its tools are hidden.
 *
 * It has to carry the whole story the kernel section carried, because it is not appended to that
 * text — it replaces it: which tool answers, and the fact that the five kernel names are gone
 * (otherwise the model calls one, receives `UNKNOWN_TOOL`, and concludes the deployment is broken).
 */
export const SESSIONGRAPH_ONLY_PROMPT_TEXT =
  '查我自己过去的对话（「上次在哪个会话里说过/做过什么」）用 sessiongraph 工具，不要 grep ~/.dsh/sessions：'
  + '那里的会话按工作区散在子目录里，是 zstd 压缩的 JSONL，grep 读不到正文。'
  + '本 profile 只暴露 sessiongraph：内核的 session_search / session_event_search / session_trace / '
  + 'session_event_trace / session_event_read 已对模型隐藏，调用它们只会得到 UNKNOWN_TOOL。'
  + 'sessiongraph 的 operation：search（中文按两字词检索即可命中，如「广告」）、session、event、trace、'
  + 'timeline、workspaces、status、index；索引不存在时除 status 外都会失败，先跑 operation=index。'

/**
 * Text that replaces this plugin's guidance while its tool is hidden.
 *
 * The mirror image of {@link SESSIONGRAPH_ONLY_PROMPT_TEXT}: under `toolSet: 'kernel'` the global
 * `tool:sessiongraph` section would still advertise a tool the agent cannot see.
 */
export const KERNEL_ONLY_PROMPT_TEXT =
  '查我自己过去的对话（「上次在哪个会话里说过/做过什么」）用内核的 session_search / session_event_search / '
  + 'session_trace / session_event_trace / session_event_read；本 profile 已把 sessiongraph 工具对模型隐藏，'
  + '不要调用它（调用只会得到 UNKNOWN_TOOL）。'

/** One prompt section registration, as `ctx.systemPrompt.section` takes it. */
interface PromptSectionInput {
  /** Unique registry name; a scoped section shadows a global one of the same name. */
  readonly name: string
  /** Ascending sort order within the assembled prompt. */
  readonly order: number
  /** Static replacement text. */
  readonly text: string
}

/** The prompt registry's registration surface, declared structurally. */
interface PromptSectionService {
  /**
   * Register a section in the calling scope.
   * @param section - name, order, and text.
   * @returns the exact disposer that removes it.
   */
  section(section: PromptSectionInput): () => void
}

/**
 * The tool registry's visibility surface, declared structurally.
 *
 * `restrict` is public; `view` is an implementation detail the public API does not expose, yet it is
 * the only way to ask which names exist BEFORE restricting them (a deny of a name the host never
 * registered throws and would take down agent creation). Reading through a cast keeps the check the
 * task asks for without depending on a private member surviving a host release: when it is gone,
 * {@link knownGlobalTools} reports "unknown" and nothing is denied.
 */
interface RestrictableTools {
  /**
   * Resolve one scope's registry facts. `undefined` scope means the global view.
   * @param scope - the viewing scope.
   * @returns the derived name sets.
   */
  view(scope?: unknown): { readonly knownNames?: ReadonlySet<string>; readonly restrictableNames?: ReadonlySet<string> } | undefined
  /**
   * Restrict global tools for the calling agent scope.
   * @param filter - names to keep and/or names to remove.
   * @returns the exact disposer that lifts the restriction.
   */
  restrict(filter: { readonly deny?: readonly string[]; readonly allow?: readonly string[] }): () => void
}

/** An agent's own scope: where per-agent registrations live and die with the agent. */
interface ScopedContext {
  /** The tool registry, as seen from this scope (bound to it, which is what makes `restrict` legal). */
  readonly tools?: unknown
  /** The prompt registry, as seen from this scope. */
  readonly systemPrompt?: unknown
}

/** The slice of a live agent this module reads. */
interface AgentLike {
  /** Shared agent/session id, used only for diagnostics. */
  readonly id?: unknown
  /** The agent's scoped context: registrations here die with the agent. */
  readonly ctx?: ScopedContext
}

/** The `agent/created` / `agent/disposed` payloads: the agent they are about. */
interface AgentPayload {
  /** The agent being announced or torn down. */
  readonly agent?: AgentLike
}

/** The plugin context's lifecycle surface, declared structurally. */
interface LifecycleContext {
  /**
   * Listen for one agent lifecycle event.
   * @param name - event name.
   * @param listener - receives the payload.
   * @returns the disposer that removes the listener.
   */
  on?(name: string, listener: (payload: AgentPayload) => void): (() => void) | undefined
  /**
   * Bind a registration to this plugin's lifetime.
   * @param registration - registers something and returns its disposer.
   * @returns whatever the registration returned.
   */
  effect?(registration: () => unknown): unknown
}

/** The agent registry's read surface, declared structurally. */
interface AgentRegistry {
  /** All live agents, in registration order. */
  list?(): readonly AgentLike[]
}

/** What one agent currently carries: disposers to lift every restriction this module applied. */
interface AgentApplication {
  /** Reverse-order disposers: the prompt shadow and the tool mask that went with it. */
  readonly dispose: Array<() => void>
}

/** One plugin instance's visibility state. */
interface VisibilityState {
  /** The plugin context the state belongs to (and the key of {@link states}). */
  readonly context: Context
  /** The choice currently applied to every live agent. */
  mode: ToolSet
  /** Per-agent disposers, so a mode change lifts the previous mask instead of stacking one. */
  readonly applications: WeakMap<AgentLike, AgentApplication>
  /**
   * Whether the lifecycle listeners are registered. One subscription per plugin instance, made
   * unconditionally; the hook itself decides whether the agent needs anything.
   */
  subscribed: boolean
}

/** One plugin registration's state, keyed by its context: a reload starts from a clean map. */
const states = new WeakMap<Context, VisibilityState>()

/** Diagnostics already printed, so a missing optional service warns once and then stays quiet. */
const warned = new Set<string>()

/**
 * Print one diagnostic at most once per process.
 * @param key - dedupe key naming the failure site.
 * @param args - whatever the warning should show.
 */
function warnOnce(key: string, ...args: unknown[]): void {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(...args)
}

/**
 * Narrow an untyped service to the registry surface, when it looks like one.
 * @param value - the service, as the context exposed it.
 * @returns the surface, or `undefined` when the service is absent.
 */
function asTools(value: unknown): RestrictableTools | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  return value as RestrictableTools
}

/**
 * Narrow an untyped service to the prompt registry, when it looks like one.
 * @param value - the service, as the context exposed it.
 * @returns the surface, or `undefined` when the service is absent.
 */
function asPrompt(value: unknown): PromptSectionService | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as PromptSectionService
  return typeof candidate.section === 'function' ? candidate : undefined
}

/**
 * Read the names the global tool layer actually registered.
 *
 * This is the guard the whole module depends on: `restrict({ deny })` fails the entire call when any
 * one name is unknown, so a host whose kernel tools are missing must produce an empty deny list — not
 * an exception during `agent/created`. `restrictableNames` is preferred because it is the exact set
 * `restrict` validates against; `knownNames` is the fallback for a host that exposes only that half.
 * @param ctx - the plugin context.
 * @returns the known global names, or `undefined` when the registry cannot be inspected.
 */
function knownGlobalTools(ctx: Context): ReadonlySet<string> | undefined {
  const tools = asTools(readService<unknown>(ctx, 'tools'))
  if (tools === undefined || typeof tools.view !== 'function') return undefined
  try {
    const view = tools.view(undefined)
    const names = view?.restrictableNames ?? view?.knownNames
    return names === undefined ? undefined : new Set(names)
  } catch (error) {
    warnOnce('view', '[sessiongraph] the tool registry could not be inspected; tool visibility is left alone:', error)
    return undefined
  }
}

/**
 * Read an optional service without tripping Cordis's un-injected-property guard.
 *
 * `ctx.<service>` on a context that did not `inject` that service THROWS — it does not read as
 * `undefined` — so a plain property access here took down every agent creation with
 * `cannot get property "agents" without inject`. `ctx.get(name)` is the supported read, and the
 * property fallback keeps the plain test doubles working.
 * @param ctx - the plugin context (or an agent's scoped context).
 * @param name - the service name.
 * @returns the service, or undefined when this composition does not provide it.
 */
function readService<T>(ctx: unknown, name: string): T | undefined {
  const holder = ctx as { get?: (key: string) => unknown } & Record<string, unknown>
  if (typeof holder?.get === 'function') {
    try {
      return holder.get(name) as T | undefined
    } catch {
      return undefined
    }
  }
  try {
    return holder?.[name] as T | undefined
  } catch {
    return undefined
  }
}

/**
 * Validate a configured or persisted choice, falling back to the default.
 *
 * The runtime value can be `undefined` even though {@link ToolSet} says otherwise: the tests mount
 * `apply` with a partial configuration, and a hand-written config object can omit the field.
 * @param value - the candidate.
 * @returns a valid choice.
 */
export function normalizeToolSet(value: unknown): ToolSet {
  return value === 'kernel' || value === 'both' ? value : DEFAULT_TOOL_SET
}

/**
 * All live agents, tolerating a composition without the agent registry.
 * @param ctx - the plugin context.
 * @returns the live agents, newest last.
 */
function listAgents(ctx: Context): readonly AgentLike[] {
  const registry = readService<AgentRegistry>(ctx, 'agents')
  if (registry === undefined || typeof registry.list !== 'function') return []
  try {
    const agents = registry.list()
    return Array.isArray(agents) ? agents : []
  } catch (error) {
    warnOnce('list', '[sessiongraph] the agent registry could not be listed; visibility applies to new agents only:', error)
    return []
  }
}

/**
 * The names this mode must hide for one profile.
 * @param mode - the effective choice.
 * @param known - the global names that exist on this host.
 * @returns the deny list, empty when the mode hides nothing or nothing can be verified.
 */
function deniedNames(mode: ToolSet, known: ReadonlySet<string> | undefined): readonly string[] {
  // An uninspectable registry means every deny would be a guess, and a wrong name throws.
  if (known === undefined) return []
  switch (mode) {
    case 'sessiongraph':
      return KERNEL_SESSION_TOOLS.filter(name => known.has(name))
    case 'kernel':
      return known.has(SESSIONGRAPH_TOOL) ? [SESSIONGRAPH_TOOL] : []
    case 'both':
      return []
    /* v8 ignore next 2 -- exhaustive over the closed union above. */
    default:
      return []
  }
}

/**
 * The scoped prompt section that must shadow a global one for this mode.
 *
 * `both` needs none: each surface's own section describes a tool the model can actually reach.
 * @param mode - the effective choice.
 * @returns the shadow section, or `undefined` when both surfaces are visible.
 */
function replacementSection(mode: ToolSet): PromptSectionInput | undefined {
  if (mode === 'sessiongraph') {
    return { name: KERNEL_PROMPT_SECTION, order: PROMPT_ORDER, text: SESSIONGRAPH_ONLY_PROMPT_TEXT }
  }
  if (mode === 'kernel') {
    return { name: OWN_PROMPT_SECTION, order: PROMPT_ORDER, text: KERNEL_ONLY_PROMPT_TEXT }
  }
  return undefined
}

/**
 * Apply one restriction inside an agent's scope.
 * @param scope - the agent's scoped context.
 * @param deny - validated global names to hide.
 * @returns the disposer that lifts it, or `undefined` when the registry refused.
 */
function restrictWithin(scope: ScopedContext, deny: readonly string[]): (() => void) | undefined {
  const tools = asTools(readService<unknown>(scope, 'tools'))
  if (tools === undefined || typeof tools.restrict !== 'function') return undefined
  try {
    return tools.restrict({ deny })
  } catch (error) {
    // Reached when the name set changed between the check and the call. Losing a restriction is
    // recoverable (the model sees an extra tool); throwing here would take down agent creation.
    warnOnce('restrict', '[sessiongraph] tool visibility could not be restricted for one agent:', error)
    return undefined
  }
}

/**
 * Register the scoped prompt shadow inside an agent's scope.
 * @param scope - the agent's scoped context.
 * @param section - the replacement section.
 * @returns the disposer that removes it, or `undefined` when the prompt registry refused.
 */
function shadowWithin(scope: ScopedContext, section: PromptSectionInput): (() => void) | undefined {
  const prompt = asPrompt(readService<unknown>(scope, 'systemPrompt'))
  if (prompt === undefined) return undefined
  try {
    return prompt.section(section)
  } catch (error) {
    // Degrading to "no shadow" is deliberately quiet: the plugin's own section is still registered,
    // so the model keeps usable guidance and only loses the precise replacement of this one slot.
    warnOnce('section', '[sessiongraph] the kernel prompt section could not be shadowed for one agent:', error)
    return undefined
  }
}

/**
 * Remember one agent's disposers so a mode change can lift them.
 * @param state - this plugin instance's state.
 * @param agent - the agent the registration belongs to.
 * @param dispose - one disposer, already registered.
 */
function record(state: VisibilityState, agent: AgentLike, dispose: () => void): void {
  const application = state.applications.get(agent)
  if (application === undefined) {
    state.applications.set(agent, { dispose: [dispose] })
    return
  }
  application.dispose.push(dispose)
}

/**
 * Lift every restriction this module applied to one agent.
 *
 * Idempotent: an agent with no application is a no-op. Disposers run newest-first so the prompt
 * shadow is removed before the tool mask it was paired with.
 * @param state - this plugin instance's state.
 * @param agent - the agent to restore.
 */
function lift(state: VisibilityState, agent: AgentLike): void {
  const application = state.applications.get(agent)
  if (application === undefined) return
  state.applications.delete(agent)
  for (let index = application.dispose.length - 1; index >= 0; index -= 1) {
    try {
      application.dispose[index]?.()
    } catch (error) {
      warnOnce('dispose', '[sessiongraph] lifting one tool restriction failed:', error)
    }
  }
}

/**
 * The names this mode must hide on this host right now.
 * @param state - this plugin instance's state.
 * @returns the validated deny list for the current mode.
 */
function currentDenyList(state: VisibilityState): readonly string[] {
  return deniedNames(state.mode, knownGlobalTools(state.context))
}

/**
 * Register the agent lifecycle listeners, once.
 *
 * Subscribed unconditionally, and the names are re-checked inside the hook rather than here: by the
 * time `agent/created` fires every plugin's `apply` has run, so the registry is complete — whereas a
 * check at `apply` time would depend on bundle load order. A host that mounts no kernel session tools
 * simply finds an empty deny list and does nothing, which is the failure mode this ordering avoids
 * turning into "the switch silently never works".
 * @param state - this plugin instance's state.
 */
function subscribe(state: VisibilityState): void {
  if (state.subscribed) return
  state.subscribed = true
  listen(state.context, 'agent/created', payload => {
    const agent = payload.agent
    if (agent === undefined) return
    lift(state, agent)
    applyToAgent(state, agent)
  })
  // The agent-scoped effects dispose with the agent on their own; lifting here keeps the bookkeeping
  // honest and makes the disposers' lifetime explicit rather than incidental.
  listen(state.context, 'agent/disposed', payload => {
    const agent = payload.agent
    if (agent !== undefined) lift(state, agent)
  })
}

/**
 * Apply the current mode to one agent, replacing anything applied earlier.
 * @param state - this plugin instance's state.
 * @param agent - the agent to constrain.
 */
function applyToAgent(state: VisibilityState, agent: AgentLike): void {
  const scope = agent.ctx
  if (scope === undefined) return
  const deny = currentDenyList(state)
  if (deny.length > 0) {
    const dispose = restrictWithin(scope, deny)
    if (dispose !== undefined) record(state, agent, dispose)
  }
  const section = replacementSection(state.mode)
  if (section === undefined) return
  const dispose = shadowWithin(scope, section)
  if (dispose !== undefined) record(state, agent, dispose)
}

/**
 * Apply the current mode to every live agent, skipping the ones already constrained.
 * @param state - this plugin instance's state.
 */
function applyToLiveAgents(state: VisibilityState): void {
  for (const agent of listAgents(state.context)) {
    if (state.applications.has(agent)) continue
    applyToAgent(state, agent)
  }
}

/**
 * Subscribe to one agent lifecycle event, tied to this plugin's lifetime.
 * @param ctx - the plugin context.
 * @param name - the event name.
 * @param listener - receives the payload.
 */
function listen(ctx: Context, name: 'agent/created' | 'agent/disposed', listener: (payload: AgentPayload) => void): void {
  const lifecycle = ctx as unknown as LifecycleContext
  const register = (): (() => void) | undefined => {
    if (typeof lifecycle.on !== 'function') return undefined
    return lifecycle.on(name, payload => {
      // A listener failure must never surface inside the host's serial creation path: an exception
      // here would reject `announce()` and with it the agent's own creation.
      try {
        listener(payload)
      } catch (error) {
        warnOnce(`listener:${name}`, `[sessiongraph] ${name} handler failed:`, error)
      }
    })
  }
  try {
    if (typeof lifecycle.effect === 'function') lifecycle.effect(register)
    else register()
  } catch (error) {
    warnOnce(`listen:${name}`, `[sessiongraph] could not subscribe to ${name}:`, error)
  }
}

/**
 * Apply the configured `toolSet` to every live agent and to every agent created later.
 *
 * Synchronous by contract (the host calls it from `apply`): the only work done here is registering
 * two listeners and one restriction per existing agent. Every step degrades quietly — a composition
 * without the kernel tools, without the agent registry, or without the prompt registry still loads.
 * @param ctx - the plugin context.
 * @param config - the resolved plugin configuration (reads `toolSet`).
 */
export function applyVisibility(ctx: Context, config: ResolvedConfig): void {
  try {
    const state: VisibilityState = {
      context: ctx,
      mode: normalizeToolSet(config.toolSet),
      applications: new WeakMap(),
      subscribed: false,
    }
    states.set(ctx, state)
    applyToLiveAgents(state)
    subscribe(state)
  } catch (error) {
    warnOnce('apply', '[sessiongraph] tool visibility is unavailable; every session tool stays visible:', error)
  }
}

/**
 * Switch the live choice without a reload, then re-apply it to every live agent.
 *
 * This is what the settings page calls after persisting `panel.json`. A no-op when the value did not
 * change (the common case: the user saved the value that was already in effect) or when the plugin
 * never got to register its state.
 * @param ctx - the plugin context.
 * @param mode - the choice to apply.
 */
export function setToolSet(ctx: Context, mode: ToolSet): void {
  const state = states.get(ctx)
  if (state === undefined) return
  if (state.mode !== mode) {
    state.mode = mode
    for (const agent of listAgents(ctx)) {
      lift(state, agent)
      applyToAgent(state, agent)
    }
  }
  // A save must take effect even if the initial subscription could not be registered (an exotic
  // context whose `on`/`effect` threw): retrying here is free and keeps the switch working.
  subscribe(state)
}

/**
 * The choice currently in effect, as the settings page should display it.
 * @param ctx - the plugin context.
 * @returns the live mode, or `undefined` when visibility never registered.
 */
export function getToolSet(ctx: Context): ToolSet | undefined {
  return states.get(ctx)?.mode
}

/** What this host can actually switch between, so the panel greys out options that do nothing. */
export interface AvailableSessionTools {
  /** The kernel tools that exist here (empty when the bundle is not installed). */
  readonly kernel: readonly string[]
  /** Whether this plugin's own tool is registered. */
  readonly sessiongraph: boolean
}

/**
 * Report which surfaces this host registered.
 * @param ctx - the plugin context.
 * @returns the present kernel tools and whether `sessiongraph` exists.
 */
export function describeSessionTools(ctx: Context): AvailableSessionTools {
  const known = knownGlobalTools(ctx)
  return {
    kernel: known === undefined ? [] : KERNEL_SESSION_TOOLS.filter(name => known.has(name)),
    sessiongraph: known?.has(SESSIONGRAPH_TOOL) ?? false,
  }
}
