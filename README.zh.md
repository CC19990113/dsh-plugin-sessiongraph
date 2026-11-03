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

## 和记忆、DSH 内置检索的分工

同一个问题有三种存法，选错了就查不到：

| | 记忆（OpenViking / MEMORY.md） | **DSH 内置 `session_search`** | **sessiongraph** |
|---|---|---|---|
| 存什么 | 抽取后的结论：偏好、决策、实体 | 会话事件的**语义文本**（按事件类型提取） | **原文条目**：消息正文、工具调用的名字与参数 |
| 形态 | `viking://` 下的 Markdown 条目 | SQLite FTS5，**内存库**（`openAt: first-search`，每次启动重建） | SQLite，**落盘**，增量维护 |
| 作用域 | 全机 | **调用方工作区** | 全机跨工作区 |
| 中文 | 语义检索（embedding），按意思召回 | ❌ `unicode61` 分词器，**零 CJK 处理** —— `我今天在改广告SDK` 整句是一个 token，搜「广告」查不到 | ✅ 自建 bigram，**两字词直接命中** |
| 怎么查 | 按意思相近 | 按 token / 短语（英文关键词、完整词） | 按字面全文（中英文都行） |
| 能查原话 | ❌ 只有被提炼时才留下痕迹 | 部分：返回摘录片段 | ✅ 全部原文，含命令与参数 |
| 适合问 | 「我喜欢什么」「上次定了什么方案」 | 英文关键词、精确短语、最近几个会话 | 「哪次说过这句话」「当时那条命令怎么写的」 |

一句话：**记忆回答「结论是什么」，内置检索回答「哪个会话提到过」，sessiongraph 回答「当时到底说了什么」。**

三点实际差别：

- **中文**：内置检索对中文基本不可用（分词器没有 CJK 处理），sessiongraph 专为中文两字词设计
- **作用域**：内置检索只看调用方工作区，sessiongraph 跨全部工作区
- **持久化**：内置检索的索引在内存里、首次搜索才建、进程重启就没了；sessiongraph 的索引落盘，重启即用，靠增量保持新鲜

与记忆则完全不重叠：一段对话很可能**永远不会进记忆**（短会话、没触发提交阈值），但它一定在 sessiongraph 的原文索引里；反过来，记忆里的结论常常已经丢了上下文，需要核对时只能回原文。

## 使用

### 三个入口

| 入口 | 用法 |
|---|---|
| **模型自主调用** | 直接问「上次讨论鸿蒙开屏是哪个会话」，模型自己调 `sessiongraph` |
| **斜杠命令** | `/sessiongraph status` / `index` / `search <词>` / `workspaces` |
| **命令结果回灌**（可选，默认关） | 设 `injectCommandResults: true` 后，命令结果作为 `plugin/notice` 消息注入会话，模型下一轮就知道你查了什么（与 `/plan` 同一机制）。默认关是因为命令跑在宿主主线程上，在 handler 里调 `agent.inject` 会把 agent 循环拖进同一个栈 —— `/sessiongraph status` 曾因此卡死桌面 |

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

**装完什么都不用做。** 四道机制兜住，全部自动：

| 时机 | 机制 | 耗时 |
|---|---|---|
| **首次**（还没有索引） | 会话创建时后台建库（`autoBuild`，默认开） | 几秒到几分钟，后台跑，不阻塞会话 |
| **会话创建时**（已有索引） | `agent/created` → 后台增量（`ctx.jobs`） | 59–107ms |
| **查询前** | `status.json` 的 `indexedAt` 超过 5 分钟就先增量再查 | 约 400ms |
| **当前会话** | 接入宿主 `ctx.sessionQuery`，把还没落盘的 live 会话也索引进来 | 可忽略 |

想完全手动：`autoBuild: false` 关掉首次自动建库，`autoIndex: false` 连增量也关掉，之后一切靠 `sessiongraph_index` / `/sessiongraph index`。

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
