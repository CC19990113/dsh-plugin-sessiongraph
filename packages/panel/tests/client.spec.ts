/**
 * Client-half tests for `lib/client.js`.
 *
 * The file is a CJS factory handed to `window.__ModuleLoader__`, so it cannot be imported as a
 * module: `node --check` would even accept an `import` statement here (the package says
 * `"type": "module"`), which is exactly the mistake these tests exist to catch. It runs in a `vm`
 * sandbox shaped like the browser surface it touches — a loader that collects the spec, a React whose
 * hooks are an array, a `fetch` that records — and the component is driven by calling its props.
 * @module dsh-plugin-sessiongraph-panel/tests/client
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = resolve(here, '..', 'lib', 'client.js')
const SOURCE = readFileSync(CLIENT_PATH, 'utf8')

/** The API prefix the host side registers; both halves hardcode it. */
const API = '/dsh-plugin-sessiongraph/api'

/** One element in the fake React tree. */
interface Element {
  type: string
  props: Record<string, unknown>
  children: unknown[]
}

/** One `fetch` call. */
interface FetchCall {
  url: string
  init: { method?: string; body?: string; headers?: Record<string, string> } | undefined
}

/** The module the client file exports through the loader. */
interface ClientExports {
  name?: string
  inject?: string[]
  apply?(ctx: unknown): void
}

/** A recording React stand-in: bare element trees, hooks kept in an array. */
function fakeReact() {
  const hooks: unknown[] = []
  const effects: Array<() => void> = []
  let cursor = 0
  return {
    hooks,
    effects,
    /** Start a fresh render pass; hook slots keep their state across calls. */
    reset() {
      cursor = 0
    },
    React: {
      createElement(type: string, props: Record<string, unknown> | null, ...children: unknown[]): Element {
        return { type, props: props ?? {}, children }
      },
      useState(initial: unknown) {
        const index = cursor
        cursor += 1
        if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
        const set = (next: unknown) => {
          hooks[index] = typeof next === 'function' ? (next as (previous: unknown) => unknown)(hooks[index]) : next
        }
        return [hooks[index], set]
      },
      useEffect(effect: () => void) {
        const index = cursor
        cursor += 1
        if (!(index in hooks)) {
          hooks[index] = effect
          effects.push(effect)
        }
      },
    },
  }
}

/** What loading and mounting the client produced. */
interface LoadedClient {
  readonly spec: { id: string; factory(require: (name: string) => unknown): ClientExports }
  readonly calls: FetchCall[]
  readonly section: { meta: Record<string, unknown>; component: () => Element } | undefined
  readonly react: ReturnType<typeof fakeReact>
}

/**
 * Load the client file in a sandbox and wire the registration it makes.
 * @returns the collected spec, fetch calls, and the registered settings section.
 */
function load(): LoadedClient {
  const react = fakeReact()
  const calls: FetchCall[] = []
  let collected: LoadedClient['spec'] | undefined
  const window = {
    __ModuleLoader__: {
      load(spec: LoadedClient['spec']) {
        collected = spec
      },
    },
  }
  const sandbox = {
    window,
    console: { warn: () => undefined },
    fetch: async (url: string, init?: FetchCall['init']) => {
      calls.push({ url, init })
      // The save route echoes the choice it was given; the read route answers the default.
      const asked = init?.body === undefined ? null : (JSON.parse(init.body) as { toolSet?: string }).toolSet
      const body = asked === null
        ? { ok: true, toolSet: 'sessiongraph', available: { kernel: ['session_search'], sessiongraph: true } }
        : { ok: true, toolSet: asked, available: { kernel: ['session_search'], sessiongraph: true } }
      return { ok: true, status: 200, async json() { return body } }
    },
  }
  runInNewContext(SOURCE, sandbox)
  if (collected === undefined) throw new Error('the client never registered a loader spec')

  let section: LoadedClient['section']
  const exported = collected.factory(name => {
    if (name !== 'react') throw new Error(`unexpected require("${name}")`)
    return react.React
  })
  const slots = {
    inject(_name: string, callback: () => unknown) {
      callback()
    },
    register(meta: Record<string, unknown>, component: () => Element) {
      section = { meta, component }
      return () => undefined
    },
  }
  exported.apply?.({ slots })
  return { spec: collected, calls, section, react }
}

/** Depth-first search for the first element of one type; arrays of children are flattened. */
function find(node: Element, type: string): Element | undefined {
  if (node.type === type) return node
  for (const child of node.children) {
    const found = findIn(child, type)
    if (found !== undefined) return found
  }
  return undefined
}

/** Search one child slot, whether it holds an element or an array of them. */
function findIn(value: unknown, type: string): Element | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findIn(item, type)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (typeof value !== 'object' || value === null || !('type' in value)) return undefined
  return find(value as Element, type)
}

/** Every element of one type, depth first; arrays of children are flattened. */
function findAll(node: Element, type: string, into: Element[] = []): Element[] {
  if (node.type === type) into.push(node)
  for (const child of node.children) collect(child, type, into)
  return into
}

/** Collect one child slot into a `findAll` accumulator. */
function collect(value: unknown, type: string, into: Element[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, type, into)
    return
  }
  if (typeof value !== 'object' || value === null || !('type' in value)) return
  findAll(value as Element, type, into)
}

/** Mount the component and flush its mount-time effect. */
function mount(client: LoadedClient): Element {
  client.react.reset()
  const component = client.section?.component
  if (component === undefined) throw new Error('no component registered')
  component()
  for (const effect of client.react.effects.splice(0)) effect()
  client.react.reset()
  return component()
}

/** Let the pending fetch settle, so a re-render sees the loaded state. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

/**
 * Mount, let the initial read settle, then choose a value and re-render.
 * @param client - the loaded client.
 * @param value - the option to select.
 * @returns the tree after the change event.
 */
async function choose(client: LoadedClient, value: string): Promise<Element> {
  mount(client)
  await settle()
  const select = find(mount(client), 'select')
  ;(select?.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } })
  return mount(client)
}

/** The 保存 button of a rendered tree. */
function saveButton(tree: Element): Element | undefined {
  return findAll(tree, 'button').find(candidate => candidate.children.includes('保存'))
}

describe('the settings panel client', () => {
  it('registers one settings.section tab named 会话检索', () => {
    const client = load()
    expect(client.spec.id).toBe('dsh-plugin-sessiongraph-panel')
    expect(client.section?.meta).toMatchObject({ name: 'settings.section', id: 'sessiongraph' })
    expect((client.section?.meta.label as () => string)()).toBe('会话检索')
  })

  it('offers exactly the three frozen choices', () => {
    const tree = mount(load())
    const select = find(tree, 'select')
    expect(select).toBeDefined()
    expect(findAll(select as Element, 'option').map(option => option.props.value))
      .toEqual(['sessiongraph', 'kernel', 'both'])
  })

  it('reads the current value from the host route on mount', () => {
    const client = load()
    mount(client)
    expect(client.calls.map(call => call.url)).toEqual([API + '/tools'])
    expect(client.calls[0]?.init?.method ?? 'GET').toBe('GET')
  })

  it('posts the chosen value when 保存 is pressed', async () => {
    const client = load()
    const button = saveButton(await choose(client, 'kernel'))
    expect(button).toBeDefined()
    await (button?.props.onClick as () => Promise<void>)()
    const post = client.calls.find(call => call.init?.method === 'POST')
    expect(post?.url).toBe(API + '/tools')
    expect(JSON.parse(post?.init?.body ?? '{}')).toEqual({ toolSet: 'kernel' })
  })
})
