# dsh-plugin-sessiongraph

[English](README.md) | 中文

把本机全部 DSH **和 Codex** 的会话历史当成一个可检索的库 —— 模型用工具秒查「上次在哪个会话里说过、做过什么」，不用翻侧边栏，也不用 grep 压缩日志。

## 架构

六个包，沿一条严格的缝隙分层：**加一个 store 或 indexer，不需要动模型工具**。

| 包 | 角色 |
|---|---|
| `service` | 定义 `ctx.sessiongraph` 缝隙：查询词汇、store/indexer 注册表、schema v1、中文 bigram 分词器 |
| `sqlite` | 读 provider：从 `index.db` 回答七个查询，并在 native / TypeScript 两套引擎间路由 |
| `sessions` | 写 provider：扫描两个 harness（DSH 与 Codex）的会话日志 → 解压 → 抽取条目 → 写库；另有 `raw.ts` 回读未删节事件 |
| `tool` | 消费者：**一个** `sessiongraph` 工具（八个 operation）+ `/sessiongraph` 命令 + 系统提示段 + 设置页 HTTP 路由 + 工具可见性 |
| `native` | Rust 内核：索引写入（`indexSessions`）与查询（`query`），加载失败返回 `undefined`，绝不抛 |
| `panel` | 纯浏览器半侧：设置页「会话检索」页签（`dsh.client`，宿主入口是空 apply） |
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

从 0.2.0 起这三者不再需要模型自己取舍：设置页默认就把内核那五个 `session_*` 工具对模型隐藏，只留 `sessiongraph`（见下文「设置页：用哪套会话工具」）。想换回去随时切。

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

**一个工具，八个 operation。** 从 0.2.0 起，索引不再是独立工具（`sessiongraph_index` 已删除）。

| operation | 作用 |
|---|---|
| `search` | 跨会话全文检索，可按 `sessionId` / `workspace` / `source` / `after` / `before` / `kinds` 过滤；默认同一会话只留最强命中（`dedupeBySession: false` 关闭）；返回来源、标题、工作区、时间、轮次、命中片段（`[词]` 高亮） |
| `session` | 按完整 id 或唯一前缀打开一个会话：元信息 + 有序条目 + 子会话 |
| `event` | 读**一条未删节的原始事件**（走源日志，不是索引里的裁剪文本），可带 `windowBefore` / `windowAfter` 前后窗口 |
| `trace` | 无 `seq` → 会话血缘（祖先链 + 递归后代树）；有 `seq` → 该事件的替换链、遮蔽范围与引用源事件 |
| `timeline` | 按时间列会话（可过滤工作区与 `source`），新→旧 |
| `workspaces` | 工作区清单与统计，可按 `source` 只看一个 harness |
| `status` | 索引自身状态；**唯一在无索引时也能回答的操作** |
| `index` | 建或刷新索引，与查询共用 30s 工具预算；源文件 mtime+size 未变就跳过，会话攒到 1000+ 时转后台 job 并返回 jobId |

参数一律 **snake_case**（`session_id` / `window_before` / `dedupe_by_session`），与宿主自带工具一致。

排序按 `bm25 / 权重`：`user 1.0 / title 1.1 / assistant 1.2 / tool 1.5`。FTS5 的 bm25 是负数，所以**除以**权重才是降权 —— 乘法反而会把工具调用顶到最前面。

### 设置页：用哪套会话工具，要不要 Codex

设置 → **会话检索**，一个三选一下拉 + 一个 Codex 开关。

三选一决定哪些会话检索工具对模型可见：

| 选项 | 效果 |
|---|---|
| `sessiongraph`（默认） | 隐藏宿主自带的 `session_search` / `session_event_search` / `session_trace` / `session_event_trace` / `session_event_read`，只留 `sessiongraph` |
| `kernel` | 反过来：隐藏 `sessiongraph`，只留宿主那五个 |
| `both` | 两套都暴露。模型可能同一件事查两遍，也更占上下文 |

**工具集切换立即生效，不用重启。** 实现是宿主的 `agent.ctx.tools.restrict({ deny })`（按 agent 作用域遮蔽，被隐藏的工具连 schema 都不进请求），加一段 per-agent 的系统提示覆盖。

**「同步 Codex 的历史会话」是一行开关，点一下就保存**（不用再按「保存」按钮 —— 布尔量不该要第二下确认；请求失败会把开关拨回去）。它控制第 1 节那个 Codex 源要不要进索引。它跟工具集不是一回事：工具集改的是「模型看见哪些工具」（立刻生效），这个改的是「库里有哪些会话」（**下次索引运行时生效**，因为索引器每次运行才读它）。关掉之后下一次运行会把这些行删掉，开关本身不碰 `~/.codex` 里的任何文件。

两项选择都落在 `<indexRoot>/panel.json`，重启后读回；文件里没有 `codexSync` 就跟随插件配置的 `codex`，文件坏了也跟随配置 —— 面板从来不是唯一真相，只有人明确保存过的那一项才是。

### 查询引擎

读路径有两套实现，同一个 `index.db`：

- **原生（Rust）**：`rusqlite` 只读打开，复用索引时的同一份中文 bigram 分词器，一次 napi 调用返回 JSON
- **TypeScript**：`node:sqlite`

