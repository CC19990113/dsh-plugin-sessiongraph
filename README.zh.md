# dsh-plugin-sessiongraph

[English](README.md) | 中文

把本机全部 DSH 会话历史当成一个可检索的库 —— 模型用工具秒查「上次在哪个会话里说过、做过什么」，不用翻侧边栏，也不用 grep 压缩日志。

## 架构

六个包，沿一条严格的缝隙分层：**加一个 store 或 indexer，不需要动模型工具**。

| 包 | 角色 |
|---|---|
| `service` | 定义 `ctx.sessiongraph` 缝隙：查询词汇、store/indexer 注册表、schema v1、中文 bigram 分词器 |
| `sqlite` | 读 provider：从 `index.db` 回答五个查询 |
| `sessions` | 写 provider：扫描会话日志 → 逐帧解压 → 抽取条目 → 写库（TypeScript 与 Rust 双引擎） |
| `tool` | 消费者：两个模型工具 + `/sessiongraph` 命令 + 系统提示段 |
| `native` | Rust 内核的加载器（加载失败返回 `undefined`，绝不抛） |
| `bundle` | 安装元包：`cordis.patch.yml` |

**路由是「恰好一个认领者」，不是首个匹配。** 每次查询并发询问所有 store，0 个或多个认领者都抛错（`SESSIONGRAPH_UNAVAILABLE` / `SESSIONGRAPH_CONFLICT`），所以注册顺序和热重载永远不影响结果。`status` 是唯一在没有 store 时也能回答的操作 —— 从没建过库的人需要知道这个事实，而不是收到和其他操作一样的失败。

### Rust 内核

索引路径用 napi-rs 写成原生模块（Rayon 多线程 + rusqlite），不是 WASM：内核要直接读文件系统、直接写 SQLite、处理 GB 级数据，WASM 的边界拷贝和 fs/sqlite 缺失是硬伤。

| | 全量建索引 | 增量 | 查询延迟 | 索引体积 |
|---|---|---|---|---|
| **Rust 内核** | **6.76s** | **59–107ms** | 0.1–6.9ms | 约 170 MB |
| TypeScript（回落路径） | 19.22s | 230ms | 同上 | 约 170 MB |

两库内容**完全一致**，不是「另一种索引」：`sqlite_master` 建表语句逐字相同，所有未变会话逐条比对零差异，entry 行 / session 行 / FTS token 多重集的 SHA-256 相同，TypeScript 写的 store 能直接读 Rust 建的库。

引擎选择 `engine: 'auto' | 'native' | 'typescript'`，默认 `auto`：有原生就用，没有静默回落 TypeScript —— **缺二进制永远不是错误**。

## 和记忆的分工

记忆系统存的是**结论**，sessiongraph 存的是**证据**：

| | 记忆（OpenViking / MEMORY.md 一类） | **sessiongraph** |
|---|---|---|
| 存什么 | 抽取后的事实：偏好、决策、实体 | **原始记录**：每条消息、每次工具调用的名字与参数 |
| 怎么产生 | 模型或服务端摘要抽取，有损，会丢细节 | **原样保留**，只做截断，不改写 |
| 什么时候写 | 会话结束或到阈值后批量提交 | 会话创建增量、查询前惰性刷新，百毫秒级 |
| 怎么查 | 语义检索（embedding），按意思召回 | 全文索引（bigram 分词），按字面命中 |
| 能不能查原话 | ❌ 只有被提炼成记忆时才留下痕迹 | ✅ 全部原文，含当时的命令与参数 |
| 适合问 | 「我喜欢什么」「上次定了什么方案」 | 「哪次说过这句话」「当时那条命令怎么写的」 |

一句话：**记忆回答「结论是什么」，sessiongraph 回答「当时到底说了什么」。**

两者不重复：一段对话很可能**永远不会进记忆**（短会话、没触发提交阈值），但它一定在 sessiongraph 的原文索引里；反过来，记忆里的结论常常已经丢了上下文，需要核对时只能回原文。

