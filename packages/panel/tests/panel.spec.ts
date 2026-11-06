/**
 * Host-side panel tests: the two routes, the persisted settings file, and the fact that a save is
 * applied to the live agents rather than only stored.
 *
 * The context is a structural stand-in for the services `apply` uses plus a fake web server, so the
 * route handler runs for real: `handleRequest` is driven through the registration the plugin made,
 * not called directly. That is the part a unit test can drift from, so it is the part this exercises.
 * @module dsh-plugin-sessiongraph-panel/tests/panel
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { applyPanel, PANEL_FILE_NAME, PANEL_ROUTE_PREFIX } from '../../tool/src/panel.ts'
import { applyVisibility, KERNEL_SESSION_TOOLS } from '../../tool/src/visibility.ts'

/** One recorded `restrict` call. */
interface RestrictCall {
  readonly agent: string
  readonly deny: readonly string[]
}

/** The response shape the fake web server writes into. */
interface FakeResponse {
  statusCode: number
  readonly headers: Record<string, string>
  body: string
  setHeader(name: string, value: string): void
  end(body?: string): void
}

/** The request shape the handler reads: method, target, and an optional JSON body. */
function request(method: string, path: string, body?: unknown): {
  url: string
  method: string
  [Symbol.asyncIterator](): AsyncIterator<Buffer>
} {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    url: PANEL_ROUTE_PREFIX + path,
    method,
    [Symbol.asyncIterator]() {
      let index = 0
      return {
        async next() {
          if (index >= chunks.length) return { done: true, value: undefined }
          const value = chunks[index]
          index += 1
          return { done: false, value }
        },
      }
    },
  }
}

/** A response object a test can read back after the handler settles. */
function response(): FakeResponse {
  const headers: Record<string, string> = {}
  return {
    statusCode: 0,
    headers,
    body: '',
    setHeader(name, value) {
      headers[name.toLowerCase()] = value
    },
    end(body) {
      this.body = body ?? ''
    },
  }
}

/** Everything the harness recorded, plus the route handler the plugin registered. */
interface PanelHarness {
  readonly ctx: Context
  readonly restricts: RestrictCall[]
  readonly sections: string[]
  handler(method: string, path: string, body?: unknown): Promise<{ code: number; json: Record<string, unknown> }>
}

/**
 * Build a fake host over one index root.
 * @param options - index root, tool names, and whether an `fs` seam is present.
 * @returns the context and a helper that drives the registered route.
 */
function harness(options: { root: string; known?: readonly string[]; seam?: boolean }): PanelHarness {
  const known = options.known ?? [...KERNEL_SESSION_TOOLS, 'sessiongraph']
  const restricts: RestrictCall[] = []
  const sections: string[] = []
  const agents: Array<{ id: string; ctx: unknown }> = [{ id: 'agent-1', ctx: undefined }]
  const registered: Array<{ handler: (req: unknown, res: unknown) => void | Promise<void> }> = []
  /** A scope per agent: `restrict` must be called on the agent's own context, never the plugin's. */
  const scope = (id: string) => ({
    tools: {
      view: () => ({ knownNames: new Set(known), restrictableNames: new Set(known) }),
      restrict(filter: { deny?: readonly string[] }) {
        restricts.push({ agent: id, deny: [...(filter.deny ?? [])] })
        return () => undefined
      },
    },
    systemPrompt: {
      section(section: { name: string }) {
        sections.push(section.name)
        return () => undefined
      },
    },
  })
  for (const agent of agents) agent.ctx = scope(agent.id)
  const webServer = {
    register(route: { handler: (req: unknown, res: unknown) => void | Promise<void> }) {
      registered.push(route)
      return () => undefined
    },
  }
  const host = {
    tools: scope('global').tools,
    agents: { list: () => agents },
    systemPrompt: scope('global').systemPrompt,
    on: () => () => true,
    effect: (run: () => unknown) => run(),
    inject(_deps: string[], callback: (child: unknown) => void) {
      callback({ webServer, effect: (run: () => unknown) => run() })
    },
    ...(options.seam === true
      ? {
          fs: {
            async resolve(path: string) { return { path } },
            async writeText() { return undefined },
          },
        }
      : {}),
  }
  return {
    ctx: host as unknown as Context,
    restricts,
    sections,
    async handler(method, path, body) {
      const route = registered[0]
      if (route === undefined) throw new Error('the plugin registered no route')
      const res = response()
      await route.handler(request(method, path, body), res)
      return { code: res.statusCode, json: JSON.parse(res.body) as Record<string, unknown> }
    },
  }
}

/** The config `apply` hands over, resolved the way the loader would. */
function config(indexRoot: string, toolSet?: 'sessiongraph' | 'kernel' | 'both') {
  return { indexRoot, ...(toolSet === undefined ? {} : { toolSet }) } as unknown as Parameters<typeof applyPanel>[1]
}

