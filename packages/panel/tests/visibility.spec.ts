/**
 * Host-side visibility tests: which names each `toolSet` denies, how the deny list is validated
 * against the live registry, and what happens when a mode changes at runtime.
 *
 * The context here is a structural stand-in for the two host services this module talks to
 * (`tools` and `systemPrompt`) plus the agent registry. Mounting a real Cordis registry would drag in
 * the host composition (`@deepseek-ai/dsh-scope` is a host peer, not a dependency of this package),
 * while the behaviour under test is entirely "which names did we hand to `restrict`, inside whose
 * scope, and were the old ones lifted".
 * @module dsh-plugin-sessiongraph-panel/tests/visibility
 */

import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  applyVisibility,
  KERNEL_SESSION_TOOLS,
  KERNEL_PROMPT_SECTION,
  OWN_PROMPT_SECTION,
  setToolSet,
} from '../../tool/src/visibility.ts'

/** One `restrict` call, with the agent whose scope it was made in. */
interface RestrictCall {
  readonly agent: string
  readonly deny: readonly string[]
}

/** One `systemPrompt.section` call, with the agent whose scope it was made in. */
interface SectionCall {
  readonly agent: string
  readonly name: string
  readonly order: number
  readonly text: string
}

/** A fake agent: its scope carries its own tool and prompt surfaces. */
interface FakeAgent {
  readonly id: string
  readonly created: boolean
  readonly ctx: {
    tools: unknown
    systemPrompt: unknown
    get(name: string): unknown
  }
}

/** Host-level toggles for shapes a real composition can present. */
interface HarnessOptions {
  /**
   * Omit `view` from the plugin-level registry, modelling a host whose tool registry cannot be
   * inspected. No deny list can then be computed, so nothing may be masked — or announced.
   */
  readonly uninspectable?: boolean
  /** Make `restrict` throw, modelling a registry whose name set changed under the check. */
  readonly refuseRestrict?: boolean
}

/** Which services one fake scope's `get()` reports. */
interface ScopeOptions {
  /**
   * Answer `get('tools')` with `undefined` while the `tools` property stays reachable. A
   * property-access fallback would still call `restrict`: the shape the 80179d7 fix reads through.
   */
  readonly hideToolsFromGet?: boolean
}

/**
 * Build a fake host holding `known` global tool names.
 * @param known - the names `ctx.tools.view(undefined)` reports.
 * @param options - host shapes that are not about the names.
 * @returns the context plus every registration the plugin made.
 */
function harness(known: readonly string[], options: HarnessOptions = {}): {
  ctx: Context
  agents: FakeAgent[]
  restricts: RestrictCall[]
  sections: SectionCall[]
  lifted: number
  addAgent(id: string, scopeOptions?: ScopeOptions): FakeAgent
  created: ((payload: { agent?: unknown }) => void)[]
} {
  const restricts: RestrictCall[] = []
  const sections: SectionCall[] = []
  const agents: FakeAgent[] = []
  const created: ((payload: { agent?: unknown }) => void)[] = []
  let lifted = 0
  /** A fresh scope, each with its own recorded calls so "inside whose scope" stays checkable. */
  const scopeFor = (id: string, scopeOptions: ScopeOptions = {}) => {
    const tools = {
      view: () => ({ knownNames: new Set(known), restrictableNames: new Set(known) }),
      restrict(filter: { deny?: readonly string[] }) {
        if (options.refuseRestrict === true) throw new Error('unknown tool name')
        restricts.push({ agent: id, deny: [...(filter.deny ?? [])] })
        return () => { lifted += 1 }
      },
    }
    const systemPrompt = {
      section(section: { name: string; order: number; text: string }) {
        sections.push({ agent: id, ...section })
        return () => { lifted += 1 }
      },
    }
    return {
      tools,
      systemPrompt,
      // `ctx.get(name)` is the supported service read; a scope exposing only properties would make
      // a property-access regression look like a passing test.
      get(name: string): unknown {
        if (name === 'tools') return scopeOptions.hideToolsFromGet === true ? undefined : tools
        if (name === 'systemPrompt') return systemPrompt
        return undefined
      },
    }
  }
  const globalTools = scopeFor('global').tools
  const host = {
    // The plugin-level registry: only `view` is read here, and only with `undefined` (global view).
    tools: options.uninspectable === true ? { restrict: globalTools.restrict } : globalTools,
    agents: { list: () => agents },
    on(_name: string, listener: (payload: { agent?: unknown }) => void) {
      // Every subscription, in registration order: `created[0]` is the apply hook, the next is the
      // dispose hook. Recording all of them is what makes "one unconditional pair" assertable.
      created.push(listener)
      return () => true
    },
    effect(run: () => unknown) {
      run()
      return () => Promise.resolve()
    },
  }
  return {
    ctx: host as unknown as Context,
    agents,
    restricts,
    sections,
    get lifted() { return lifted },
    addAgent(id: string, scopeOptions?: ScopeOptions) {
      const agent: FakeAgent = { id, created: false, ctx: scopeFor(id, scopeOptions) }
      agents.push(agent)
      return agent
    },
    created,
  }
}