## 使用

### 三个入口

| 入口 | 用法 |
|---|---|
| **模型自主调用** | 直接问「上次讨论鸿蒙开屏是哪个会话」，模型自己调 `sessiongraph` |
| **斜杠命令** | `/sessiongraph status` / `index` / `search <词>` / `workspaces` |
| **命令结果回灌** | 敲完命令，结果作为 `plugin/notice` 消息注入会话 —— 模型下一轮就知道你查了什么（与 `/plan` 同一机制） |

### 工具

`sessiongraph`：

| operation | 作用 |
|---|---|
| `search` | 跨会话全文检索，可按 `workspace` / `after` / `before` / `kinds` 过滤；返回标题、工作区、时间、轮次、命中片段（`[词]` 高亮） |
| `session` | 按完整 id 或唯一前缀打开一个会话：元信息 + 有序条目 + 子会话 |
| `timeline` | 按时间列会话（可过滤工作区），新→旧 |
| `workspaces` | 工作区清单与统计 |
| `status` | 索引自身状态；**唯一在无索引时也能回答的操作** |

`sessiongraph_index`：建或刷新索引，独立 300s 预算；源文件 mtime+size 未变就跳过，会话攒到 1000+ 时转后台 job 并返回 jobId。

### 命令

| 命令 | 作用 |
|---|---|
| `/sessiongraph` | 等同于 `status` |
| `/sessiongraph status` | 索引规模、体积、最近建索引时间、实时会话数、当前工作区 |
| `/sessiongraph index [--force]` | 建或刷新；大库转后台并打印 jobId |
| `/sessiongraph search <词>` | 直接检索，打印前 10 条 |
| `/sessiongraph workspaces` | 工作区列表，`*` 标出当前工作区 |

### 自动索引

日常不需要手动刷新，三道机制兜住：

| 时机 | 机制 | 耗时 |
|---|---|---|
| **会话创建时** | `agent/created` → 后台增量（`ctx.jobs`），不阻塞会话 | 59–107ms |
| **查询前** | `status.json` 的 `indexedAt` 超过 5 分钟就先增量再查 | 约 400ms |
| **当前会话** | 接入宿主 `ctx.sessionQuery`，把还没落盘的 live 会话也索引进来 | 可忽略 |

只有首次建库需要显式跑一次 `sessiongraph_index`。

### 索引什么

只收有价值的：`user/message`（仅 `source.kind === 'user'`，即人真正打的字）、`assistant/message` 的 `text` 块（`reasoning` 占 61% 字节，不收）、`tool/call` 的名字与参数、`session/title`。跳过 `tool/result` 正文、`request/header`、`step/*`、`job/*`。

### 中文为什么两字词能命中

SQLite 的 `unicode61` 把 `我今天在改广告SDK` 整句当一个 token，搜「广告」查不到；`trigram` 要求 ≥3 字符，两字词同样无解。所以写入和查询共用同一个自建分词器（`packages/service/src/tokenize.ts`）：中文连续段切重叠双字（`广告点击` → `广告` `告点` `点击`），英文数字段小写整词并按 `_` 切分，查询 token 加引号后 `AND` 连接。代价是召回优先而非短语精确匹配 —— 查历史要的是「找得到」。

## 安装

```sh
dsh plugin add dsh-plugin-sessiongraph
```

或在 profile 里 link 本地目录：

```json
"dependencies": { "dsh-plugin-sessiongraph": "link:/path/to/dsh-plugin-sessiongraph" },
"dsh": { "profile": { "bundles": [ "...", "dsh-plugin-sessiongraph" ] } }
```

装完重启 DSH，首次调用 `sessiongraph_index` 建库，之后自动增量。

## 开发

```sh
pnpm install
pnpm build      # tsc -b，五个 TS 项目引用
pnpm test       # vitest run，200+ 测试
```

内部契约（数据格式、schema、分词规则、各包职责、DSH 能力复用决策）见 [`DESIGN.md`](./DESIGN.md)。
