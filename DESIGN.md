# sessiongraph 内部设计（实现契约）

> 目标：把本机 `~/.dsh/sessions` 下**全部会话**当成一个仓库，预建一份 SQLite 索引，
> 让模型通过 `sessiongraph` 工具**秒级**检索「上次在哪个会话里说过/做过什么」。

## 1. 数据源

两个 harness，解析进同一个库，`session.source` 记录来源。

### 1.1 DSH 自己的日志

布局：`~/.dsh/sessions/<escaped-cwd>/<session-id>/session.v4.jsonl.zstd`

- `<escaped-cwd>`：工作区绝对路径转义，形如 `--Users-<user>-www-<project>--`
- 会话目录：`037ad8fc-29b8-4a69-9a02-e75f9cc8fb45`（**裸 uuid，无 `session-` 前缀**）
- 文件：`session.v4.jsonl.zstd`（zstd 压缩的 JSONL），另有 `session.lock`（忽略）
- 规模参考：一个日常开发机量级的库约六百余个会话（`session.v4` 为主，`session.v3` 为历史遗留）/
  二十余个工作区 / 压缩比约 3×（举例：617MB 压缩解压出 1.6GB）/ 单会话最大可达数十 MB
- 版本差异：`v3` 的目录名与 header `id` 都带 `session-` 前缀，`v4` 是裸 uuid；
  事件结构两版兼容，`user/message.data.source.kind` 两版都有

### 解压：多帧 zstd（**最容易踩的坑**）

会话文件是**多帧 zstd 追加写**的：一个 200KB 量级的文件可以含上百个 frame。
`zstdDecompressSync(buf)` 只解压**第一帧**（该文件只出 292 字节），必须按 magic number
`28 B5 2F FD` 切帧、逐帧解压、拼接。

```ts
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function decompressSessionLog(buffer: Buffer): Buffer {
  const offsets: number[] = []
  let at = buffer.indexOf(ZSTD_MAGIC)
  while (at !== -1) {
    offsets.push(at)
    at = buffer.indexOf(ZSTD_MAGIC, at + ZSTD_MAGIC.length)
  }
  if (offsets.length === 0) throw new Error('not a zstd stream')
  const parts: Buffer[] = []
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index]!
    const end = index + 1 < offsets.length ? offsets[index + 1]! : buffer.length
    parts.push(zstdDecompressSync(buffer.subarray(start, end)))
  }
  return Buffer.concat(parts)
}
```

实测：一个六百余文件的日志库全部逐帧解压成功、0 失败。

用 `node:zlib`，**不要**调用外部 `zstd` 二进制。

### 事件结构

第一行是会话头（**平铺，无 `data` 字段**）：

```json
{"type":"session","version":4,"id":"...","createdAt":1793349570839,
 "cwd":"/path/to/project","parentSession":"session-xxx",
 "isSeeded":false,"origin":"subagent","delegationDepth":1,"agentPreset":"standard"}
```

其后每行：

```json
{"type":"<event>","seq":<number>,"time":<epoch-ms>,"data":{...},"surfaceOp":"append"}
```

抽样字节占比（25 会话 / 76.6MB 解压后）：

| 事件 | 占比 | 处置 |
|---|---|---|
| `assistant/message` | 61.2% | 只取 `data.message.content[]` 里 `type === 'text'` 的块（`reasoning` 占 4.67MB 不索引；`tool-call` 块由 `tool/call` 事件补） |
| `tool/result` | 15.3% | **不索引正文** |
| `request/header` | 11.1% | 跳过 |
| `tool/call` | 5.3% | 索引 `data.name` + `data.arguments`（截断 2KB） |
| `user/message` | 1.9% | 只取 `data.source.kind === 'user'`（真实人类输入），其它（`runtime-context`/`skill-catalog`/`time-context`/`agent-message`/`plugin:*` 等注入内容）全部跳过 |
| `session/title` | 0.02% | `data.title`（取**最后一条**，覆盖 fallback） |

关键字段：

- `user/message`：`data.content[].text`，`data.source.kind`，`data.role`
- `assistant/message`：`data.message.content[]`，块 `type`: `reasoning` | `text` | `tool-call`
- `tool/call`：`data.name`、`data.arguments`（字符串化的 JSON）、`data.turn`、`data.step`、`data.callId`
- `turn/start`：`data.turn`

