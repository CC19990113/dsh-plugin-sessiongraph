import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { UpdateChecker } from '../src/version-check.ts'
import { createUpdateChecker, readOwnVersion } from '../src/version-check.ts'
import { apply, registerUpdateNotice } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { agentIdOf } from '../src/status-hint.ts'

/** One `agent/pre-step` listener, as the host would hold it on an agent's scope. */
type PreStepListener = (
  payload: { agent?: { id?: unknown } },
  next: () => Promise<{ kind: string; messages: readonly unknown[] }>,
) => Promise<{ kind: string; messages: readonly unknown[] }>

/** The agent-scoped context an `agent/created` payload carries, holding this agent's hooks. */
interface FakeAgentScope {
  on(name: string, listener: PreStepListener): () => boolean
}

/** A context that records what `registerUpdateNotice` registers instead of running a host. */
function fakeContext(): {
  ctx: Context
  created: ((payload: { agent?: { id?: unknown; ctx?: FakeAgentScope } }) => void)[]
  disposers: (() => void)[]
} {
  const created: ((payload: { agent?: { id?: unknown; ctx?: FakeAgentScope } }) => void)[] = []
  const disposers: (() => void)[] = []
  const fake = {
    on(_name: string, listener: (payload: { agent?: { id?: unknown; ctx?: FakeAgentScope } }) => void) {
      created.push(listener)
      return () => true
    },
    effect(run: () => unknown) {
      disposers.push(run() as () => void)
      return () => Promise.resolve()
    },
  }
  return { ctx: fake as unknown as Context, created, disposers }
}

/** A fresh agent scope that records the pre-step listener registered on it. */
function fakeAgentScope(): { scope: FakeAgentScope; listeners: PreStepListener[] } {
  const listeners: PreStepListener[] = []
  return {
    scope: {
      on(_name: string, listener: PreStepListener) {
        listeners.push(listener)
        return () => true
      },
    },
    listeners,
  }
}

/** A checker that announces `0.1.16` for a `0.1.15` build, without touching a registry. */
function newerRelease(): UpdateChecker {
  return createUpdateChecker({
    packageName: 'dsh-plugin-sessiongraph',
    currentVersion: '0.1.15',
    intervalMs: 1000,
    now: () => 1_000_000,
    fetchLatest: async () => '0.1.16',
  })
}

/** Let a fire-and-forget check settle. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('registerUpdateNotice', () => {
  it('registers nothing on the plugin context itself, only a created-agent subscription', () => {
    const { ctx, created, disposers } = fakeContext()
    registerUpdateNotice(ctx, newerRelease())
    expect(created).toHaveLength(1)
    // One disposer from `ctx.effect`, holding the registration's own disposer.
    expect(disposers).toHaveLength(1)
    expect(typeof disposers[0]).toBe('function')
  })

  it('skips an agent whose payload carries no scope', () => {
    const { ctx, created } = fakeContext()
    registerUpdateNotice(ctx, newerRelease())
    const agent = fakeAgentScope()
    // No `ctx` on the payload: nothing to register on, and no throw.
    expect(() => created[0]?.({ agent: { id: 'agent-1' } })).not.toThrow()
    expect(agent.listeners).toHaveLength(0)
  })

  it('leaves a rejected step untouched', async () => {
    const { ctx, created } = fakeContext()
    registerUpdateNotice(ctx, newerRelease())
    const agent = fakeAgentScope()
    created[0]?.({ agent: { id: 'agent-1', ctx: agent.scope } })

    const rejected = { kind: 'reject', messages: [] }
    expect(await agent.listeners[0]?.({}, async () => rejected)).toEqual(rejected)
  })

  it('leaves an admitted step untouched when there is nothing to say', async () => {
    const { ctx, created } = fakeContext()
    registerUpdateNotice(ctx, newerRelease())
    const agent = fakeAgentScope()
    created[0]?.({ agent: { id: 'agent-1', ctx: agent.scope } })

    const entered = { kind: 'enter', messages: [{ id: 'one' }] }
    expect(await agent.listeners[0]?.({}, async () => entered)).toEqual(entered)
  })

  it('appends the notice to an admitted step after a tool ran in that session', async () => {
    const { ctx, created } = fakeContext()
    const checker = newerRelease()
    registerUpdateNotice(ctx, checker)
    const agent = fakeAgentScope()
    created[0]?.({ agent: { id: 'agent-1', ctx: agent.scope } })
    checker.noteToolUse('agent-1')
    await settle()

    const existing = { id: 'existing' }
    const decision = await agent.listeners[0]?.(
      {},
      async () => ({ kind: 'enter', messages: [existing] }),
    )
    expect(decision?.kind).toBe('enter')
    expect(decision?.messages).toHaveLength(2)
    expect(decision?.messages[0]).toBe(existing)
    expect(decision?.messages[1]).toMatchObject({ role: 'user', source: { form: 'notice' } })
  })

  it('does not hand a neighbour session an announcement it did not trigger', async () => {
    const { ctx, created } = fakeContext()
    const checker = newerRelease()
    registerUpdateNotice(ctx, checker)
    const first = fakeAgentScope()
    const second = fakeAgentScope()
    created[0]?.({ agent: { id: 'agent-1', ctx: first.scope } })
    created[0]?.({ agent: { id: 'agent-2', ctx: second.scope } })
    checker.noteToolUse('agent-1')
    await settle()

    const neighbour = await second.listeners[0]?.({}, async () => ({ kind: 'enter', messages: [] }))
    expect(neighbour?.messages).toHaveLength(0)
    const owner = await first.listeners[0]?.({}, async () => ({ kind: 'enter', messages: [] }))
    expect(owner?.messages).toHaveLength(1)
  })
})

/** The slice of a registered tool these integration tests drive. */
interface RegisteredTool {
  name: string
  execute(args: unknown, exec: unknown): Promise<unknown>
}

