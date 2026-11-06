/**
 * Rendering tests: every operation's canonical value becomes text a reader can act on.
 *
 * The fixtures are built through `new Date(y, m, d, h, min)` and asserted through `formatTime`, which
 * uses the same local zone, so the expected strings are host-time-zone independent.
 * @module dsh-plugin-sessiongraph-tool/tests/render
 */

import { describe, expect, it } from 'vitest'
import { clipText, formatBytes, formatDuration, formatTime, renderSessiongraph } from '../src/render.ts'
import type { RenderOptions } from '../src/render.ts'
import type { SessiongraphValueFor } from '../src/schema.ts'

const OPTIONS: RenderOptions = { maxSnippetChars: 600 }

/** A fixed local-zone timestamp, so assertions never depend on the host zone. */
function at(month: number, day: number, hour: number, minute: number): number {
  return new Date(2026, month, day, hour, minute).getTime()
}

describe('formatTime', () => {
  it('renders an epoch to the minute in the local zone', () => {
    expect(formatTime(new Date(2026, 10, 3, 10, 37, 42).getTime())).toBe('2026-11-03 10:37')
  })

  it('zero-pads every field', () => {
    expect(formatTime(new Date(2026, 0, 5, 9, 4).getTime())).toBe('2026-01-05 09:04')
  })
})

describe('formatBytes', () => {
  it('renders binary units at most one decimal', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(617 * 1024 ** 2)).toBe('617 MB')
  })
})

describe('formatDuration', () => {
  it('uses seconds under a minute and minutes above it', () => {
    expect(formatDuration(12_340)).toBe('12.3 秒')
    expect(formatDuration(125_000)).toBe('2 分 5 秒')
  })
})

describe('clipText', () => {
  it('marks the cut and never exceeds the cap', () => {
    const clipped = clipText('abcdefghijklmnop', 10)
    expect(clipped).toBe('abcdefghi…')
    expect(clipped.length).toBeLessThanOrEqual(10)
    expect(clipText('short', 10)).toBe('short')
  })
})

describe('renderSessiongraph search', () => {
  const hits: SessiongraphValueFor<'search'> = {
    operation: 'search',
    hits: [
      {
        session_id: '037ad8fc-29b8-4a69-9a02-e75f9cc8fb45',
        title: '改广告 SDK',
        workspace: '/Users/admin/www/dsh-community',
        time: at(10, 3, 10, 37),
        kind: 'user',
        seq: 12,
        turn: 3,
        snippet: '我今天在改[广告]SDK',
        length: 160,
      },
      {
        session_id: 'b7f1c0de-0000-4000-8000-000000000001',
        workspace: '/Users/admin/www/dsh-plugin-other',
        time: at(10, 2, 9, 5),
        kind: 'assistant',
        seq: 4,
        snippet: '模型回复里也提到了广告',
        length: 40,
      },
    ],
    total: 7,
    truncated: true,
  }

  it('renders each hit as when/who, where, and the matched text', () => {
    const text = renderSessiongraph({ query: '广告' }, hits, OPTIONS)
    expect(text).toContain('命中 2 条')
    expect(text).toContain('共 7 条')
    expect(text).toContain('用 offset 翻页')
    expect(text).toContain('2026-11-03 10:37')
    expect(text).toContain('[user]')
    expect(text).toContain('《改广告 SDK》')
    expect(text).toContain('037ad8fc-29b8-4a69-9a02-e75f9cc8fb45')
    expect(text).toContain('第 3 轮')
    expect(text).toContain('我今天在改[广告]SDK')
    expect(text).toContain('/Users/admin/www/dsh-community')
  })

  it('names a hit that never got a title instead of leaving a blank', () => {
    const text = renderSessiongraph({ query: '广告' }, hits, OPTIONS)
    expect(text).toContain('（无标题）')
  })

  it('never emits raw JSON', () => {
    const text = renderSessiongraph({ query: '广告' }, hits, OPTIONS)
    expect(text).not.toContain('"')
    expect(text).not.toContain('{')
  })

  it('explains an empty result and the filter that caused it', () => {
    const empty: SessiongraphValueFor<'search'> = { operation: 'search', hits: [], total: 0, truncated: false }
    const text = renderSessiongraph({ query: '不存在的词', workspace: '/Users/x' }, empty, OPTIONS)
    expect(text).toContain('没有命中「不存在的词」')
    expect(text).toContain('/Users/x')
  })

  it('marks an answer served from an index the query path could not refresh', () => {
    const stale: SessiongraphValueFor<'search'> = { ...hits, stale: true }
    expect(renderSessiongraph({ query: '广告' }, stale, OPTIONS)).toContain('可能不是最新')
    expect(renderSessiongraph({ query: '广告' }, hits, OPTIONS)).not.toContain('可能不是最新')
  })
})