### 1.2 Codex 的 rollout 日志

启用条件：`codex: true`（默认）且 `~/.codex` 存在；`codexRoot` 可换 home。

两处布局，同一文件形状（zstd + JSONL，实测单帧）：

- `~/.codex/archived_sessions/rollout-<iso>-<uuid>.jsonl.zst`（扁平，归档）
- `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<iso>-<uuid>.jsonl.zst`（按日期分层，活会话）

每行是信封 `{ timestamp, ordinal, type, payload }`，`ordinal` 就是 `seq`。四种 type 有关：

| type | 用途 |
|---|---|
| `session_meta` | `payload.session_id` / `cwd` / `timestamp` / `originator` / `cli_version` |
| `turn_context` | `payload.turn_id` 变化计一轮；`payload.model` 记为 `agent_preset` |
| `response_item` / `message` | `role` 为 `user` / `assistant` / `developer` |
| `response_item` / `function_call`、`custom_tool_call`、`web_search_call` | 工具调用（`name` + `arguments` / `input` / `query`） |

跳过：`developer` 角色（整套指令集）、`reasoning`、所有 `*_output`（工具结果）、`event_msg/*`（token 计数等）、`compacted`（别的模型写的交接摘要）。

**注入剥离**：`user` 角色里混着 `<environment_context>` / `<user_instructions>` / `<permissions instructions>` / `<turn_aborted>`，按标签整块删掉再 trim，剩空就丢。本机 1678 条 user 记录里 251 条剥完是空。

**标题**：rollout 里没有，来自 `~/.codex/session_index.jsonl` 的 `{ id, thread_name }`，每轮读一次建映射传进解析器（解析器保持纯函数）。

**去重**：同一会话可能同时出现在 `archived_sessions/` 和 `sessions/`，所以候选集按 `session.id` 去重（保留 `lastAt` 更大的那份），而不是按路径。

**native 边界**：Rust 内核自 0.3.2 起也解析 Codex（`codex.rs`），两源按 `source` 分派。两套引擎的对拍方法：拿一份**冻结快照**（复制会话文件，排除活会话边写边读）双引擎各跑一遍，逐数比对；真实库里两次 run 相差几条通常是读取时刻不同，不是解析分歧。

## 2. 索引库

位置：`<indexRoot>/index.db`，`indexRoot` 默认 `~/.dsh/sessiongraph`。

schema 见 `packages/service/src/schema.ts`（`SCHEMA_STATEMENTS`），三方共享，**只改那一处**。

表：

- `session(id PK, source, workspace, title, created_at, last_at, parent_session, origin, agent_preset, turns, entries, source_path, source_mtime, source_size)`
  - `source` 是 `dsh` / `codex`（`SESSIONGRAPH_SOURCES`，闭集）；不在闭集里的值按 `SESSIONGRAPH_CORRUPT` 拒绝，和 schema 版本不匹配同类处理
- `entry(id PK, session_id, seq, time, turn, kind, text, clipped)`
- `entry_fts(tokens)` FTS5，`rowid` 对齐 `entry.id`，tokenizer `unicode61`
- `meta(key, value)`：`schema_version` / `indexed_at` / `discovered` / `failed`

索引写入用 `node:sqlite` 的 `DatabaseSync`（同步 API，实测可用，SQLite 3.50.4，FTS5 与 trigram 均编译进）。

## 3. 中文检索：bigram

实测结论（SQLite 3.50.4）：

- `unicode61` 把整句中文当一个 token → `广告` **查不到** `我今天在改广告SDK`
- `trigram` 要求 ≥3 字符 → 两字词 `广告` 查不到
- **自建 bigram**：写入时把中文连续段切成重叠双字，查询同样切 → 两字词、多字词全部命中

实现：`packages/service/src/tokenize.ts`（`tokenize` / `matchExpression` / `highlightTerms`）。两侧必须共用。

规则：

- 中文连续段 → 双字 bigram（单字保留单字）
- 英文/数字/下划线连续段 → 小写整词
- 其它字符丢弃
- 查询：token 双引号包裹、`AND` 连接（召回优先，允许非相邻命中）

片段高亮：拿原文找 `highlightTerms(query)` 里最长命中，截 ±60 字窗口，命中处包 `[` `]`。