/** Temp index roots created by one test, removed afterwards. */
const roots: string[] = []

/** A fresh temp index root. */
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sessiongraph-panel-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('applyPanel', () => {
  it('answers the current choice and which tools this host registered', async () => {
    const root = tempRoot()
    const panel = harness({ root })
    applyVisibility(panel.ctx, config(root, 'sessiongraph'))
    applyPanel(panel.ctx, config(root, 'sessiongraph'))

    const answer = await panel.handler('GET', '/tools')
    expect(answer.code).toBe(200)
    expect(answer.json).toMatchObject({ ok: true, toolSet: 'sessiongraph' })
    expect(answer.json.available).toEqual({ kernel: [...KERNEL_SESSION_TOOLS], sessiongraph: true })
  })

  it('persists a save and re-applies it to the live agents', async () => {
    const root = tempRoot()
    const panel = harness({ root })
    applyVisibility(panel.ctx, config(root, 'sessiongraph'))
    applyPanel(panel.ctx, config(root, 'sessiongraph'))
    expect(panel.restricts).toEqual([{ agent: 'agent-1', deny: [...KERNEL_SESSION_TOOLS] }])

    const saved = await panel.handler('POST', '/tools', { toolSet: 'kernel' })
    expect(saved.code).toBe(200)
    expect(saved.json).toMatchObject({ ok: true, toolSet: 'kernel' })
    // The first mask was lifted and the new one applied inside the same agent scope.
    expect(panel.restricts.at(-1)).toEqual({ agent: 'agent-1', deny: ['sessiongraph'] })

    const file = JSON.parse(readFileSync(join(root, PANEL_FILE_NAME), 'utf8')) as Record<string, unknown>
    expect(file.toolSet).toBe('kernel')
    expect(typeof file.updatedAt).toBe('number')

    // Read back through the route, not the file: the answer must be the applied value.
    const again = await panel.handler('GET', '/tools')
    expect(again.json).toMatchObject({ ok: true, toolSet: 'kernel' })
  })

  it('applies the persisted choice on the next load', async () => {
    const root = tempRoot()
    const first = harness({ root })
    applyVisibility(first.ctx, config(root, 'sessiongraph'))
    applyPanel(first.ctx, config(root, 'sessiongraph'))
    await first.handler('POST', '/tools', { toolSet: 'kernel' })

    // A fresh context stands in for a restart: same index root, default config.
    const second = harness({ root })
    applyVisibility(second.ctx, config(root, 'sessiongraph'))
    applyPanel(second.ctx, config(root, 'sessiongraph'))
    expect(second.restricts.at(-1)).toEqual({ agent: 'agent-1', deny: ['sessiongraph'] })
    expect((await second.handler('GET', '/tools')).json).toMatchObject({ toolSet: 'kernel' })
  })

  it('rejects a body that names no valid choice, leaving the file untouched', async () => {
    const root = tempRoot()
    const panel = harness({ root })
    applyVisibility(panel.ctx, config(root, 'sessiongraph'))
    applyPanel(panel.ctx, config(root, 'sessiongraph'))

    const answer = await panel.handler('POST', '/tools', { toolSet: 'everything' })
    expect(answer.code).toBe(400)
    expect(answer.json).toMatchObject({ ok: false })
    expect(readdirSync(root)).toEqual([])
  })

  it('rejects malformed JSON and unknown routes', async () => {
    const root = tempRoot()
    const panel = harness({ root })
    applyVisibility(panel.ctx, config(root, 'sessiongraph'))
    applyPanel(panel.ctx, config(root, 'sessiongraph'))

    const broken = await panel.handler('POST', '/tools', undefined)
    expect(broken.code).toBe(400)
    const missing = await panel.handler('GET', '/nothing')
    expect(missing.code).toBe(404)
  })

  it('writes through the host fs seam when there is one', async () => {
    const root = tempRoot()
    const panel = harness({ root, seam: true })
    applyVisibility(panel.ctx, config(root, 'sessiongraph'))
    applyPanel(panel.ctx, config(root, 'sessiongraph'))
    await panel.handler('POST', '/tools', { toolSet: 'both' })
    // The seam took the write, so the fallback path left no file behind.
    expect(readdirSync(root)).toEqual([])
  })

  it('creates a missing index root on the node:fs fallback', async () => {
    const parent = tempRoot()
    const root = join(parent, 'nested', 'index')
    const panel = harness({ root })
    applyVisibility(panel.ctx, config(root, 'sessiongraph'))
    applyPanel(panel.ctx, config(root, 'sessiongraph'))
    await panel.handler('POST', '/tools', { toolSet: 'kernel' })
    const file = JSON.parse(readFileSync(join(root, PANEL_FILE_NAME), 'utf8')) as Record<string, unknown>
    expect(file.toolSet).toBe('kernel')
  })
})