describe('renderSessiongraph session', () => {
  const session: SessiongraphValueFor<'session'> = {
    operation: 'session',
    session: {
      session_id: '037ad8fc-29b8-4a69-9a02-e75f9cc8fb45',
      title: '改广告 SDK',
      workspace: '/Users/admin/www/dsh-community',
      created_at: at(10, 1, 9, 0),
      last_at: at(10, 3, 11, 20),
      turns: 12,
      entries: 40,
      parent_session: 'session-parent',
      origin: 'subagent',
      agent_preset: 'standard',
    },
    entries: [
      {
        seq: 12,
        time: at(10, 3, 10, 37),
        kind: 'user',
        turn: 3,
        text: '我今天在改广告SDK',
        clipped: false,
      },
      {
        seq: 13,
        time: at(10, 3, 10, 38),
        kind: 'assistant',
        text: '这是模型回复',
        clipped: true,
      },
    ],
    children: ['child-1'],
    truncated: true,
  }

  it('leads with the identity, the span, and the provenance', () => {
    const text = renderSessiongraph({}, session, OPTIONS)
    expect(text).toContain('会话 037ad8fc-29b8-4a69-9a02-e75f9cc8fb45')
    expect(text).toContain('《改广告 SDK》')
    expect(text).toContain('2026-11-01 09:00 → 2026-11-03 11:20')
    expect(text).toContain('12 轮 · 40 条')
    expect(text).toContain('父会话 session-parent')
    expect(text).toContain('来源 subagent')
    expect(text).toContain('预设 standard')
    expect(text).toContain('子会话 1 个：child-1')
  })

  it('renders entries in order and marks a clipped one', () => {
    const text = renderSessiongraph({}, session, OPTIONS)
    expect(text).toContain('已截断')
    expect(text).toContain('[user] 第 3 轮')
    expect(text).toContain('我今天在改广告SDK')
    expect(text).toContain('[assistant]')
    expect(text).toContain('索引里只存了前缀')
  })

  it('says so when the session has no readable entries', () => {
    const empty: SessiongraphValueFor<'session'> = {
      operation: 'session',
      session: {
        session_id: 'abc',
        workspace: '/w',
        created_at: at(10, 1, 9, 0),
        last_at: at(10, 1, 9, 1),
        turns: 0,
        entries: 0,
      },
      entries: [],
      children: [],
      truncated: false,
    }
    expect(renderSessiongraph({}, empty, OPTIONS)).toContain('没有这个会话的可读条目')
  })
})

describe('renderSessiongraph timeline', () => {
  const timeline: SessiongraphValueFor<'timeline'> = {
    operation: 'timeline',
    sessions: [
      {
        session_id: 'aaaa-1111',
        workspace: '/Users/admin/www/a',
        created_at: at(10, 3, 9, 0),
        last_at: at(10, 3, 10, 0),
        turns: 2,
        entries: 8,
      },
      {
        session_id: 'bbbb-2222',
        title: '旧会话',
        workspace: '/Users/admin/www/b',
        created_at: at(9, 30, 9, 0),
        last_at: at(9, 30, 12, 0),
        turns: 5,
        entries: 20,
      },
    ],
    truncated: true,
  }

  it('lists sessions newest-first with the id a follow-up call needs', () => {
    const text = renderSessiongraph({}, timeline, OPTIONS)
    expect(text).toContain('最近 2 个会话')
    expect(text).toContain('还有更旧的')
    expect(text.indexOf('aaaa-1111')).toBeLessThan(text.indexOf('bbbb-2222'))
    expect(text).toContain('2026-11-03 10:00')
    expect(text).toContain('《旧会话》')
    expect(text).toContain('/Users/admin/www/b')
    expect(text).toContain('5 轮 / 20 条')
  })

  it('explains an empty index', () => {
    const empty: SessiongraphValueFor<'timeline'> = { operation: 'timeline', sessions: [], truncated: false }
    expect(renderSessiongraph({}, empty, OPTIONS)).toContain('还没有会话')
  })
})