## 4. 查询词汇

`SessiongraphRequest` 判别联合（`packages/service/src/types.ts`），**八个**查询操作：

| operation | 作用 |
|---|---|
| `search` | 全文检索，可按 `sessionId` / `workspace` / `source` / `after` / `before` / `kinds` 过滤，默认同会话去重（`dedupeBySession`），返回命中列表（含 `source` 与片段） |
| `session` | 按完整 id 或唯一前缀读一个会话（元信息 + 有序 entries + 子会话） |
| `event` | 读一条**未删节**的原始事件（回读源日志，不读索引里的裁剪文本）+ 可选前后窗口 |
| `trace` | 无 `seq` → 会话血缘（祖先链 + 递归后代树，`complete` 区分「根」与「走不动」）；有 `seq` → 事件替换链 / 遮蔽范围 / 引用源事件 |
| `timeline` | 按时间列会话（可过滤 workspace / source），新→旧 |
| `workspaces` | 工作区清单与统计（会话数、条目数、时间跨度），可按 source 只看一侧 |
| `status` | 索引自身状态；**唯一**在无索引时也返回结果的操作 |
| `touched` | 一个会话碰过哪些文件：从该会话的 `tool` 条目现算，不依赖任何新表 |

**`touched` 为什么现算而不建表。** 痕迹图（session → 文件）看着像该物化的东西，但它的全部输入
已经在 `entry.text` 里：单会话 tool 条目均值 124、最大 1504（822 会话 / 95,890 条实测），
现算一次是毫秒级 —— 实测 1504 条的会话 3 ms。物化的代价则是 schema v4、全机索引重建、以及 Rust
内核里第二份解析实现，为一条永远能从 `entry.text` 重算出来的关系。抽取只认结构化参数
（`read`/`edit`/`write`/`read_image` 的 `file_path`，`grep`/`glob` 的 `path`）：`bash` 占 tool 条目的
55%，命令行是自由文本，从中抽路径是猜而不是解析，所以整个排除在外；被索引截断到 2KB 的调用进
`unparsed`，同样不猜。

**`index` 不在这八个里面。** 它是写操作，由工具层直接调 `ctx.sessiongraph.index()`；放进查询
联合会让「只读 provider」这个约定失效。

### 排序权重

`ORDER BY bm25(entry_fts) / w(kind)`，`user 1.0 / title 1.1 / assistant 1.2 / tool 1.5`。

**必须除以权重，不能乘。** FTS5 的 bm25 是负数（越负越好），乘法等于给大权重加分 —— 实测
top20 会全部变成 `tool/call`，正好和「用户输入优先」相反。Rust 内核必须用同一份权重表与同样的
除法，否则两条路径的排序会静默分叉。

服务类：`packages/service/src/index.ts` 的 `Sessiongraph`（`ctx.sessiongraph`），
「exactly one claimant」路由：`indexes()` / `canIndex()` 并发询问所有 provider，0 个或多个都抛错。

## 5. 包职责（写作用域互不重叠）

| 包 | 职责 | 只写这些文件 |
|---|---|---|
| `service`（契约） | 契约、schema、tokenizer、seam | — |
| `sessions`（indexer） | 扫描 + zstd 解压 + JSONL 解析 + 写 `index.db` + `raw.ts` 未删节事件回读 | `packages/sessions/**` |
| `sqlite`（store） | 读 `index.db`，实现八个查询；`native-query.ts` 做 native/TS 引擎路由 | `packages/sqlite/**` |
| `native`（引擎） | 暴露 Rust 内核：`indexSessions`（写）+ `query`（读） | `packages/native/**` |
| `tool`（consumer） | **一个** `sessiongraph` 工具（九个 operation）+ 系统提示段 + `panel.ts`（HTTP 路由）+ `visibility.ts`（工具可见性） | `packages/tool/**` |
| `panel`（客户端） | 设置页「会话检索」：`lib/host.js` 空 apply + `lib/client.js` CJS factory | `packages/panel/**` |
| `bundle` | `cordis.patch.yml` | `packages/bundle/**` |
| `crates/sessiongraph-core` | Rust 内核（napi）：索引写入 + 七个查询 | `crates/**` |

