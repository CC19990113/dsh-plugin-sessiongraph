/**
 * The `sessiongraph` tool family's model-facing schemas: the parameters the model fills in, the
 * per-operation defaults the seam refuses to guess, and the canonical value each operation returns.
 *
 * The query vocabulary itself is owned by the seam (`SESSIONGRAPH_OPERATIONS`,
 * `SESSIONGRAPH_ENTRY_KINDS`) and re-exported here rather than copied, so adding an entry kind in the
 * service package cannot leave the model's `kinds` filter behind. The output is a closed `oneOf` keyed
 * on `operation`, not one loose object with every field optional, so a Code Mode program that switches
 * on `operation` gets exactly the fields that operation produces and nothing it must test for.
 * @module dsh-plugin-sessiongraph-tool/schema
 */

import type { InferArgs, InferValue } from '@deepseek-ai/dsh-tools'
import { SESSIONGRAPH_ENTRY_KINDS, SESSIONGRAPH_OPERATIONS } from 'dsh-plugin-sessiongraph-service'
import type { SessiongraphOperation } from 'dsh-plugin-sessiongraph-service'

export { SESSIONGRAPH_ENTRY_KINDS, SESSIONGRAPH_OPERATIONS }

/**
 * Every operation the tool family exposes: the seam's five query operations plus `index`, which lives
 * on the dedicated `sessiongraph_index` tool because a full index run needs its own, much larger
 * timeout budget than a query.
 */
export const SESSIONGRAPH_TOOL_OPERATIONS = [...SESSIONGRAPH_OPERATIONS, 'index'] as const

/** One operation across the tool family. */
export type SessiongraphToolOperation = (typeof SESSIONGRAPH_TOOL_OPERATIONS)[number]

/** One query-side operation, i.e. everything `sessiongraph` answers and `sessiongraph_index` does not. */
export type SessiongraphQueryOperation = SessiongraphOperation

/**
 * Results returned per operation when the model names no `limit`.
 *
 * The seam requires a `limit` on every list request and has no opinion on its value, so the consumer
 * owns the defaults: a search answers with a short, scannable list, a session with enough entries to
 * be worth opening, and a workspace census with the whole machine in one page.
 */
export const SESSIONGRAPH_DEFAULT_LIMITS = {
  search: 10,
  session: 200,
  timeline: 20,
  workspaces: 50,
} as const

/** One session's metadata, as the timeline and session operations report it. */
const SESSION_SUMMARY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    session_id: { type: 'string', required: true },
    title: { type: 'string' },
    workspace: { type: 'string', required: true },
    created_at: { type: 'integer', required: true },
    last_at: { type: 'integer', required: true },
    turns: { type: 'integer', required: true },
    entries: { type: 'integer', required: true },
    parent_session: { type: 'string' },
    origin: { type: 'string' },
    agent_preset: { type: 'string' },
  },
} as const

/** The session object a `session` answer carries, marked required by its holder. */
const REQUIRED_SESSION_SUMMARY = { ...SESSION_SUMMARY, required: true } as const

/** One matched entry, with enough context to recognize it without a second query. */
const HIT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    session_id: { type: 'string', required: true },
    title: { type: 'string' },
    workspace: { type: 'string', required: true },
    time: { type: 'integer', required: true },
    kind: { type: 'string', required: true },
    seq: { type: 'integer', required: true },
    turn: { type: 'integer' },
    snippet: { type: 'string', required: true },
    length: { type: 'integer', required: true },
  },
} as const

/** One indexed entry inside a session. */
const ENTRY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    seq: { type: 'integer', required: true },
    time: { type: 'integer', required: true },
    kind: { type: 'string', required: true },
    turn: { type: 'integer' },
    text: { type: 'string', required: true },
    clipped: { type: 'boolean', required: true },
  },
} as const