describe('renderSessiongraph workspaces', () => {
  const workspaces: SessiongraphValueFor<'workspaces'> = {
    operation: 'workspaces',
    workspaces: [
      {
        workspace: '/Users/admin/www/dsh-community',
        sessions: 12,
        entries: 340,
        first_at: at(9, 1, 9, 0),
        last_at: at(10, 3, 10, 37),
      },
    ],
    total: 25,
  }

  it('reports coverage per workspace', () => {
    const text = renderSessiongraph({}, workspaces, OPTIONS)
    expect(text).toContain('工作区 1 个（共 25 个）')
    expect(text).toContain('/Users/admin/www/dsh-community · 12 会话 · 340 条')
    expect(text).toContain('2026-10-01 09:00 → 2026-11-03 10:37')
  })
})

describe('renderSessiongraph status', () => {
  it('tells the model to build the index when there is none', () => {
    const status: SessiongraphValueFor<'status'> = {
      operation: 'status',
      indexed: false,
      index_path: '/Users/admin/.dsh/sessiongraph/index.db',
      sessions: 0,
      entries: 0,
      workspaces: 0,
      live_sessions: 0,
      bytes: 0,
    }
    const text = renderSessiongraph({}, status, OPTIONS)
    expect(text).toContain('还没有索引')
    expect(text).toContain('index 操作')
    expect(text).toContain('/Users/admin/.dsh/sessiongraph/index.db')
  })

  it('reports size and freshness when there is one', () => {
    const status: SessiongraphValueFor<'status'> = {
      operation: 'status',
      indexed: true,
      index_path: '/Users/admin/.dsh/sessiongraph/index.db',
      sessions: 491,
      entries: 12345,
      workspaces: 25,
      live_sessions: 3,
      indexed_at: at(10, 3, 10, 40),
      bytes: 617 * 1024 ** 2,
    }
    const text = renderSessiongraph({}, status, OPTIONS)
    expect(text).toContain('索引就绪')
    expect(text).toContain('491 个会话')
    expect(text).toContain('12345 条可检索条目')
    expect(text).toContain('25 个工作区')
    expect(text).toContain('617 MB')
    expect(text).toContain('2026-11-03 10:40')
    expect(text).toContain('实时会话：3 个（当前还在跑、未落盘）')
  })

  it('says zero live sessions explicitly instead of dropping the line', () => {
    const status: SessiongraphValueFor<'status'> = {
      operation: 'status',
      indexed: true,
      index_path: '/Users/admin/.dsh/sessiongraph/index.db',
      sessions: 491,
      entries: 12345,
      workspaces: 25,
      live_sessions: 0,
      bytes: 617 * 1024 ** 2,
    }
    expect(renderSessiongraph({}, status, OPTIONS)).toContain('实时会话：0（当前没有正在跑的会话）')
  })
})

describe('renderSessiongraph index', () => {
  const report: SessiongraphValueFor<'index'> = {
    operation: 'index',
    index_path: '/Users/admin/.dsh/sessiongraph/index.db',
    added: 3,
    updated: 2,
    skipped: 486,
    removed: 0,
    discovered: 491,
    failed: [{ path: '/Users/admin/.dsh/sessions/x/session.v4.jsonl.zstd', reason: 'unexpected JSONL line' }],
    live_sessions: 2,
    entries: 12345,
    sessions: 491,
    workspaces: 25,
    bytes: 617 * 1024 ** 2,
    elapsed_ms: 12_340,
  }

  it('summarizes the run and names the sessions that failed', () => {
    const text = renderSessiongraph({}, report, OPTIONS)
    expect(text).toContain('建索引完成')
    expect(text).toContain('12.3 秒')
    expect(text).toContain('新增 3、更新 2、跳过 486、移除 0')
    expect(text).toContain('共发现 491 个会话')
    expect(text).toContain('解析失败 1 个')
    expect(text).toContain('unexpected JSONL line')
    expect(text).toContain('491 个会话')
    expect(text).toContain('本次重放 2 个实时会话')
  })

  it('omits the replay line when the run replayed no live session', () => {
    const quiet: SessiongraphValueFor<'index'> = { ...report, live_sessions: 0 }
    const text = renderSessiongraph({}, quiet, OPTIONS)
    expect(text).toContain('建索引完成')
    expect(text).not.toContain('本次重放')
  })

  it('says nothing failed when nothing did', () => {
    const clean: SessiongraphValueFor<'index'> = { ...report, failed: [] }
    expect(renderSessiongraph({}, clean, OPTIONS)).toContain('没有会话解析失败')
  })
})