三个实现包都导出 `name` / `inject` / `apply`（Cordis 命名空间插件，`apply` 内注册 provider），
以及 `invariant.ts` 伴生插件（照 `packages/service/src/invariant.ts` 的形状）。

### 查询引擎

读路径有两套实现，读同一个 `index.db`：Rust（`rusqlite` + 复用索引时的 tokenize.rs）与
TypeScript（`node:sqlite`）。`engine: auto | native | typescript`，auto 优先原生、失败静默回退
TS 并只记一次日志 —— 与 sessions 索引器的 native 回退策略同一套语义。对拍由
`packages/native/tests/query.spec.ts` 保证（逐 operation 与 TS 结果比对）。

实测（700+ 会话真实库，单次 search）：Rust 3.5–4 ms，TypeScript 22 ms。

**`touched` 只有 TypeScript 实现。** 它从 `entry.text` 现算，不读任何索引之外的东西，所以原生内核
没有必要为它加一张表和一套解析逻辑。`queryNatively` 在拿 kernel **之前**直接把它交给 TS，并且
**不打印**「原生不可用」—— 那不是配置错误，是这个操作本来就只有一份实现。`nativeRequest` 的
`switch` 仍补了 `case 'touched'`，因为那个函数没有 default 分支，靠穷举保证不漏操作。

### 工具可见性（设置页）

`packages/tool/src/visibility.ts` 用宿主的 `agent.ctx.tools.restrict({ deny })` 按 agent 遮蔽另一
套会话工具，并用 `agent.ctx.systemPrompt.section({ name: 'tool:session-query' })` 覆盖内核那段
固定提示词。三态 `toolSet: 'sessiongraph' | 'kernel' | 'both'`，存 `<indexRoot>/panel.json`。

两条实现约束：

- 必须是**无条件**订阅 `agent/created`。条件式（apply 时先查 `tools.view` 判断名字在不在）在
  bundle 加载顺序不确定时会静默失效 —— 插件先 apply、内核工具后注册，就永远不订阅、永远不
  deny，而且没有任何提示。
- 服务的读取必须走 **`ctx.get(name)`**。Cordis 对没 inject 的服务，`ctx.<service>` 是**抛错**不是
  返回 `undefined`，直接属性访问会炸掉 agent 创建（`cannot get property "agents" without inject`）。

## 6. 索引器约束

- 增量：`session.source_mtime` + `source_size` 未变则跳过（`skipped`）
- 源文件消失 → 删除对应 `session` 与 `entry`（`removed`）
- 单会话解析失败不中断整轮，记入 `report.failed`
- 写库在事务里做；索引重建时先写临时文件再 rename（读侧永远看到完整库）
- 边界：`~/.dsh/sessions` 路径由 indexer 配置项 `sessionsRoot` 决定（默认 `~/.dsh/sessions`）

## 7. 工具约束

- `sessiongraph`：查询，`timeoutMs` 默认 30s
- `sessiongraph` (operation `index`)：建/刷新索引，与查询共用 30s 工具预算（大库转 job）
- 系统提示段（`text` 函数形式）：告诉模型「查本地历史用 sessiongraph，别 grep 会话文件」
- `agent/pre-step` 带路：用户最后一条亲手输入像历史问题时，每个会话**先查一次索引**（300 ms 硬超时），把最多三条「日期 · 工作区 · 标题 · 会话 id」注入上下文；查不到、超时、索引坏一律退回原来那句静态提醒，**永不拒绝该步**。记忆类问题（`偏好` / `喜欢` / `习惯` 等）被 `MEMORY_QUESTION_TERMS` 排除，那属于记忆层（`historyHint: false` 关闭）
- 参数 schema 用 `@deepseek-ai/schemastery`

## 8. 验收

1. `pnpm build` 全绿（`tsc -b`，strict + `noUnusedLocals`）
2. `pnpm test` 全绿（registry 单测、tokenize 单测、解析器单测、查询单测）
3. 真机：索引全机 491 会话 → `search "广告"` 命中，`session <id>` 可读，`status` 报数正确
4. 装进 profile 后模型实际调用可用

## 9. 新鲜度策略（三道）

索引必须跟得上对话，但不能拖慢任何东西。

