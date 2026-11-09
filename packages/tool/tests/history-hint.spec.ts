import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { HistoryHintMessage } from '../src/history-hint.ts'
import {
  buildHistoryHint,
  createHistoryHintState,
  HISTORY_HINT_SOURCE_KIND,
  HISTORY_QUESTION_TERMS,
  lastUserText,
  looksLikeHistoryQuestion,
  noteHistoryToolUse,
  registerHistoryHint,
} from '../src/history-hint.ts'

/** One `agent/pre-step` listener, as the host would hold it on an agent's scope. */
type PreStepListener = (
  payload: { agent?: { id?: unknown }; messages?: readonly unknown[] },
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

/** Register the hook for one agent and hand back the listener it installed on that agent. */
function mountOneAgent(): {
  listener: PreStepListener
  state: ReturnType<typeof createHistoryHintState>
} {
  const { ctx, created } = fakeContext()
  const state = createHistoryHintState()
  registerHistoryHint(ctx, state)
  const { scope, listeners } = fakeAgentScope()
  // The listener lands on the agent's own scope, which only exists once `agent/created` fired.
  for (const listener of created) listener({ agent: { id: 'agent-1', ctx: scope } })
  return { listener: listeners[0] as PreStepListener, state }
}

/** Run one admitted step through the listener with the given batch. */
async function enter(
  listener: PreStepListener,
  messages: readonly unknown[],
): Promise<{ kind: string; messages: readonly unknown[] }> {
  return listener({ agent: { id: 'agent-1' }, messages }, async () => ({ kind: 'enter', messages }))
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

  it('covers the vocabulary the reminder is built on', () => {
    // Guard against an accidental empty table: an entry that matches nothing would silently disable
    // the whole hook.
    expect(HISTORY_QUESTION_TERMS.length).toBeGreaterThan(5)
  })
})
