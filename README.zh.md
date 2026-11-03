# dsh-plugin-sessiongraph

[English](README.md) | 中文

**把本机全部 DSH 会话历史当成一个可检索的库。**

你问「上次那个功能做到哪了」「哪次说过这句话」「哪个会话讨论过鸿蒙开屏」—— 模型直接查，不用你翻侧边栏，也不用 grep `~/.dsh/sessions`。

> 索引 `~/.dsh/sessions` 下**全部会话**，不是某个工作区。
> 自动维护，不需要你记得去刷新。

## 它解决什么

会话日志长这样：`~/.dsh/sessions/<工作区>/<会话id>/session.vN.jsonl.zstd`

| 问题 | 现实 |
|---|---|
| `grep` 搜不到 | 文件是 **zstd 压缩的 JSONL**，grep 读的是压缩字节 |
| 内置 `session_search` 搜不了中文 | 它用 SQLite 的 `unicode61` 分词器，**没有任何 CJK 处理** —— `我今天在改广告SDK` 整句是一个 token，搜「广告」查不到 |
| 跨工作区不方便 | 会话按 cwd 散在二十多个目录里，内置工具只作用于调用方工作区 |
| 解压很慢 | 每个文件是**多帧 zstd** 追加写（单个文件可以含上百个帧），`zstdDecompressSync` 只解第一帧，直接读只能拿到几百字节；一个中型日志库全量解压出来就有 **GB 级** |

sessiongraph 把这些都处理掉：逐帧解压、按事件类型抽可检索条目、自建中文 bigram 索引、Rust 内核并行建库。

## 自动索引：不需要你管

三道机制，全部自动：

| 时机 | 机制 | 耗时 |
|---|---|---|
| **会话创建时** | `agent/created` → 后台增量（`ctx.jobs`），不阻塞会话 | 59–107ms |
| **查询前** | `status.json` 的 `indexedAt` 超过 5 分钟就先增量再查 | 约 400ms |
| **当前会话** | 接入宿主 `ctx.sessionQuery`，把**还没落盘**的 live 会话也索引进来 | 可忽略 |

手动入口仍然保留（`sessiongraph_index` / `/sessiongraph index`），但**日常你什么都不用做**。

只有首次需要建一次库（全量 6.8s，Rust 内核），之后一直增量。

## 三个入口

| 入口 | 用法 |
|---|---|
| **模型自主调用** | 直接问「上次讨论鸿蒙开屏是哪个会话」，模型自己调 `sessiongraph` |
| **斜杠命令** | `/sessiongraph status \| index \| search <词> \| workspaces` |
| **命令结果回灌** | 敲完命令，结果作为 `plugin/notice` 消息注入会话 —— 模型下一轮就知道你查了什么（与 `/plan` 同一机制） |

## 和 codegraph 的关系

两个插件互补，索引的是**不同东西**：

| | **codegraph** | **sessiongraph**（本插件） |
|---|---|---|
| 索引什么 | 代码结构：声明、调用、导入、影响面 | 会话历史：消息、工具调用、命令 |
| 数据源 | 工作区源码文件 | `~/.dsh/sessions` 的 zstd JSONL |
| 解析器 | tree-sitter（WASM） | 自研 JSONL 抽取 + bigram 分词 |
| 作用域 | **单个项目**（`.codegraph/codegraph.db` 在项目内） | **全机跨工作区**（`~/.dsh/sessiongraph/index.db`） |
| 回答的问题 | 「这个函数谁在调」「改这里会影响什么」 | 「上次在哪个会话说过/做过什么」 |
| 更新时机 | `ctx.fs.watch` 监听文件变化 | `agent/created` + 查询前惰性增量 |
| 中文 | 一张任务词同义词表（`zh-synonyms.ts`） | **bigram 分词**，两字词直接命中 |
| 原生内核 | 无（tree-sitter WASM） | **Rust + napi-rs** |

一句话分工：**codegraph 查代码怎么连，sessiongraph 查你上次说了什么。**

两者共用同一种架构：`service` 缝隙 + store/indexer provider 注册表 + 模型工具消费层。加一个新的 store 或 indexer，不需要动模型工具。

## 性能（Rust 内核）

一台 Apple Silicon 开发机，六百余个会话 / 约 1.6GB 解压数据：

| | 全量建索引 | 增量 | 查询延迟 | 索引体积 |
|---|---|---|---|---|
| **Rust 内核**（napi-rs + Rayon + rusqlite） | **6.76s** | **59–107ms** | 0.1–6.9ms | 约 170 MB |
| TypeScript（回落路径） | 19.22s | 230ms | 同上 | 约 170 MB |
| 加速比 | **2.84×** | **约 3×** | — | — |

**两库内容完全一致**，不是「另一种索引」：

- `sqlite_master` 建表语句逐字相同
- 所有未变会话的 session / entry / FTS token 全量比对 → **0 差异**
- 两库 entry 行、session 行、FTS token 多重集的 **SHA-256 相同**
- TS 写的 store 能直接读 Rust 建的库，反之亦然

### 为什么是 napi-rs 不是 WASM