| 时机 | 机制 | 成本 | 作用 |
|---|---|---|---|
| 首次（还没有索引） | `agent/created` → 普通后台 promise **建库**（`autoBuild`，默认 true） | 秒级到分钟级（后台，不阻塞会话） | 装完即用，不需要人先跑一次命令 |
| 会话创建（已有索引） | `agent/created` → 普通后台 promise 增量 | 百毫秒级（后台） | 开新会话时把上个会话的内容补进来 |
| 查询前 | `status.json` 的 `indexedAt` 超过 `freshnessThresholdMs`（默认 5 分钟）→ 先增量再查 | 百毫秒级（同步，仅超阈值时） | 当前会话刚说过的话也能查到 |
| 显式 | `sessiongraph` (operation `index`) 工具 / 手动 | 全量（Rust 个位数秒 / TS 十几秒）或增量 | 强制刷新、脚本化场景 |

**首建也走后台**：它要读全机日志，可能几十秒到几分钟，所以和增量一样是普通后台 promise，绝不阻塞会话创建。两者都**不注册宿主 job**：注册后宿主会把完成通知注入会话、默认还会唤醒空闲 agent 多开一轮，没人要求的维护动作不该出现在对话里。只有显式索引调用（`sessiongraph` (operation `index`) 工具或 `/sessiongraph index`）才走 `ctx.jobs`——两者都把调用方的 owner 传下去（`command.ts:413-418`），大库才转到后台 job。自动路径永远不是 job。`autoBuild: false` 可以关掉它，回到「必须显式触发才建库」的严格行为；`autoIndex: false` 连增量也一并关掉。

**触发与去重**：只对「会话带 cwd」的情况触发。同一 indexRoot 有一个时间窗口（`autoIndexMinIntervalMs`，默认 60s）吸收 burst，窗口外再来会话就刷新；另有一个进程内 in-flight 集合，保证一个跨过窗口还没跑完的 run 不会被第二个会话重复启动（两个写者只会抢同一把写锁）。

**每一轮都有 deadline**：自动刷新带 `autoIndexTimeoutMs`（默认 15 分钟）的 `AbortController`；超时会 abort、立刻释放 in-flight 记录并 `console.error`。没有它，一个永不 settle 的 run 会让该 root 的自动刷新被永久抑制——`finally` 正是这种 run 永远到不了的地方。

**大库转后台**：`status.json` 的 `sessions` ≥ `backgroundIndexThreshold`（默认 1000）时，`sessiongraph` (operation `index`) 走 `ctx.jobs.start`，工具立刻返回 job id 而不是占满 30s 工具预算。

**并发保护**：同一 indexRoot 在同一进程内同时只允许一次增量（in-flight 去重）。

## 10. 为什么不用 `ctx.fs.watch`

`ctx.fs` 是**工作区**抽象，`resolve/listDir/watch` 都相对当前 session 的 `cwd`。会话日志在 `~/.dsh/sessions`，是宿主本机路径，不属于任何工作区 —— 走 fs seam 既解析不到，也没有额外好处。真要「文件变化即索引」得用本地 `fs.watch` 监听每一个会话目录，开销远大于收益；查询前惰性增量更简单可靠。

## 11. 复用宿主能力（不重造轮子）

DSH 内核已经有一整套会话查询设施，能用的直接用：

| 宿主能力 | 我们用不用 | 为什么 |
|---|---|---|
| `ctx.sessionQuery.listSessions()` / `readSession(id)` | **用** | 拿到 `live: true` 的会话（当前还没落盘的），补「刚才说的话查不到」的断档；事件结构与 jsonl 同构，解析器直接复用 |
| `ctx.sessionQuery.traceSession(id)` | 可选 | 我们自己也从 header 算 parentSession，够用 |
| `ctx.sessionQuery.searchSessions()` / `searchEvents()` | **不用** | 它的 tokenizer 是 `unicode61`，无任何 CJK 处理（包里搜 `4e00`/`CJK`/`bigram` 零命中）。实测 `我今天在改广告SDK` 整句是一个 token，搜「广告」查不到。中文检索必须自建 bigram |
| `ctx.jobs.start` | **用** | 只有显式索引调用（`sessiongraph` (operation `index`) 工具或 `/sessiongraph index`）的大库后台运行 |
| `ctx.commands` | **用** | `/sessiongraph` 斜杠命令 |
| `ctx.fs.watch` | 不用 | 见第 10 节 |

