# dsh-plugin-sessiongraph

把本机 **所有 DSH 会话历史**当成一个可检索的库：预建索引，模型用工具秒查「上次在哪个会话里说过/做过什么」。

比 memory 多一层：memory 是提炼过的事实，sessiongraph 是**原文可回溯**的证据层 —— 能查到当时那句话、那条命令、那次工具调用的参数。

## 实测（Apple M2，2026-11-03）

| 项 | 值 |
|---|---|
| 索引会话 | **638**（`session.v4` 494 + `session.v3` 147，去重 5 个迁移遗留） |
| 可检索条目 | **94,309** |
| 工作区 | 17 |
| 源数据 | 617MB 压缩 → 1.6GB JSONL |
| 全量建索引 | **21.1s**（Rust 内核 4.1s，见下） |
| 增量空跑 | **90–274ms** |
| 索引体积 | **174.7MB** |
| 查询延迟 | **0.1–6.9ms** |

查询实测（中文两字词即可命中，靠自建 bigram 分词）：

| 查 | 命中 | 延迟 |
|---|---|---|
| 广告 | 2562 | 6.9ms |
| 点击跳转 | 101 | 0.9ms |
| 鸿蒙 SDK | 350 | 1.2ms |
| FTP | 6 | 0.1ms |

## 为什么不是 grep

DSH 的会话日志是 `~/.dsh/sessions/<工作区>/<会话id>/session.vN.jsonl.zstd`：

- 按工作区散在子目录里
- **多帧 zstd** 追加写（一个文件几十上百帧，`zstdDecompressSync` 只解第一帧，直接解会只拿到几百字节）
- 中文在 FTS5 的 `unicode61` 下整句是一个 token，`广告` 搜不到；`trigram` 又要求 ≥3 字符，两字词同样搜不到

sessiongraph 把这些都处理掉：逐帧解压、按事件类型抽可检索条目、自建中文 bigram 索引。

## 装

```sh
dsh plugin add dsh-plugin-sessiongraph
```

或在 profile 里 `link:` 本地目录（本机自用）：

```json
"dependencies": { "dsh-plugin-sessiongraph": "link:/Users/admin/www/dsh-plugin-sessiongraph" },
"dsh": { "profile": { "bundles": [ "...", "dsh-plugin-sessiongraph" ] } }
```

装完重启 DSH 生效。首次需要建一次索引（`sessiongraph_index`），之后每次会话创建会自动增量。

## 工具

### `sessiongraph`

| operation | 作用 |
|---|---|
| `search` | 跨会话全文检索，可按 `workspace` / `after` / `before` / `kinds` 过滤；返回会话标题、工作区、时间、命中片段（`[词]` 高亮） |
| `session` | 按完整 id 或**唯一前缀**打开一个会话：元信息 + 有序条目 + 子会话 |
| `timeline` | 按时间列会话（可过滤工作区），新→旧 |
| `workspaces` | 工作区清单与统计（会话数、条目数、时间跨度） |
| `status` | 索引自身状态；**唯一在无索引时也能回答的操作** |

### `sessiongraph_index`

建或刷新索引，独立的长超时预算（默认 300s）。增量：源文件 mtime+size 未变就跳过。

## 索引内容

只收有价值、可检索的：

| 事件 | 收 | 说明 |
|---|---|---|
| `user/message` | ✅ | 仅 `source.kind === 'user'`（真实人类输入）；runtime-context / skill-catalog / 插件注入全部跳过 |
| `assistant/message` | ✅ | 仅 `content[].type === 'text'`；`reasoning`（思维链，占 61% 字节）不索引 |
| `tool/call` | ✅ | 工具名 + 参数（截断）|
| `session/title` | ✅ | 取最后一条 |
| `tool/result` | ❌ | 正文占 15%，检索价值低 |
| `request/header` / `step/*` / `job/*` | ❌ | 噪音 |

索引位置：`~/.dsh/sessiongraph/index.db`，旁边一份 `status.json` 给系统提示段同步读（装配路径不查库）。

## 架构

沿用 codegraph 的分层：**加一个 store 或 indexer 不需要动模型工具**。

| 包 | 角色 |
|---|---|
| `service` | 定义 `ctx.sessiongraph` 缝隙：查询词汇、store/indexer 注册表、schema、bigram 分词器 |
| `sqlite` | 读 provider：从 `index.db` 回答五个查询 |
| `sessions` | 写 provider：扫描 + 逐帧解压 + 解析 + 写库（TS 实现，回退路径） |
| `tool` | 消费者：`sessiongraph` / `sessiongraph_index` 两个工具 + 系统提示段 |
| `bundle` | 安装元包：`cordis.patch.yml` |
| `native` | Rust 原生内核的加载器（可选，缺了就回落 `sessions`） |

**路由是「恰好一个认领者」，不是首个匹配**：每次查询并发问所有 store，0 个或多个认领者都抛错（`SESSIONGRAPH_UNAVAILABLE` / `SESSIONGRAPH_CONFLICT`），所以注册顺序和热重载不影响结果。

## Rust 内核

全量索引（641 会话 / 1.6GB，同机、同数据、热缓存）：

| 引擎 | 全量 | 增量 | 体积 |
|---|---|---|---|
| **Rust 原生**（napi-rs + Rayon + rusqlite） | **6.76s** | **59–107ms** | 167.9 MiB |
| TypeScript 单核 | 19.22s | 179–230ms | 167.9 MiB |
| | **2.8–2.9×** | **1.7–3.9×** | 一致 |

**内容一致性**：建表 SQL 逐字相同；639 个未变会话的 session / entry / FTS token 全量比对 **0 差异**；两库 entry 行、session 行、FTS token 多重集的 SHA-256 **相同**；TS store 能直接读 Rust 建的库。

用 napi-rs 而不是 WASM：内核要直接读文件系统、写 SQLite、吃 1.6GB 数据，WASM 的边界拷贝和 fs/sqlite 缺失是硬伤。

**引擎选择**：`engine: 'auto'`（默认）有原生就用、没有静默回落 TS；`'native'` 显式要求但在不可用时回落并报一次错；`'typescript'` 强制走 TS。没有 `.node` 的机器（架构不匹配、没编译）完全等同旧行为。

> 编译注意：本机 rustup 默认是 Rosetta 的 `x86_64` toolchain，产物在 arm64 Node 里加载不了。`packages/native/build-native.sh` 会自动选 `aarch64-apple-darwin` 并用 `file` 校验架构。

## 开发

```sh
pnpm install
pnpm build      # tsc -b，四个 TS 项目引用
pnpm test       # vitest run，packages/*/tests/**/*.spec.ts
```

`DESIGN.md` 是实现契约（数据格式、schema、分词规则、各包职责）。