/** The config `apply` hands over, resolved the way the loader would. */
function config(toolSet: 'sessiongraph' | 'kernel' | 'both' | undefined) {
  return { toolSet } as unknown as Parameters<typeof applyVisibility>[1]
}

describe('applyVisibility', () => {
  it('denies the kernel tools that exist under the default sessiongraph mode', () => {
    const host = harness([...KERNEL_SESSION_TOOLS, 'sessiongraph'])
    const agent = host.addAgent('agent-1')
    applyVisibility(host.ctx, config('sessiongraph'))
    expect(host.restricts).toEqual([{ agent: 'agent-1', deny: [...KERNEL_SESSION_TOOLS] }])
    expect(agent.ctx).toBeDefined()
  })

  it('skips names the host never registered instead of letting restrict throw', () => {
    // A profile without the kernel bundle: two of the five names exist.
    const host = harness(['session_search', 'sessiongraph'])
    host.addAgent('agent-1')
    expect(() => applyVisibility(host.ctx, config('sessiongraph'))).not.toThrow()
    expect(host.restricts).toEqual([{ agent: 'agent-1', deny: ['session_search'] }])
  })

  it('denies only sessiongraph itself under kernel mode', () => {
    const host = harness([...KERNEL_SESSION_TOOLS, 'sessiongraph'])
    host.addAgent('agent-1')
    applyVisibility(host.ctx, config('kernel'))
    expect(host.restricts).toEqual([{ agent: 'agent-1', deny: ['sessiongraph'] }])
  })

  it('denies nothing under both mode', () => {
    const host = harness([...KERNEL_SESSION_TOOLS, 'sessiongraph'])
    host.addAgent('agent-1')
    applyVisibility(host.ctx, config('both'))
    expect(host.restricts).toEqual([])
    expect(host.sections).toEqual([])
  })

  it('shadows the kernel prompt section when the kernel tools are hidden', () => {
    const host = harness([...KERNEL_SESSION_TOOLS, 'sessiongraph'])
    host.addAgent('agent-1')
    applyVisibility(host.ctx, config('sessiongraph'))
    expect(host.sections.map(call => ({ agent: call.agent, name: call.name }))).toEqual([
      { agent: 'agent-1', name: KERNEL_PROMPT_SECTION },
    ])
    expect(host.sections[0]?.text).toContain('sessiongraph')
  })

  it('shadows its own prompt section under kernel mode', () => {
    const host = harness([...KERNEL_SESSION_TOOLS, 'sessiongraph'])
    host.addAgent('agent-1')
    applyVisibility(host.ctx, config('kernel'))
    expect(host.sections.map(call => ({ agent: call.agent, name: call.name }))).toEqual([
      { agent: 'agent-1', name: OWN_PROMPT_SECTION },
    ])
  })

  it('applies to agents created after the plugin loaded', () => {
    const host = harness([...KERNEL_SESSION_TOOLS, 'sessiongraph'])
    applyVisibility(host.ctx, config('sessiongraph'))
    // apply hook + dispose hook, subscribed unconditionally.
    expect(host.created).toHaveLength(2)
    host.created[0]?.({ agent: host.addAgent('late-agent') })
    expect(host.restricts).toEqual([{ agent: 'late-agent', deny: [...KERNEL_SESSION_TOOLS] }])
  })

  it('stays inert when the tool registry cannot be inspected', () => {
    // The shape every other test harness in this repo has: `tools.register` and nothing else.
    const host = { tools: { register: () => undefined }, effect: (run: () => unknown) => run() }
    const ctx = host as unknown as Context
    expect(() => applyVisibility(ctx, config('sessiongraph'))).not.toThrow()
  })

  it('does not shadow the prompt when the tool registry cannot be inspected', () => {
    // `view` is absent, so no deny list can be computed and no mask is applied. A shadow claiming the
    // kernel tools are hidden would make the model stop calling tools it can still reach.
    const host = harness([...KERNEL_SESSION_TOOLS, 'sessiongraph'], { uninspectable: true })
    host.addAgent('agent-1')
    applyVisibility(host.ctx, config('sessiongraph'))
    expect(host.restricts).toEqual([])
    expect(host.sections).toEqual([])
  })

  it('does not shadow the prompt when the tool mask was refused', () => {
    // The name set changed between the check and the call, so `restrict` threw and no mask went on.
    // The prompt shadow is paired with the mask, so it must not be registered alone.
    const host = harness([...KERNEL_SESSION_TOOLS, 'sessiongraph'], { refuseRestrict: true })
    host.addAgent('agent-1')
    applyVisibility(host.ctx, config('sessiongraph'))
    expect(host.restricts).toEqual([])
    expect(host.sections).toEqual([])
  })

  it('does not restrict through a scope whose service lookup has no tool registry', () => {
    // The `tools` property is still reachable, so a fallback to property access would call `restrict`
    // anyway: reading the service through `get()` is the 80179d7 fix, and this is its guard.
    const host = harness([...KERNEL_SESSION_TOOLS, 'sessiongraph'])
    host.addAgent('agent-1', { hideToolsFromGet: true })
    applyVisibility(host.ctx, config('sessiongraph'))
    expect(host.restricts).toEqual([])
    // No mask means no prompt shadow either.
    expect(host.sections).toEqual([])
  })

  it('lifts the previous masks and applies the new mode when the setting changes', () => {
    const host = harness([...KERNEL_SESSION_TOOLS, 'sessiongraph'])
    host.addAgent('agent-1')
    applyVisibility(host.ctx, config('sessiongraph'))
    setToolSet(host.ctx, 'kernel')
    // Five kernel names then sessiongraph: the first restriction was disposed before the second.
    expect(host.restricts).toEqual([
      { agent: 'agent-1', deny: [...KERNEL_SESSION_TOOLS] },
      { agent: 'agent-1', deny: ['sessiongraph'] },
    ])
    expect(host.sections.map(call => call.name)).toEqual([KERNEL_PROMPT_SECTION, OWN_PROMPT_SECTION])
    expect(host.lifted).toBeGreaterThanOrEqual(2)
  })

  it('subscribes even when this host currently has nothing to hide', () => {
    // Unconditional on purpose: `agent/created` fires after every plugin's `apply`, so the name check
    // belongs in the hook. A profile whose kernel tools load later still gets masked for new agents.
    const host = harness(['sessiongraph'])
    applyVisibility(host.ctx, config('both'))
    expect(host.created).toHaveLength(2)
  })
})