内核要**直接读文件系统**（数百个日志）、**写 SQLite**（十万级条目 + FTS5）、处理 **GB 级**数据。WASM 的边界拷贝和 fs/sqlite 缺失是硬伤；napi-rs 可以用 Rayon 真多线程解压解析。

### 引擎选择

```ts
engine: 'auto'        // 默认：有原生就用，没有静默回落 TS
engine: 'native'      // 显式要求，不可用时回落并报一次错
engine: 'typescript'  // 强制 TS
```

没有 `.node` 的机器（架构不匹配、没编译）**完全等同旧行为**，不会因为缺二进制而报错。

编译：

```sh
packages/native/build-native.sh
```

> 坑：如果 rustup 的默认 toolchain 与 Node 架构不一致（典型是 Rosetta 下的 `x86_64` 配 arm64 Node），产物加载会报 incompatible architecture。脚本会显式选 `aarch64-apple-darwin` 并用 `file` 校验架构。

## 索引什么

只收有价值的，跳过噪音（25 个会话采样的字节占比）：

| 事件 | 收 | 说明 |
|---|---|---|
| `user/message` | ✅ | 仅 `source.kind === 'user'`（人真正打的字）；runtime-context / skill-catalog / 插件注入全跳过 |
| `assistant/message` | ✅ | 仅 `content[].type === 'text'`；`reasoning`（思维链，占 **61%** 字节）不索引 |
| `tool/call` | ✅ | 工具名 + 参数（截断 2KB） |
| `session/title` | ✅ | 取最后一条 |
| `tool/result` | ❌ | 正文占 15%，检索价值低 |
| `request/header` / `step/*` / `job/*` | ❌ | 噪音 |

结果：可检索条目里 tool 调用占 76%、assistant 正文 19%、user 3%、标题 2%。

## 中文检索为什么能两字词命中

SQLite 3.50.4 实测：

| 方案 | 「广告」能否命中 `我今天在改广告SDK` |
|---|---|
| `unicode61` | ❌ 整句是一个 token |
| `trigram` | ❌ 要求 ≥3 字符，两字词无解 |
| **自建 bigram** | ✅ |

做法：写入和查询用**同一个分词器**（`packages/service/src/tokenize.ts`）——

- 中文连续段 → 重叠双字：`广告点击` → `广告` `告点` `点击`
- 英文/数字段 → 小写整词，按 `_` 切分（`codegraph_index` → `codegraph` `index`）
- 查询 token 双引号包裹 + `AND` 连接

代价是召回优先而非短语精确匹配（`广告跳转` 可以匹配字符不相邻的条目）。查历史要的是「找得到」，这个取舍成立。

## 工具

### `sessiongraph`

| operation | 作用 |
|---|---|
| `search` | 跨会话全文检索，可按 `workspace` / `after` / `before` / `kinds` 过滤；返回标题、工作区、时间、轮次、命中片段（`[词]` 高亮） |
| `session` | 按完整 id 或**唯一前缀**打开一个会话：元信息 + 有序条目 + 子会话 |
| `timeline` | 按时间列会话（可过滤工作区），新→旧 |
| `workspaces` | 工作区清单与统计 |
| `status` | 索引自身状态；**唯一在无索引时也能回答的操作** |

### `sessiongraph_index`

建或刷新索引，独立 300s 预算。源文件 mtime+size 未变就跳过；会话攒到 1000+ 时自动转后台 job 并返回 jobId。

## 装

```sh
dsh plugin add dsh-plugin-sessiongraph
```

或在 profile 里 `link:` 本地目录：

```json
"dependencies": { "dsh-plugin-sessiongraph": "link:/path/to/dsh-plugin-sessiongraph" },
"dsh": { "profile": { "bundles": [ "...", "dsh-plugin-sessiongraph" ] } }
```

装完重启 DSH。首次调用 `sessiongraph_index` 建库（之后自动增量）。

## 架构

| 包 | 角色 |
|---|---|
| `service` | 定义 `ctx.sessiongraph` 缝隙：查询词汇、store/indexer 注册表、schema v1、bigram 分词器 |
| `sqlite` | 读 provider：从 `index.db` 回答五个查询 |
| `sessions` | 写 provider：扫描 + 逐帧解压 + 解析 + 写库（TS 与 Rust 双引擎） |
| `tool` | 消费者：两个模型工具 + `/sessiongraph` 命令 + 系统提示段 |
| `native` | Rust 内核的加载器（失败返回 `undefined`，绝不抛） |
| `bundle` | 安装元包：`cordis.patch.yml` |

**路由是「恰好一个认领者」，不是首个匹配**：每次查询并发问所有 store，0 个或多个认领者都抛错（`SESSIONGRAPH_UNAVAILABLE` / `SESSIONGRAPH_CONFLICT`），所以注册顺序和热重载不影响结果。

**`status` 是唯一不需要索引服务也能回答的操作** —— 从没建过库的人需要知道「还没建」，而不是收到一个和别处一样的失败。

## 开发

```sh
pnpm install
pnpm build      # tsc -b，五个 TS 项目引用
pnpm test       # vitest run，200+ 测试
```

内部契约（数据格式、schema、分词规则、各包职责、DSH 能力复用决策）见 [`DESIGN.md`](./DESIGN.md)。