/** One workspace's coverage. */
const WORKSPACE_STAT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    workspace: { type: 'string', required: true },
    sessions: { type: 'integer', required: true },
    entries: { type: 'integer', required: true },
    first_at: { type: 'integer', required: true },
    last_at: { type: 'integer', required: true },
  },
} as const

/** One source session an index run could not parse. */
const FAILED_SESSION = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    reason: { type: 'string', required: true },
  },
} as const

/** Bounds every truncatable member reports, so a capped answer is never read as a complete one. */
const COUNTS = {
  total: { type: 'integer', required: true },
  truncated: { type: 'boolean', required: true },
} as const

/**
 * Optional "this answer may predate the conversation" marker, set only when the query path tried an
 * incremental refresh and could not finish one (it failed, or was handed to a background job). An
 * answer from an index that is merely a little old keeps it absent: a boolean on every result that is
 * almost always false is noise a model learns to ignore.
 */
const STALE = {
  stale: { type: 'boolean' },
} as const

/**
 * Build one `oneOf` member for a fixed operation name.
 *
 * Both type parameters are `const` so the member keeps its literal types: without them the helper
 * would widen `operation` to the whole union and erase each member's own fields, and `InferValue`
 * would produce one shapeless object instead of a discriminated union.
 * @param operation - the literal `operation` value discriminating this member.
 * @param properties - the fields this operation returns beyond the discriminant.
 * @returns the member's value schema.
 */
function member<const O extends SessiongraphToolOperation, const P extends Record<string, unknown>>(
  operation: O,
  properties: P,
) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      operation: { type: 'string', required: true, const: operation },
      ...properties,
    },
  } as const
}

/** The canonical value every `sessiongraph` or `sessiongraph_index` call returns, keyed on `operation`. */
export const SESSIONGRAPH_OUTPUT_SCHEMA = {
  oneOf: [
    member('search', {
      hits: { type: 'array', required: true, items: HIT },
      ...COUNTS,
      ...STALE,
    }),
    member('session', {
      session: REQUIRED_SESSION_SUMMARY,
      entries: { type: 'array', required: true, items: ENTRY },
      children: { type: 'array', required: true, items: { type: 'string' } },
      truncated: { type: 'boolean', required: true },
      ...STALE,
    }),
    member('timeline', {
      sessions: { type: 'array', required: true, items: SESSION_SUMMARY },
      truncated: { type: 'boolean', required: true },
      ...STALE,
    }),
    member('workspaces', {
      workspaces: { type: 'array', required: true, items: WORKSPACE_STAT },
      total: { type: 'integer', required: true },
      ...STALE,
    }),
    member('status', {
      indexed: { type: 'boolean', required: true },
      index_path: { type: 'string', required: true },
      sessions: { type: 'integer', required: true },
      entries: { type: 'integer', required: true },
      workspaces: { type: 'integer', required: true },
      // Always present: a store that cannot distinguish live sessions omits the seam field, and the
      // tool answers `0` for it, which is what "nothing is running that this index covers" means.
      live_sessions: { type: 'integer', required: true },
      indexed_at: { type: 'integer' },
      bytes: { type: 'integer', required: true },
    }),
    // An index run on a store large enough to outlive the call is handed to the host's background
    // job registry, and the call answers before it has a report to give. `index` is therefore two
    // members rather than one object with optional counts: the started member carries only what the
    // call honestly knows — a job id — while the report member keeps every count required, so a
    // renderer never invents a zero for a run that has not finished. "0 added" and "not run yet" are
    // different answers and must stay distinguishable.
    member('index', {
      status: { type: 'string', required: true, const: 'started' },
      job_id: { type: 'string', required: true },
    }),
    member('index', {
      index_path: { type: 'string', required: true },
      added: { type: 'integer', required: true },
      updated: { type: 'integer', required: true },
      skipped: { type: 'integer', required: true },
      removed: { type: 'integer', required: true },
      discovered: { type: 'integer', required: true },
      failed: { type: 'array', required: true, items: FAILED_SESSION },
      entries: { type: 'integer', required: true },
      sessions: { type: 'integer', required: true },
      workspaces: { type: 'integer', required: true },
      bytes: { type: 'integer', required: true },
      elapsed_ms: { type: 'integer', required: true },
    }),
  ],
} as const