describe('renderSessiongraph event', () => {
  const session: SessiongraphValueFor<'event'>['session'] = {
    session_id: '037ad8fc-29b8-4a69-9a02-e75f9cc8fb45',
    title: '改广告 SDK',
    workspace: '/Users/admin/www/dsh-community',
    created_at: at(10, 3, 10, 0),
    last_at: at(10, 3, 10, 40),
    turns: 3,
    entries: 12,
  }
  const event: SessiongraphValueFor<'event'> = {
    operation: 'event',
    session,
    event: {
      seq: 7,
      time: at(10, 3, 10, 37),
      type: 'tool/call',
      data: { name: 'grep', args: { pattern: '广告' } },
    },
    before: [{ seq: 6, time: at(10, 3, 10, 36), type: 'assistant/message' }],
    after: [],
  }

  it('names the event and dumps its payload as raw JSON in a fenced block', () => {
    const text = renderSessiongraph({}, event, OPTIONS)
    expect(text).toContain('事件 #7')
    expect(text).toContain('2026-11-03 10:37')
    expect(text).toContain('tool/call')
    expect(text).toContain('之前 1 条事件')
    expect(text).toContain('#6 · 2026-11-03 10:36 · assistant/message')
    expect(text).toContain('```json')
    // The payload is the original bytes, never clipped through the snippet cap.
    expect(text).toContain('"pattern": "广告"')
  })

  it('omits the neighbour blocks when the window is empty', () => {
    const alone: SessiongraphValueFor<'event'> = { ...event, before: [] }
    const text = renderSessiongraph({}, alone, OPTIONS)
    expect(text).not.toContain('之前')
    expect(text).not.toContain('之后')
  })
})

describe('renderSessiongraph trace', () => {
  const target: SessiongraphValueFor<'trace'> extends infer T
    ? T extends { kind: 'session'; target: infer S } ? S : never
    : never = {
    session_id: 'target-1',
    title: '主线',
    workspace: '/Users/admin/www/dsh-community',
    created_at: at(10, 3, 9, 0),
    last_at: at(10, 3, 10, 0),
    turns: 4,
    entries: 20,
  }
  const child = {
    session_id: 'child-1',
    title: '子任务',
    workspace: '/Users/admin/www/dsh-community',
    created_at: at(10, 3, 9, 30),
    last_at: at(10, 3, 9, 40),
    turns: 1,
    entries: 5,
  }

  it('renders the lineage with ancestors and an indented descendant tree', () => {
    const trace: SessiongraphValueFor<'trace'> = {
      operation: 'trace',
      kind: 'session',
      target,
      ancestors: [{ ...target, session_id: 'parent-1', title: '父会话' }],
      descendants: [
        { session: child, depth: 0 },
        { session: { ...child, session_id: 'grandchild-1', title: '孙会话' }, depth: 1 },
      ],
      complete: false,
    }
    const text = renderSessiongraph({}, trace, OPTIONS)
    expect(text).toContain('会话血缘')
    expect(text).toContain('祖先 1 个')
    expect(text).toContain('parent-1')
    expect(text).toContain('后代 2 个')
    const lines = text.split('\n')
    expect(lines.find(line => line.includes('child-1'))?.startsWith('  ')).toBe(true)
    // Depth is the indent: a grandchild sits one level deeper than its parent.
    expect(lines.find(line => line.includes('grandchild-1'))?.startsWith('    ')).toBe(true)
    expect(text).toContain('追踪未完成')
  })

  it('says the target is the root and has no children when the walk found nothing', () => {
    const rootOnly: SessiongraphValueFor<'trace'> = {
      operation: 'trace',
      kind: 'session',
      target,
      ancestors: [],
      descendants: [],
      complete: true,
    }
    const text = renderSessiongraph({}, rootOnly, OPTIONS)
    expect(text).toContain('没有父会话')
    expect(text).toContain('没有子会话')
    expect(text).not.toContain('追踪未完成')
  })

  it('lists the three event relationship sets', () => {
    const trace: SessiongraphValueFor<'trace'> = {
      operation: 'trace',
      kind: 'event',
      session: { ...target, session_id: 'target-1' },
      event: { seq: 7, time: at(10, 3, 10, 37), type: 'tool/result' },
      replaced_by: [9, 11],
      shadowed_seqs: [5],
      source_event_seqs: [],
    }
    const text = renderSessiongraph({}, trace, OPTIONS)
    expect(text).toContain('事件关系')
    expect(text).toContain('#7')
    expect(text).toContain('replacedBy')
    expect(text).toContain('#9, #11')
    expect(text).toContain('shadowedSeqs')
    expect(text).toContain('#5')
    expect(text).toContain('sourceEventSeqs）：没有引用其它事件')
  })
})