/** A plugin context holding the services `apply` injects, plus the two hook surfaces it uses. */
interface PluginHarness {
  readonly ctx: Context
  readonly tools: Map<string, RegisteredTool>
  readonly created: ((payload: { agent?: { id?: unknown; ctx?: FakeAgentScope } }) => void)[]
  readonly disposers: (() => void)[]
}

/**
 * Build the composition `apply` needs, recording registrations instead of running a host.
 * @param root - the index root the tools are configured with.
 * @returns the context and everything registered on it.
 */
function pluginContext(root: string): PluginHarness {
  const tools = new Map<string, RegisteredTool>()
  const created: ((payload: { agent?: { id?: unknown; ctx?: FakeAgentScope } }) => void)[] = []
  const disposers: (() => void)[] = []
  const fake = {
    systemPrompt: { section: () => {} },
    tools: { register: (definition: RegisteredTool) => { tools.set(definition.name, definition) } },
    sessiongraph: {
      async query(request: { operation: string }) {
        return request.operation === 'status'
          ? {
              operation: 'status',
              indexed: true,
              indexPath: join(root, 'index.db'),
              sessions: 0,
              entries: 0,
              workspaces: 0,
              indexedAt: 0,
              bytes: 0,
            }
          : { operation: 'search', hits: [], total: 0, truncated: false }
      },
      async index() {
        throw new Error('these tests never ask for an index run')
      },
    },
    on(_name: string, listener: (payload: { agent?: { id?: unknown; ctx?: FakeAgentScope } }) => void) {
      created.push(listener)
      return () => true
    },
    effect(run: () => unknown) {
      disposers.push(run() as () => void)
      return () => Promise.resolve()
    },
  }
  return { ctx: fake as unknown as Context, tools, created, disposers }
}

/**
 * A complete `apply` config over one index root.
 * @param root - the index root.
 * @param updateCheck - the switch under test.
 * @returns the config object, resolved the way the loader would hand it over.
 */
function pluginConfig(root: string, updateCheck: boolean): Config {
  return {
    indexRoot: root,
    maxLimit: 100,
    maxSnippetChars: 600,
    freshnessThresholdMs: 300_000,
    injectCommandResults: false,
    timeoutMs: 30_000,
    indexTimeoutMs: 300_000,
    updateCheck,
  }
}

/**
 * Poll an admitted step until the pending background check has settled and spoken.
 * @param listener - the pre-step listener to drive.
 * @returns the first decision that carries the notice.
 */
async function waitForNotice(listener: PreStepListener): Promise<{ kind: string; messages: readonly unknown[] }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const decision = await listener({}, async () => ({ kind: 'enter', messages: [] }))
    if (decision.messages.length > 0) return decision
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('the update notice never arrived')
}

describe('agentIdOf', () => {
  it('reads a non-empty string session id and nothing else', () => {
    expect(agentIdOf({ agent: { id: 'agent-1' } })).toBe('agent-1')
    expect(agentIdOf({ agent: { id: '' } })).toBeUndefined()
    expect(agentIdOf({ agent: { id: 7 } })).toBeUndefined()
    expect(agentIdOf({})).toBeUndefined()
    expect(agentIdOf(undefined)).toBeUndefined()
  })
})

describe('the plugin with update checking', () => {
  const roots: string[] = []

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
  })

  /** A temp directory that is removed after the test. */
  function tempDir(prefix: string): string {
    const path = mkdtempSync(join(tmpdir(), prefix))
    roots.push(path)
    return path
  }

  it('answers both tools and registers no hook when checking is switched off', async () => {
    const root = tempDir('sessiongraph-off-')
    const harness = pluginContext(root)
    apply(harness.ctx, pluginConfig(root, false))

    expect([...harness.tools.keys()].sort()).toEqual(['sessiongraph', 'sessiongraph_index'])
    expect(harness.created).toHaveLength(0)
    const value = await harness.tools.get('sessiongraph')?.execute(
      { operation: 'status' },
      { signal: new AbortController().signal },
    )
    expect(value).toMatchObject({ operation: 'status' })
  })

  it('announces a newer release on the step after a tool call', async () => {
    // The state file lives under the home directory; pointing HOME at a temp dir keeps the real one
    // untouched and makes "this process has never checked" deterministic.
    vi.stubEnv('HOME', tempDir('sessiongraph-home-'))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: '9.9.9' }), { status: 200 })))
    const root = tempDir('sessiongraph-on-')
    const harness = pluginContext(root)
    apply(harness.ctx, pluginConfig(root, true))

    expect(harness.created).toHaveLength(1)
    await harness.tools.get('sessiongraph')?.execute(
      { operation: 'status' },
      { signal: new AbortController().signal, agent: { id: 'agent-1' } },
    )

    const agent = fakeAgentScope()
    harness.created[0]?.({ agent: { id: 'agent-1', ctx: agent.scope } })
    const notice = await waitForNotice(agent.listeners[0] as PreStepListener)
    expect(notice.messages).toHaveLength(1)
    expect(notice.messages[0]).toMatchObject({
      role: 'user',
      source: {
        kind: 'dsh-plugin-sessiongraph-update',
        form: 'notice',
        // The running version comes from the package manifest, so a version bump cannot stale this test.
        summary: `dsh-plugin-sessiongraph ${readOwnVersion()} → 9.9.9`,
      },
    })
  })
})