/**
 * The parameters the model fills in for the query tool. Which ones apply depends on `operation`; the
 * conditional requirements (`query` for `search`, `session_id` for `session`) are enforced when the
 * request is built, because the parameter DSL has no per-operation conditionals.
 */
export const SESSIONGRAPH_PARAMETERS = {
  operation: {
    type: 'string',
    required: true,
    enum: [...SESSIONGRAPH_OPERATIONS],
    description:
      'search（跨会话全文检索）、session（按 id 或唯一前缀读一个会话）、timeline（按时间列会话，新→旧）、workspaces（工作区清单与统计）、status（索引自身状态）。status 是唯一在还没有索引时也能回答的操作；要建或刷新索引请调用 sessiongraph_index 工具。',
  },
  query: {
    type: 'string',
    description: 'search 必填：检索词。中文按双字切分，两字词即可命中（例如「广告」）。',
  },
  session_id: {
    type: 'string',
    description: 'session 必填：完整会话 id，或长到只指向一个会话的前缀。',
  },
  workspace: {
    type: 'string',
    description: '只看某个工作区：精确的 cwd，或不带结尾斜杠的路径前缀。',
  },
  after: {
    type: 'number',
    description: '只要这个 epoch 毫秒时间点之后（含）的条目/会话。',
  },
  before: {
    type: 'number',
    description: '只要这个 epoch 毫秒时间点之前（含）的条目/会话。',
  },
  kinds: {
    type: 'array',
    items: { type: 'string', enum: [...SESSIONGRAPH_ENTRY_KINDS] },
    description:
      '只看这些条目类型：user（人真正打的字）、assistant（模型可见回复）、tool（工具调用的名字与参数）、title（会话标题）。省略即全部。',
  },
  limit: {
    type: 'number',
    description:
      '最多返回多少条；超出配置上限会被截断。省略按操作给默认值：search 10、timeline 20、workspaces 50、session 200 条 entries。',
  },
  offset: {
    type: 'number',
    description: '跳过前多少条，用于翻页。',
  },
} as const

/**
 * The parameters the dedicated `sessiongraph_index` tool takes: what to (re)build. It needs no
 * `operation` — building the index is the only thing this tool does — and none of the query-side
 * fields (`query`, `limit`, …), which an index run has no use for.
 */
export const SESSIONGRAPH_INDEX_PARAMETERS = {
  force: {
    type: 'boolean',
    description: '全量重建：不跳过源文件自上次索引后没有变化的会话。',
  },
  workspace: {
    type: 'string',
    description: '只索引 cwd 匹配这个工作区（精确，或不带结尾斜杠的路径前缀）的会话。',
  },
  session_id: {
    type: 'string',
    description: '只索引一个会话，按完整 id 或唯一前缀。',
  },
} as const

/** The canonical value, inferred from {@link SESSIONGRAPH_OUTPUT_SCHEMA} so the two cannot drift. */
export type SessiongraphToolValue = InferValue<typeof SESSIONGRAPH_OUTPUT_SCHEMA>

/** The validated arguments, inferred from {@link SESSIONGRAPH_PARAMETERS}. */
export type SessiongraphToolArgs = InferArgs<typeof SESSIONGRAPH_PARAMETERS>

/** The validated arguments, inferred from {@link SESSIONGRAPH_INDEX_PARAMETERS}. */
export type SessiongraphIndexToolArgs = InferArgs<typeof SESSIONGRAPH_INDEX_PARAMETERS>

/** The canonical value for one operation. */
export type SessiongraphValueFor<O extends SessiongraphToolOperation> =
  Extract<SessiongraphToolValue, { operation: O }>
