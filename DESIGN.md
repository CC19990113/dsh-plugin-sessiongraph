# sessiongraph 内部设计（实现契约）

> 目标：把本机 `~/.dsh/sessions` 下**全部会话**当成一个仓库，预建一份 SQLite 索引，
> 让模型通过 `sessiongraph` 工具**秒级**检索「上次在哪个会话里说过/做过什么」。

## 1. 数据源（实测，2026-11-03）

布局：`~/.dsh/sessions/<escaped-cwd>/<session-id>/session.v4.jsonl.zstd`

- `<escaped-cwd>`：工作区绝对路径转义，形如 `--Users-admin-www-xxx--`
- 会话目录：`037ad8fc-29b8-4a69-9a02-e75f9cc8fb45`（**裸 uuid，无 `session-` 前缀**）
- 文件：`session.v4.jsonl.zstd`（zstd 压缩的 JSONL），另有 `session.lock`（忽略）
- 规模（2026-11-03 实测）：**641 个会话**（`session.v4` 494 个 + `session.v3` 147 个）/ 25 个工作区 /
  617M 压缩 / 解压 **1.6GB** / 最大单会话 41.83MB / 全量逐帧解压 7.1s（不含 JSON 解析）
- 版本差异：`v3` 的目录名与 header `id` 都带 `session-` 前缀，`v4` 是裸 uuid；
  事件结构两版兼容，`user/message.data.source.kind` 两版都有

### 解压：多帧 zstd（**最容易踩的坑**）

实测（2026-11-03）：会话文件是**多帧 zstd 追加写**的，一个 234KB 的文件含 113 个 frame。
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

实测：641 个文件全部逐帧解压成功、0 失败，解压总量 1.6GB，最大单会话 41.83MB，
全量解压 7.1s（不含 JSON 解析）。

用 `node:zlib`，**不要**调用外部 `zstd` 二进制。

### 事件结构

第一行是会话头（**平铺，无 `data` 字段**）：

```json
{"type":"session","version":4,"id":"...","createdAt":1793349570839,
 "cwd":"/Users/admin/www/dsh-community","parentSession":"session-xxx",
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

## 2. 索引库

位置：`<indexRoot>/index.db`，`indexRoot` 默认 `~/.dsh/sessiongraph`。

schema 见 `packages/service/src/schema.ts`（`SCHEMA_STATEMENTS`），三方共享，**只改那一处**。

表：

- `session(id PK, workspace, title, created_at, last_at, parent_session, origin, agent_preset, turns, entries, source_path, source_mtime, source_size)`
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

`SessiongraphRequest` 判别联合（`packages/service/src/types.ts`），五个操作：

| operation | 作用 |
|---|---|
| `search` | 全文检索，可按 `workspace` / `after` / `before` / `kinds` 过滤，返回命中列表（含片段） |
| `session` | 按完整 id 或唯一前缀读一个会话（元信息 + 有序 entries + 子会话） |
| `timeline` | 按时间列会话（可过滤 workspace），新→旧 |
| `workspaces` | 工作区清单与统计（会话数、条目数、时间跨度） |
| `status` | 索引自身状态；**唯一**在无索引时也返回结果的操作 |

服务类：`packages/service/src/index.ts` 的 `Sessiongraph`（`ctx.sessiongraph`），
「exactly one claimant」路由：`indexes()` / `canIndex()` 并发询问所有 provider，0 个或多个都抛错。

## 5. 包职责（写作用域互不重叠）

| 包 | 职责 | 只写这些文件 |
|---|---|---|
| `service`（已完成，**不要改**） | 契约、schema、tokenizer、seam | — |
| `sessions`（indexer） | 扫描 + zstd 解压 + JSONL 解析 + 写 `index.db` | `packages/sessions/**` |
| `sqlite`（store） | 读 `index.db`，实现五个查询 | `packages/sqlite/**` |
| `tool`（consumer） | `sessiongraph` / `sessiongraph_index` 两个模型工具 + 系统提示段 | `packages/tool/**` |
| `bundle` | `cordis.patch.yml` | `packages/bundle/**` |

三个实现包都导出 `name` / `inject` / `apply`（Cordis 命名空间插件，`apply` 内注册 provider），
以及 `invariant.ts` 伴生插件（照 `packages/service/src/invariant.ts` 的形状）。

## 6. 索引器约束

- 增量：`session.source_mtime` + `source_size` 未变则跳过（`skipped`）
- 源文件消失 → 删除对应 `session` 与 `entry`（`removed`）
- 单会话解析失败不中断整轮，记入 `report.failed`
- 写库在事务里做；索引重建时先写临时文件再 rename（读侧永远看到完整库）
- 边界：`~/.dsh/sessions` 路径由 indexer 配置项 `sessionsRoot` 决定（默认 `~/.dsh/sessions`）

## 7. 工具约束

- `sessiongraph`：查询，`timeoutMs` 默认 30s
- `sessiongraph_index`：建/刷新索引，默认 300s，独立预算
- 系统提示段（`text` 函数形式）：告诉模型「查本地历史用 sessiongraph，别 grep 会话文件」
- 参数 schema 用 `@deepseek-ai/schemastery`

## 8. 验收

1. `pnpm build` 全绿（`tsc -b`，strict + `noUnusedLocals`）
2. `pnpm test` 全绿（registry 单测、tokenize 单测、解析器单测、查询单测）
3. 真机：索引全机 491 会话 → `search "广告"` 命中，`session <id>` 可读，`status` 报数正确
4. 装进 profile 后模型实际调用可用