`engine: auto`（默认）优先原生，缺二进制或调用失败时静默回退 TypeScript 并只记一次日志。真实库（700+ 会话）实测单次 `search`：Rust **3.5–4 ms**、TypeScript **22 ms**。两套实现有逐 operation 对拍测试（11 种请求形态结果全等）。

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
| **会话创建时**（已有索引） | `agent/created` → 普通后台 promise 增量（不注册宿主 job，避免完成通知注入会话） | 59–107ms |
| **查询前** | `status.json` 的 `indexedAt` 超过 5 分钟就先增量再查 | 约 400ms |
| **当前会话** | 接入宿主 `ctx.sessionQuery`，把还没落盘的 live 会话也索引进来 | 可忽略 |

想完全手动：`autoBuild: false` 关掉首次自动建库，`autoIndex: false` 连增量也关掉，之后一切靠 `sessiongraph`（operation `index`） / `/sessiongraph index`。

**每一轮都有 deadline**：自动刷新超过 `autoIndexTimeoutMs`（默认 15 分钟）会被 abort 并释放该 indexRoot，避免一个永不结束的 run 把后续会话的自动刷新永久抑制。

### 线上有新版本时

**用完工具就说一声。** 插件没法自我升级——它装在 profile 的依赖树里，改那棵树是宿主的事。所以它做次优的那件事：某个工具被调用之后，后台查一次 registry，发现线上版本比正在运行的更新，就把一条通知追加进下一步的对话，模型和用户都看得见。三个细节让它不至于变成噪音：检查只在工具用过之后才发生，不会凭空提醒；同一条版本只提醒一次，`notifiedVersion` 落盘记着，重启桌面也不重播；查询间隔默认六小时，而查不到、超时、写盘失败都只是「没有可说的」，绝不影响工具本身。registry 按 npm 自己的顺序解析——`npm_config_registry` 环境变量优先，其次用户 `~/.npmrc` 里的 `registry=`，最后才是 npm 官方地址——所以配了镜像的机器查的就是那个镜像。`updateCheck: false` 关掉整个检查，`updateCheckIntervalMs` 调间隔。

### 历史类问题会收到一次提示

系统提示已经说了「查本地历史用 sessiongraph」。这个版本补上真正会失效的那一刻：如果用户最后一条亲手输入的消息像是在问过去的事（`上次` / `之前` / `昨天` / `last time` 等），而本会话还没用过这两个工具，插件就在这次模型请求上追加一条很短的提示，指向 `sessiongraph`。三条规则控制噪音：只认 `source.kind === 'user'` 的真人输入（注入上下文、工具结果、别的插件的 notice 都不会触发，所以提示不会自我触发）；每个会话最多一次；工具用过后不再出现。`historyHint: false` 关闭。

### 索引什么

只收有价值的：`user/message`（仅 `source.kind === 'user'`，即人真正打的字）、`assistant/message` 的 `text` 块（`reasoning` 占 61% 字节，不收）、`tool/call` 的名字与参数、`session/title`。跳过 `tool/result` 正文、`request/header`、`step/*`、`job/*`。

### 两个 harness，一份索引

DSH 的日志和 OpenAI Codex 的 rollout 日志解析进**同一个库**，每行会话用 `session.source` 标明来源（`dsh` / `codex`）—— 问「这个仓库当初怎么定的」不应该取决于当时哪个 agent 在开。

| | 位置 | 形状 |
|---|---|---|
| `dsh` | `~/.dsh/sessions/<escaped-cwd>/<id>/session.vN.jsonl.zstd` | 首行 header + 扁平事件 |
| `codex` | `~/.codex/archived_sessions/*.jsonl.zst`（归档）与 `~/.codex/sessions/<yyyy>/<mm>/<dd>/`（活会话） | 信封 `{timestamp, ordinal, type, payload}` |

Codex 侧的三条规则是踩过才定的：

- **`developer` 角色不是人。** Codex 每轮把整套指令集塞进一条 `developer` message，收进去会让系统提示变成全库最匹配的文档。
- **`user` 角色也不一定是人。** `<environment_context>`、`<user_instructions>`、`<permissions instructions>` 都走 `user` 角色；本机实测 1678 条 user 记录里有 251 条只有注入、没有人话。所以按标签剥掉，剥完为空就整条丢弃（一条记录可以既有环境块又跟真问题，整条丢会连问题一起丢）。
- **标题不在日志里。** Codex 的 thread name 记在 `~/.codex/session_index.jsonl`，每轮索引读一次该文件补标题（本机 88 个会话里 34 个有）。

索引的量级参考（本机）：Codex 88 会话 / 27752 条（user 1427、assistant 8222、tool 18069），DSH 764 会话 / 112562 条，合起来全量重建 27 秒、增量 274ms。

**原生内核暂未覆盖 Codex**：Rust 只解析 DSH 日志。所以当 `codex` 打开且 `~/.codex` 里确实有日志时，那一次运行直接走 TypeScript 引擎（`engine: 'native'` 时在 stderr 说明原因），而不是悄悄丢掉一半语料。`codex: false` 关闭 Codex 采集，`codexRoot` 换个 Codex home。

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

装完重启 DSH，首次调用 `sessiongraph`（operation `index`） 建库，之后自动增量。

## 开发

```sh
pnpm install
pnpm build      # tsc -b，五个 TS 项目引用
pnpm test       # vitest run，200+ 测试
```

内部契约（数据格式、schema、分词规则、各包职责、DSH 能力复用决策）见 [`DESIGN.md`](./DESIGN.md)。
