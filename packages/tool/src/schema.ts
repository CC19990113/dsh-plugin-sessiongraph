/**
 * The `sessiongraph` tool's model-facing schemas: the parameters the model fills in, the
 * per-operation defaults the seam refuses to guess, and the canonical value each operation returns.
 *
 * The tool exposes one operation vocabulary of eight names: the seam's seven query operations
 * (`SESSIONGRAPH_OPERATIONS`) plus `index`. An index run is a write, so it is deliberately not a seam
 * query operation — the tool routes it to `ctx.sessiongraph.index()` instead — but the model should
 * not have to know which side of the seam a question lives on, and one tool with one parameter
 * schema costs less permanent context than two.
 *
 * The query vocabulary itself is owned by the seam (`SESSIONGRAPH_OPERATIONS`,
 * `SESSIONGRAPH_ENTRY_KINDS`) and re-exported here rather than copied, so adding an entry kind in the
 * service package cannot leave the model's `kinds` filter behind. The output is a closed `oneOf` keyed
 * on `operation`, not one loose object with every field optional, so a Code Mode program that switches
 * on `operation` gets exactly the fields that operation produces and nothing it must test for.
 * @module dsh-plugin-sessiongraph-tool/schema
 */

import type { InferArgs, InferValue } from '@deepseek-ai/dsh-tools'
import { SESSIONGRAPH_ENTRY_KINDS, SESSIONGRAPH_OPERATIONS, SESSIONGRAPH_SOURCES } from 'dsh-plugin-sessiongraph-service'
import type { SessiongraphOperation } from 'dsh-plugin-sessiongraph-service'

export { SESSIONGRAPH_ENTRY_KINDS, SESSIONGRAPH_OPERATIONS, SESSIONGRAPH_SOURCES }

/**
 * Every operation the one model-facing tool exposes: the seam's queries plus the write.
 *
 * `touched` sits in the query group even though the seam's own `SESSIONGRAPH_OPERATIONS` constant does
 * not list it yet — the operation is dispatched to the store like every other query, and appending it
 * here is what keeps `index` (the write) last.
 */
export const SESSIONGRAPH_TOOL_OPERATIONS = [...SESSIONGRAPH_OPERATIONS, 'touched', 'index'] as const

/** One operation across the tool. */
export type SessiongraphToolOperation = (typeof SESSIONGRAPH_TOOL_OPERATIONS)[number]

/** One query-side operation, i.e. everything the tool answers through `ctx.sessiongraph.query`. */
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
  touched: 50,
} as const

/** One session's metadata, as the timeline, session, event and trace operations report it. */
const SESSION_SUMMARY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    session_id: { type: 'string', required: true },
    source: { type: 'string', required: true },
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
    source: { type: 'string', required: true },
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

/** One filesystem resource a session's tool calls referenced. */
const TOUCHED_RESOURCE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    kind: { type: 'string', required: true, enum: ['file', 'dir'] },
    mentions: { type: 'integer', required: true },
    first_seq: { type: 'integer', required: true },
    last_seq: { type: 'integer', required: true },
    first_at: { type: 'integer', required: true },
    last_at: { type: 'integer', required: true },
    tools: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

/** One event reduced to the fields that let a reader orient around a target. */
const RAW_EVENT_SUMMARY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    seq: { type: 'integer', required: true },
    time: { type: 'integer', required: true },
    type: { type: 'string', required: true },
  },
} as const

/** One event exactly as the session log holds it, payload included and unabridged. */
const RAW_EVENT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    seq: { type: 'integer', required: true },
    time: { type: 'integer', required: true },
    type: { type: 'string', required: true },
    // The log's event vocabulary belongs to `dsh-session`; the tool passes the payload through.
    data: { type: 'json', required: true },
  },
} as const

/** The event object an `event` answer carries, marked required by its holder. */
const REQUIRED_RAW_EVENT_SUMMARY = { ...RAW_EVENT_SUMMARY, required: true } as const

/** The unabridged event object an `event` answer carries, marked required by its holder. */
const REQUIRED_RAW_EVENT = { ...RAW_EVENT, required: true } as const

/**
 * One descendant in a lineage walk, flattened with its distance from the target.
 *
 * The seam answers a recursive tree, but this schema DSL has no `$ref`, and an unbounded recursive
 * value type would be either inaccurate or unexpressible. Flattening a depth-first walk keeps every
 * fact (the order, and each node's distance) while rendering as the same indented tree.
 */
const TRACE_DESCENDANT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    session: REQUIRED_SESSION_SUMMARY,
    depth: { type: 'integer', required: true },
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