**挂载方式**：`packages/bundle/cordis.patch.yml` 里插一行 `@deepseek-ai/dsh-session-query-sqlite`，配置 `path: ':memory:'` + `openAt: never` —— 只激活读取侧，不建也不持久化它的 FTS 索引，零成本。第三方 bundle 引用宿主内核包是受支持的（`dsh-plugin-qq-vibe` 就这么引用 `dsh-persona` / `dsh-tool-bash`）。

**降级**：索引器用 `ctx.get('sessionQuery')` 而不是 `inject`，拿不到就只走文件路径，插件照常工作。

## 12. 数据源混合模式

- **主路径**：文件扫描 + 多帧解压 + `mtime`/`size` 增量（量级参考：Rust 全量个位数秒 / TS 十几秒，增量百毫秒级）
- **补充路径**：每轮问 `sessionQuery.listSessions()`，挑 `live === true` 的（通常 1–3 个），`readSession()` 拿事件后重建。上限 `maxLiveSessions`（默认 8）
- live 会话每轮都重建（它们还在变，没有稳定 mtime 可依赖）
- live 路径放在主写事务**之外**，`readSession` 回放慢也不拖长主索引
- **第二源（Codex）受设置页开关控制**：每轮读 `<indexRoot>/panel.json` 的 `codexSync`，
  `codexSync ?? config.codex`。面板不是唯一真相 —— 只有人明确保存过的值才算数，文件缺失或损坏
  一律回退配置。关掉那一轮把已有 codex 行按 `removed` 删除，不碰 `~/.codex` 本身

## 13. 写并发与索引损坏的防护

同一份 `index.db` 有两个写者（TypeScript 经 `node:sqlite`、Rust 经 bundled rusqlite），三个触发入口（`agent/created` 后台任务、查询前惰性刷新、显式 `sessiongraph` (operation `index`)）。SQLite 不会替两个各自打开文件的写者排队，后果不是干净的锁冲突，而是事后某次查询报 `database disk image is malformed`，只能整体重建。

### 写侧：一把跨进程的文件锁

`packages/sessions/src/lock.ts`：

- 用 `open(path, 'wx')` 独占创建 `<indexRoot>/index.lock`，写入 pid；输者每 100ms 轮询
- 崩溃会留下文件，所以锁的 mtime 超过 `indexLockStaleMs`（默认 5 分钟）视为持有者已死，直接打破
- 等待上限 `LOCK_TIMEOUT_MS`（2 分钟），超时抛错让调用方跳过本轮，而不是并发写
- `runIndex` 整体在锁内（含 live pass），两个引擎路径都覆盖

> 锁文件不能等到过期才清理：释放用同步 `rmSync`，因为异步释放可能被正在展开的 `finally` 丢掉，泄漏的锁会阻塞后面所有写者。

### 读侧：损坏即自愈

`packages/tool/src/index.ts` 的查询路径捕获两类失败——seam 的 `SESSIONGRAPH_CORRUPT`，以及 SQLite 自己抛出的 `malformed` / `not a database` / `file is encrypted`——然后：

1. `ctx.sessiongraph.index(indexRoot, { force: true })` 重建一次
2. 用原来的请求重试一次
3. 重建或重试仍失败才把原始错误抛给模型

索引是派生数据，源日志没动过，所以重建永远安全；这也是人看到那个错误后会做的事，只是不需要人来点。

## 14. 命令平面跑在宿主主线程上

`/sessiongraph <cmd>` 的 handler 在宿主主线程执行，任何同步工作都会直接卡住 UI。踩过一次：handler 返回后调 `agent.inject` 把结果塞回会话，结果 `agent.inject` 把 agent 循环（prompt 装配，连带 section 里每次同步读 `status.json`）带进同一个调用栈，`/sessiongraph status` 直接把桌面卡死，主进程 CPU 约 48%。

现在 `injectCommandResults` 默认 **false**：命令照常执行并显示结果，不再往会话里塞消息。要用显式设 true，并且清楚代价。

由此得出的约束：**命令 handler 里只做短小的异步工作**。`statusCommand` 走的是 `ctx.sessiongraph.query`（同步 SQLite 读，单次），这条路径本身没问题；出问题的是在 handler 里间接驱动 agent 循环。
