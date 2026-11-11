import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessiongraphHit } from 'dsh-plugin-sessiongraph-service'
import { SessiongraphSessionId } from 'dsh-plugin-sessiongraph-service'
import type { HistoryHintMessage } from '../src/history-hint.ts'
import {
  buildHistoryHint,
  createHistoryHintState,
  HISTORY_HINT_SOURCE_KIND,
  HISTORY_HINT_TEXT,
  HISTORY_QUESTION_TERMS,
  MEMORY_QUESTION_TERMS,
  lastUserText,
  looksLikeHistoryQuestion,
  noteHistoryToolUse,
  registerHistoryHint,
} from '../src/history-hint.ts'
import type { HistoryHintSearch } from '../src/history-hint.ts'

/** One `agent/pre-step` listener, as the host would hold it on an agent's scope. */
type PreStepListener = (
  payload: { agent?: { id?: unknown }; messages?: readonly unknown[]; signal?: AbortSignal | undefined },
  next: () => Promise<{ kind: string; messages: readonly unknown[] }>,
) => Promise<{ kind: string; messages: readonly unknown[] }>

/** The agent-scoped context an `agent/created` payload carries. */
interface FakeAgentScope {
  on(name: string, listener: PreStepListener): () => boolean
}

/** A context that records what `registerHistoryHint` registers instead of running a host. */
function fakeContext(): {
  ctx: Context
  created: ((payload: { agent?: { id?: unknown; ctx?: FakeAgentScope } }) => void)[]
} {
  const created: ((payload: { agent?: { id?: unknown; ctx?: FakeAgentScope } }) => void)[] = []
  const fake = {
    on(_name: string, listener: (payload: { agent?: { id?: unknown; ctx?: FakeAgentScope } }) => void) {
      created.push(listener)
      return () => true
    },
    effect(run: () => unknown) {
      return run()
    },
  }
  return { ctx: fake as unknown as Context, created }
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

/** A user message as the host builds it from something the user typed. */
function userMessage(text: string): unknown {
  return { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

/** Injected context carrying the user role, which must never be read as typed input. */
function injectedMessage(text: string): unknown {
  return { role: 'user', source: { kind: 'recall' }, content: [{ type: 'text', text }] }
}

/** One indexed hit, shaped exactly as the store reports it; only the named fields vary per test. */
function hit(overrides: {
  sessionId: string
  time: number
  workspace: string
  title?: string | undefined
}): SessiongraphHit {
  return {
    sessionId: SessiongraphSessionId(overrides.sessionId),
    source: 'dsh',
    title: overrides.title,
    workspace: overrides.workspace,
    time: overrides.time,
    kind: 'user',
    seq: 1,
    turn: undefined,
    snippet: '命中片段',
    length: 12,
  }
}

/** The text this module appended as the last message, or undefined when it appended nothing. */
function appendedText(decision: { messages: readonly unknown[] }): string | undefined {
  const last = decision.messages.at(-1) as HistoryHintMessage | undefined
  if (last === undefined || last.source.kind !== HISTORY_HINT_SOURCE_KIND) return undefined
  return last.content[0]?.text
}

/** Register the hook for one agent and hand back the listener it installed on that agent. */
function mountOneAgent(options: { search?: HistoryHintSearch } = {}): {
  listener: PreStepListener
  state: ReturnType<typeof createHistoryHintState>
} {
  const { ctx, created } = fakeContext()
  const state = createHistoryHintState()
  registerHistoryHint(ctx, state, options.search)
  const { scope, listeners } = fakeAgentScope()
  // The listener lands on the agent's own scope, which only exists once `agent/created` fired.
  for (const listener of created) listener({ agent: { id: 'agent-1', ctx: scope } })
  return { listener: listeners[0] as PreStepListener, state }
}

/** Run one admitted step through the listener with the given batch. */
async function enter(
  listener: PreStepListener,
  messages: readonly unknown[],
  signal?: AbortSignal,
): Promise<{ kind: string; messages: readonly unknown[] }> {
  return listener(
    { agent: { id: 'agent-1' }, messages, signal },
    async () => ({ kind: 'enter', messages }),
  )
}

describe('looksLikeHistoryQuestion', () => {
  it('matches the questions the index exists to answer', () => {
    expect(looksLikeHistoryQuestion('看下鸿蒙的进度到哪了')).toBe(true)
    expect(looksLikeHistoryQuestion('上次那个 SLS 凭据放哪了')).toBe(true)
    expect(looksLikeHistoryQuestion('我们之前在哪个会话里改过这个')).toBe(true)
    expect(looksLikeHistoryQuestion('这个接口昨天调通了吗')).toBe(true)
  })

  it('treats "carry on with that" as a question about the past', () => {
    // "继续" alone is ambiguous, but "继续做/接着上次" is exactly the moment a summary gets mistaken
    // for the work itself: the model needs the original conversation to know what to carry on with.
    expect(looksLikeHistoryQuestion('继续做那个鸿蒙的事')).toBe(true)
    expect(looksLikeHistoryQuestion('接着上次的发版往下弄')).toBe(true)
    expect(looksLikeHistoryQuestion('按上次那样再跑一遍')).toBe(true)
  })

  it('leaves ordinary work requests alone', () => {
    expect(looksLikeHistoryQuestion('把这个按钮颜色改成蓝色')).toBe(false)
    expect(looksLikeHistoryQuestion('跑一下测试')).toBe(false)
  })

  it('leaves memory questions to the memory layer', () => {
    // Every one of these also matches a history word (`记得`, `之前`, `说过`), and the exclusion is
    // what keeps an index pointer from competing with the memory layer's own answer.
    expect(looksLikeHistoryQuestion('你记得我喜欢什么')).toBe(false)
    expect(looksLikeHistoryQuestion('我平时写代码的习惯是什么')).toBe(false)
    expect(looksLikeHistoryQuestion('我之前说过我偏好哪种写法吗')).toBe(false)
    expect(looksLikeHistoryQuestion('记住这个约定')).toBe(false)
  })

  it('keeps the trigger vocabulary even though it can misfire', () => {
    // A deleted trigger word turns a false positive into a permanent miss, and the miss is the more
    // expensive failure; the memory terms are an exclusion list, never a replacement for this one.
    expect(HISTORY_QUESTION_TERMS).toContain('进度')
    expect(HISTORY_QUESTION_TERMS).toContain('记得')
    expect(MEMORY_QUESTION_TERMS).toEqual(['偏好', '喜欢', '习惯', '平时', '一般', '风格', '记住'])
  })
})

describe('lastUserText', () => {
  it('reads the last genuine user input', () => {
    expect(lastUserText([userMessage('第一句'), userMessage('看下进度')])).toBe('看下进度')
  })

  it('ignores injected context that carries the user role', () => {
    expect(lastUserText([userMessage('看下进度'), injectedMessage('上次的回忆片段，提到进度')])).toBe('看下进度')
  })

  it('ignores the reminder itself, so it cannot trigger on its own text', () => {
    expect(lastUserText([buildHistoryHint(), injectedMessage('上次')])).toBeUndefined()
  })

  it('returns undefined for a batch with no typed input', () => {
    expect(lastUserText([])).toBeUndefined()
    expect(lastUserText(undefined)).toBeUndefined()
  })
})

describe('buildHistoryHint', () => {
  it('is a user-role notice that a later step can tell apart', () => {
    const hint = buildHistoryHint()
    expect(hint.role).toBe('user')
    expect(hint.source.kind).toBe(HISTORY_HINT_SOURCE_KIND)
    expect(hint.source.form).toBe('notice')
    expect(hint.content[0]?.text).toContain('sessiongraph')
  })

  it('keeps the static sentence when there is nothing to point at', () => {
    expect(buildHistoryHint().content[0]?.text).toBe(HISTORY_HINT_TEXT)
    expect(buildHistoryHint([]).content[0]?.text).toBe(HISTORY_HINT_TEXT)
  })

  it('renders one navigation line per hit, with the day, workspace, title and id prefix', () => {
    const hint = buildHistoryHint([
      hit({
        sessionId: '8cb0f724-1111-2222-3333-444444444444',
        time: new Date(2026, 10, 10, 12).getTime(),
        workspace: '/Users/admin/www/dsh-plugin-codegraph',
        title: '发布流程修复',
      }),
      hit({
        sessionId: 'b2175d5e-aaaa-bbbb-cccc-dddddddddddd',
        time: new Date(2026, 10, 9, 12).getTime(),
        workspace: '/Users/admin/www/sessiongraph',
        title: 'Codex 解析',
      }),
    ])

    expect(hint.content[0]?.text.split('\n')).toEqual([
      '[会话历史] 过去相关（调 sessiongraph 按 id 查原文）：',
      '· 11-10 dsh-plugin-codegraph 发布流程修复 · 8cb0f724',
      '· 11-09 sessiongraph Codex 解析 · b2175d5e',
    ])
  })

  it('names at most three sessions however many hits it is given', () => {
    const hits = ['a1', 'b2', 'c3', 'd4', 'e5'].map((prefix, index) => hit({
      sessionId: `${prefix}0000000-1111-2222-3333-444444444444`,
      time: new Date(2026, 10, 1 + index, 12).getTime(),
      workspace: `/work/project-${prefix}`,
      title: `会话 ${prefix}`,
    }))

    const text = buildHistoryHint(hits).content[0]?.text ?? ''
    const lines = text.split('\n')

    expect(lines).toHaveLength(1 + 3)
    expect(text).toContain('a1000000')
    expect(text).toContain('c3000000')
    expect(text).not.toContain('d4000000')
    expect(text).not.toContain('e5000000')
  })

  it('names no provider and no URI scheme in the navigation block', () => {
    const text = buildHistoryHint([
      hit({
        sessionId: '8cb0f724-1111-2222-3333-444444444444',
        time: new Date(2026, 10, 10, 12).getTime(),
        workspace: '/Users/admin/www/dsh-plugin-codegraph',
        title: '发布流程修复',
      }),
    ]).content[0]?.text ?? ''

    // The block rides in the conversation; a provider name or an address scheme would be a pointer
    // into one deployment's storage rather than into this index.
    expect(text).not.toMatch(/viking:|openviking|claude|anthropic/i)
    expect(text).not.toMatch(/[a-z][a-z0-9+.-]*:\/\//i)
  })
})

describe('the pre-step hook', () => {
  it('appends one reminder when the user asks a history question', async () => {
    const { listener } = mountOneAgent()
    const messages = [userMessage('看下鸿蒙的进度到哪了')]

    const decision = await enter(listener, messages)

    expect(decision.kind).toBe('enter')
    expect(decision.messages).toHaveLength(2)
    expect((decision.messages[1] as HistoryHintMessage).source.kind).toBe(HISTORY_HINT_SOURCE_KIND)
  })

  it('calls a summary a summary without naming any memory provider', async () => {
    // The wording has to hold on a machine with no recall plugin at all, so it may not name one or
    // key off its storage format. What it must say is the part that is true everywhere: a summary is
    // not evidence.
    const { listener } = mountOneAgent()
    const decision = await enter(listener, [userMessage('上次发版到哪个版本了')])
    const appended = decision.messages.at(-1) as { content: { text: string }[] }
    const text = appended.content[0]?.text ?? ''

    expect(text).toContain('摘要')
    expect(text).toContain('不是原文')
    expect(text).toContain('sessiongraph')
    // No provider may be named, and no provider's URI scheme may be baked into the advice.
    expect(text).not.toMatch(/openviking|viking:/i)
  })

  it('says nothing for an ordinary request', async () => {
    const { listener } = mountOneAgent()

    const decision = await enter(listener, [userMessage('把这个按钮改成蓝色')])

    expect(decision.messages).toHaveLength(1)
  })

  it('reminds at most once per conversation', async () => {
    const { listener } = mountOneAgent()

    const first = await enter(listener, [userMessage('上次那个 bug 怎么修的')])
    expect(first.messages).toHaveLength(2)

    const second = await enter(listener, [userMessage('昨天说的那个方案呢')])
    expect(second.messages).toHaveLength(1)
  })

  it('stays quiet once the conversation has used the tool', async () => {
    const { listener, state } = mountOneAgent()
    noteHistoryToolUse(state, { agent: { id: 'agent-1' } })

    const decision = await enter(listener, [userMessage('看下鸿蒙的进度到哪了')])

    expect(decision.messages).toHaveLength(1)
  })

  it('passes a rejected step through untouched', async () => {
    const { listener } = mountOneAgent()

    const decision = await listener({ agent: { id: 'agent-1' }, messages: [userMessage('上次')] }, async () => ({
      kind: 'reject',
      messages: [],
    }))

    expect(decision).toEqual({ kind: 'reject', messages: [] })
  })

  it('keeps conversations apart', async () => {
    const { ctx, created } = fakeContext()
    const state = createHistoryHintState()
    registerHistoryHint(ctx, state)
    const a = fakeAgentScope()
    const b = fakeAgentScope()
    for (const listener of created) {
      listener({ agent: { id: 'agent-a', ctx: a.scope } })
      listener({ agent: { id: 'agent-b', ctx: b.scope } })
    }

    // One conversation uses the tool; the other one must still be reminded.
    noteHistoryToolUse(state, { agent: { id: 'agent-a' } })

    const decisionA = await (a.listeners[0] as PreStepListener)(
      { agent: { id: 'agent-a' }, messages: [userMessage('上次')] },
      async () => ({ kind: 'enter', messages: [userMessage('上次')] }),
    )
    const decisionB = await (b.listeners[0] as PreStepListener)(
      { agent: { id: 'agent-b' }, messages: [userMessage('上次')] },
      async () => ({ kind: 'enter', messages: [userMessage('上次')] }),
    )

    expect(decisionA.messages).toHaveLength(1)
    expect(decisionB.messages).toHaveLength(2)
  })

  it('stays the static sentence when no search is wired in', async () => {
    // Backward compatibility: a deployment that has not provided the index query keeps exactly the
    // behaviour the reminder had before the navigation block existed.
    const { listener } = mountOneAgent()

    const decision = await enter(listener, [userMessage('上次那个 bug 怎么修的')])

    expect(decision.kind).toBe('enter')
    expect(decision.messages).toHaveLength(2)
    expect(appendedText(decision)).toBe(HISTORY_HINT_TEXT)
  })

  it('injects a navigation block naming up to three sessions by id prefix', async () => {
    const { listener } = mountOneAgent({
      search: async () => [
        hit({
          sessionId: '8cb0f724-1111-2222-3333-444444444444',
          time: new Date(2026, 10, 10, 12).getTime(),
          workspace: '/Users/admin/www/dsh-plugin-codegraph',
          title: '发布流程修复',
        }),
        hit({
          sessionId: 'b2175d5e-aaaa-bbbb-cccc-dddddddddddd',
          time: new Date(2026, 10, 9, 12).getTime(),
          workspace: '/Users/admin/www/sessiongraph',
          title: 'Codex 解析',
        }),
        hit({
          sessionId: 'c3c3c3c3-9999-8888-7777-666666666666',
          time: new Date(2026, 10, 8, 12).getTime(),
          workspace: '/Users/admin/www/other',
          title: undefined,
        }),
      ],
    })

    const decision = await enter(listener, [userMessage('上次那个 SLS 凭据放哪了')])
    const appended = decision.messages.at(-1) as HistoryHintMessage
    const text = appended.content[0]?.text ?? ''
    const lines = text.split('\n')

    expect(appended.source.kind).toBe(HISTORY_HINT_SOURCE_KIND)
    expect(appended.source.form).toBe('notice')
    // One header plus one line per hit, and every line starts with the `· ` marker.
    expect(lines).toHaveLength(4)
    expect(lines[0]).toBe('[会话历史] 过去相关（调 sessiongraph 按 id 查原文）：')
    expect(lines.slice(1).every(line => line.startsWith('· '))).toBe(true)
    expect(text).toMatch(/· \d{2}-\d{2} /)
    expect(text).toContain('· 11-10 dsh-plugin-codegraph 发布流程修复 · 8cb0f724')
    expect(text).toContain('· 11-09 sessiongraph Codex 解析 · b2175d5e')
    expect(text).toContain('· 11-08 other (无标题) · c3c3c3c3')
  })

  it('stays out of a memory question, without even asking the index', async () => {
    const search = vi.fn(async () => [
      hit({
        sessionId: '8cb0f724-1111-2222-3333-444444444444',
        time: new Date(2026, 10, 10, 12).getTime(),
        workspace: '/Users/admin/www/dsh-plugin-codegraph',
        title: '发布流程修复',
      }),
    ])
    const { listener } = mountOneAgent({ search })

    const decision = await enter(listener, [userMessage('你记得我喜欢什么')])

    expect(decision.messages).toHaveLength(1)
    expect(search).not.toHaveBeenCalled()
  })

  it('asks the index at most once per conversation', async () => {
    const search = vi.fn(async () => [] as readonly SessiongraphHit[])
    const { listener } = mountOneAgent({ search })

    await enter(listener, [userMessage('上次那个 bug 怎么修的')])
    await enter(listener, [userMessage('昨天说的那个方案呢')])

    expect(search).toHaveBeenCalledTimes(1)
  })

  it('passes a signal that aborts with the step', async () => {
    const controller = new AbortController()
    let received: AbortSignal | undefined
    const { listener } = mountOneAgent({
      search: async (_query, signal) => {
        received = signal
        return []
      },
    })

    const decision = await enter(listener, [userMessage('上次那个 bug 怎么修的')], controller.signal)

    expect(received).toBeInstanceOf(AbortSignal)
    expect(received?.aborted).toBe(false)
    controller.abort()
    expect(received?.aborted).toBe(true)
    // An empty result is not a failure: the static sentence is still delivered and the step admitted.
    expect(decision.kind).toBe('enter')
    expect(appendedText(decision)).toBe(HISTORY_HINT_TEXT)
  })

  it('falls back to the static sentence when the search throws, without rejecting the step', async () => {
    // This is the first failing search in the file, so it also observes the one-time report.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { listener } = mountOneAgent({
        search: async () => {
          throw new Error('index unavailable')
        },
      })

      const decision = await enter(listener, [userMessage('上次那个 bug 怎么修的')])

      expect(decision.kind).toBe('enter')
      expect(decision.messages).toHaveLength(2)
      expect(appendedText(decision)).toBe(HISTORY_HINT_TEXT)
      expect(errors).toHaveBeenCalled()
    } finally {
      errors.mockRestore()
    }
  })

  it('treats a malformed search result as no hits', async () => {
    const { listener } = mountOneAgent({
      search: async () => 'not an array' as unknown as readonly SessiongraphHit[],
    })

    const decision = await enter(listener, [userMessage('上次那个 bug 怎么修的')])

    expect(decision.kind).toBe('enter')
    expect(appendedText(decision)).toBe(HISTORY_HINT_TEXT)
  })

  it('gives up after 300 ms and never retries that conversation', async () => {
    vi.useFakeTimers()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      let receivedSignal: AbortSignal | undefined
      const search = vi.fn((_query: string, signal?: AbortSignal) => {
        receivedSignal = signal
        return new Promise<readonly SessiongraphHit[]>(() => {})
      })
      const { listener } = mountOneAgent({ search })

      const pending = enter(listener, [userMessage('看下鸿蒙的进度到哪了')])
      // Let `next()` resolve and the deadline timer arm before advancing the clock.
      await vi.advanceTimersByTimeAsync(0)
      expect(search).toHaveBeenCalledTimes(1)

      let settled = false
      void pending.then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(299)
      // One millisecond short of the budget, the listener is still waiting on the search.
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      const decision = await pending

      expect(receivedSignal).toBeInstanceOf(AbortSignal)
      expect(decision.kind).toBe('enter')
      expect(decision.messages).toHaveLength(2)
      expect(appendedText(decision)).toBe(HISTORY_HINT_TEXT)

      // The reminder was claimed before the search, so a timed-out query costs the conversation one
      // notice, not one retry per step.
      const second = await enter(listener, [userMessage('昨天说的那个方案呢')])
      expect(second.messages).toHaveLength(1)
      expect(search).toHaveBeenCalledTimes(1)
    } finally {
      errors.mockRestore()
      vi.useRealTimers()
    }
  })

  it('covers the vocabulary the reminder is built on', () => {
    // Guard against an accidental empty table: an entry that matches nothing would silently disable
    // the whole hook.
    expect(HISTORY_QUESTION_TERMS.length).toBeGreaterThan(5)
  })
})