/** The canonical value every `sessiongraph` call returns, keyed on `operation`. */
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
    // The event operation answers from the source log, so its payload is the original bytes — the
    // one place the model sees unclipped tool output. `data` is opaque JSON on purpose.
    member('event', {
      session: REQUIRED_SESSION_SUMMARY,
      event: REQUIRED_RAW_EVENT,
      before: { type: 'array', required: true, items: RAW_EVENT_SUMMARY },
      after: { type: 'array', required: true, items: RAW_EVENT_SUMMARY },
      ...STALE,
    }),
    // Two trace shapes share the operation name and differ on `kind`: a session lineage walk, and one
    // event's replacement/citation relationships. Both are cheap to describe as separate members, and
    // a renderer switching on `kind` then sees only the fields that shape produces.
    member('trace', {
      kind: { type: 'string', required: true, const: 'session' },
      target: REQUIRED_SESSION_SUMMARY,
      ancestors: { type: 'array', required: true, items: SESSION_SUMMARY },
      descendants: { type: 'array', required: true, items: TRACE_DESCENDANT },
      complete: { type: 'boolean', required: true },
      ...STALE,
    }),
    member('trace', {
      kind: { type: 'string', required: true, const: 'event' },
      session: REQUIRED_SESSION_SUMMARY,
      event: REQUIRED_RAW_EVENT_SUMMARY,
      replaced_by: { type: 'array', required: true, items: { type: 'integer' } },
      shadowed_seqs: { type: 'array', required: true, items: { type: 'integer' } },
      source_event_seqs: { type: 'array', required: true, items: { type: 'integer' } },
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
    // The resources one session's tool calls named, most-referenced first. `unparsed` is required
    // rather than optional: "two files" and "two files out of forty unreadable calls" are different
    // answers, and the renderer can only tell the reader which one it has if the count is always
    // present.
    member('touched', {
      session_id: { type: 'string', required: true },
      resources: { type: 'array', required: true, items: TOUCHED_RESOURCE },
      ...COUNTS,
      unparsed: { type: 'integer', required: true },
      ...STALE,
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
      // Always present and normalized to 0 by the tool; the renderer omits the line at 0 so a routine
      // incremental run does not print "replayed 0 live sessions" every time.
      live_sessions: { type: 'integer', required: true },
      entries: { type: 'integer', required: true },
      sessions: { type: 'integer', required: true },
      workspaces: { type: 'integer', required: true },
      bytes: { type: 'integer', required: true },
      elapsed_ms: { type: 'integer', required: true },
    }),
  ],
} as const

/**
 * The parameters the model fills in. Which ones apply depends on `operation`; the conditional
 * requirements (`query` for `search`, `session_id` for `session`/`event`/`trace`, `seq` for `event`)
 * are enforced when the request is built, because the parameter DSL has no per-operation
 * conditionals. `operation` itself is optional and defaults to `search` (applied once, in the tool's
 * entry layer), so the common case — a plain cross-session search — names only `query`.
 */
export const SESSIONGRAPH_PARAMETERS = {
  operation: {
    type: 'string',
    enum: [...SESSIONGRAPH_TOOL_OPERATIONS],
    description:
      '省略即 search（默认）：只传 query 就是一次跨会话检索。'
      + 'search（跨会话全文检索）、session（按 id 或唯一前缀读一个会话）、event（读某一条原始事件，含前后窗口）、'
      + 'trace（追踪会话血缘，或某条事件的替换/引用关系）、timeline（按时间列会话，新→旧）、'
      + 'workspaces（工作区清单与统计）、touched（一个会话读写过哪些文件/目录，读/编辑/写/read_image/grep/glob 的调用）、'
      + 'status（索引自身状态）、index（建或刷新索引）。'
      + 'status 是唯一在还没有索引时也能回答的操作；索引不存在时其它操作会失败，先跑 index。',
  },
  query: {
    type: 'string',
    description: 'search 必填：检索词。中文按双字切分，两字词即可命中（例如「广告」）。',
  },
  session_id: {
    type: 'string',
    description:
      'session / event / trace / touched 必填，search 可选：完整会话 id，或长到只指向一个会话的前缀。'
      + 'search 带上它就在这一个会话里检索；session 打开该会话；touched 列出该会话读写过的文件。',
  },
  seq: {
    type: 'number',
    description:
      'event 必填：目标事件的 seq。trace 给出时追踪这一条事件的关系（replacedBy / shadowedSeqs / sourceEventSeqs），'
      + '省略则追踪会话血缘。',
  },
  window_before: {
    type: 'number',
    description: 'event 可选：额外返回目标事件之前的多少条原始事件摘要（默认 0）。',
  },
  window_after: {
    type: 'number',
    description: 'event 可选：额外返回目标事件之后的多少条原始事件摘要（默认 0）。',
  },
  depth: {
    type: 'number',
    description: 'trace 可选：向下追踪的最大层数；省略表示整棵树。',
  },
  workspace: {
    type: 'string',
    description: '只看某个工作区：精确的 cwd，或不带结尾斜杠的路径前缀；也可用于 index 限定索引范围。',
  },
  source: {
    type: 'string',
    enum: [...SESSIONGRAPH_SOURCES],
    description:
      '只看某个 agent 写的会话：dsh（本宿主 ~/.dsh/sessions）、codex（Codex 的 rollout 日志）。'
      + '省略即全部来源。search / timeline / workspaces 可用。',
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
  dedupe_by_session: {
    type: 'boolean',
    description:
      'search 可选：每个会话最多返回一条（最强的那条）。默认 true；只给了 session_id 做单会话检索时默认 false，'
      + '因为那样只会剩一条结果。',
  },
  limit: {
    type: 'number',
    description:
      '最多返回多少条；超出配置上限会被截断。省略按操作给默认值：search 10、timeline 20、workspaces 50、session 200 条 entries、'
      + 'touched 50 个资源。',
  },
  offset: {
    type: 'number',
    description:
      '跳过前多少条，用于翻页。search、session、timeline、workspaces、touched 五个操作都支持：search 跳过命中、'
      + 'session 跳过条目、timeline 跳过会话、workspaces 跳过工作区、touched 跳过资源。',
  },
  force: {
    type: 'boolean',
    description: 'index 可选：全量重建，不跳过源文件自上次索引后没有变化的会话。',
  },
} as const

/** The canonical value, inferred from {@link SESSIONGRAPH_OUTPUT_SCHEMA} so the two cannot drift. */
export type SessiongraphToolValue = InferValue<typeof SESSIONGRAPH_OUTPUT_SCHEMA>

/** The validated arguments, inferred from {@link SESSIONGRAPH_PARAMETERS}. */
export type SessiongraphToolArgs = InferArgs<typeof SESSIONGRAPH_PARAMETERS>

/** The canonical value for one operation. */
export type SessiongraphValueFor<O extends SessiongraphToolOperation> =
  Extract<SessiongraphToolValue, { operation: O }>
