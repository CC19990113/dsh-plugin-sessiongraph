# Changelog

本项目从 0.3.0 起维护此文件；更早的版本只列关键节点，逐条变更见 `git log`。

## 0.3.3

### 新增

- **`touched` operation**：一个会话碰过哪些文件。从该会话的 `tool` 条目现算，只认结构化参数
  （`read`/`edit`/`write`/`read_image` 的 `file_path`、`grep`/`glob` 的 `path`），同路径合并成一条并给出
  次数、首尾时间与涉及的 tool 名；被索引截断的调用计入 `unparsed`，`bash` 的自由文本一律不算。
  **不升 schema、不动 Rust 内核**：单会话 tool 条目均值 124、最大 1504，现算一次是毫秒级，不值得为它
  加表、重建全机索引、再写一份 Rust 解析。
- **历史问题先给导航**：`agent/pre-step` 不再只丢一句「去查索引」，而是先查一次索引，注入最多三条
  「日期 · 工作区 · 标题 · 会话 id」。300 ms 硬超时，索引缺失、损坏、超时一律退回原来那句静态提醒，
  **永不拒绝该步**。

### 变更

- 系统提示段的索引状态只说「有没有索引」这个布尔，不再报会话数、条目数、构建时间：`text` 函数每次
  装配都会重算，那些数字每次增量刷新都在变，等于每刷一次索引就重写一次系统提示、把它的缓存全部作废。
  规模与新鲜度改由 `operation: "status"` 按需取。
- 系统提示段改为英文 + Markdown：一段说明、三条要点、一张 operation 表。
- 工具 description 与参数描述瘦身：parameters 2238 → 1591 字符（约省 185 token/请求），删掉 operation
  用途的复述——系统提示里的表已经有了，不必每请求再付一次。
- 默认结果收窄：`session` 的 entries 200 → 50、`search` 的 snippet 600 → 400 字符。
- 记忆类问题（`偏好` / `喜欢` / `习惯` / `平时` / `一般` / `风格` / `记住`）不再触发历史提醒，那属于
  记忆层，索引层注入只是噪音。

### 修复

- **裸 uuid 前缀也能解析 `session-` 前缀的会话 id**：索引里两种拼法并存（实测 385 个带前缀 + 440 个裸
  uuid），而导航把 id 截到 8 位后，带前缀的全部渲染成 `session-` —— 八个字符指向不了任何会话。
  解析现在同时匹配 `X%` 与 `session-X%`，渲染先剥前缀再截断。
- `touched` 的路径归一化统一去掉尾部斜杠：`path.normalize` 保留尾斜杠而 `path.resolve` 丢弃，导致
  同一目录按绝对路径与相对路径会拆成两行。

## 0.3.2

### 新增

- **Rust 内核也解析 Codex rollout**（`crates/sessiongraph-core/src/codex.rs`）：注入块剥离、`developer`
  跳过、三种 tool call、`createdAt` 取最早 timestamp、标题取自 `session_index.jsonl`，与 TypeScript
  侧的 `codex.ts` 逐条对齐。
- `IndexOptions` 加 `codex` / `codexRoot`；两源合并后按 `source` 分派解析，去重键对齐 TypeScript 的
  `last_at`。

### 性能

- **打开 Codex 源时不再回退 TypeScript 引擎**：全量 34.8s → 9.4s（本机 856 会话 / 141891 条）。
  此前 `codex: true` 且 `~/.codex` 有日志时整轮跳过 native。

### 修复

- `write.rs` 的 `source` 列此前写死 `'dsh'`，改为随会话绑定。

### 内部

- `parse.rs` 的三个工具函数提为 `pub(crate)` 供 Codex 解析复用 —— 两个解析器必须共用同一套
  clip/空白策略，否则同一句话会因 harness 不同而存得不一样。

### 对拍方法

拿一份**冻结快照**（复制会话文件，排除活会话边写边读）让两个引擎各跑一遍：89 会话 / 27847 条，
逐数一致。真实库里两次 run 相差几条通常是读取时刻不同，不是解析分歧。

## 0.3.1

### 修复

- **「同步 Codex 的历史会话」与工具集共用一个保存按钮**：一次保存写入整个 `panel.json`，
  两项一起提交；任一改动都显示「有未保存的改动」。0.3.0 曾把它做成草稿、要求单独按保存，
  实测点完没落盘。
- **非 DSH 会话有了明确标记**：任何答案提到 Codex 的会话时行首带 `[codex]`，末尾追加一行
  「不是本机 DSH 会话、侧边栏找不到、可以用 session / event 读原文」。覆盖 search / session /
  event / trace / timeline；全是 DSH 会话时不出现。

### 变更

- **历史提醒去掉厂商绑定**：原判据用某个记忆插件的 URI 前缀识别「本步注入了记忆」，换台机器、
  换个插件、或没装插件就失效。现在不检测注入内容、不提任何厂商，文案本身说清「摘要不是原文」。
- 提醒压到 54 字符：`[会话历史提醒] 这是在问本机过去会话的事，手上的摘要不是原文，先 sessiongraph 查原文再回答。`
- 关键词补「继续做 / 接着做 / 继续弄 / 按上次 / 接着上次」。

### 背景

本机实测 765 个 DSH 会话里只有 17 个调用过 `sessiongraph`（共 76 次），同期某记忆插件的检索
工具跑了 3149 次；含「上次/之前」的会话几乎都不去查原文。改动针对的是「摘要太方便」而不是工具本身。

## 0.3.0

### 新增

- **索引 OpenAI Codex 的 rollout 日志**（`~/.codex/archived_sessions/` 与 `~/.codex/sessions/<yyyy>/<mm>/<dd>/`），
  与 DSH 自己的会话解析进同一个 `index.db`。每行会话用 `source` 区分来源。
  - 跳过 `developer` 角色（整套指令集）、`reasoning`、工具结果、`event_msg/*`、`compacted`
  - `user` 角色里的 `<environment_context>` / `<user_instructions>` / `<permissions instructions>` 按标签剥离，剥空才丢弃
  - 标题取自 `~/.codex/session_index.jsonl` 的 `thread_name`
  - 配置：`codex`（默认 true）、`codexRoot`（默认 `~/.codex`）
- **`source` 查询维度**：`search` / `timeline` / `workspaces` 可传 `source=dsh|codex` 只看一侧；
  命中与会话摘要都带 `source`，渲染时只给非 DSH 的行加来源标记。
- **设置页「同步 Codex 的历史会话」开关**：写入 `<indexRoot>/panel.json` 的 `codexSync`，
  索引器每轮读取，关掉后下一次运行删除已有 codex 行；不需要重启，也不碰 `~/.codex` 任何文件。

### 破坏性变更

- **`index.db` 升到 schema v3**：`session` 表新增 `source TEXT NOT NULL`。旧索引由下一次运行整体重建
  （store 按 schemaVersion 拒读旧文件，与既有策略一致）。首次启动后需要一次全量索引。

### 文档与内部

- 系统提示与工具描述改为「DSH + Codex 双源」，并说明 `source` 过滤；此前写的是「全部 DSH 会话」。
- `PANEL_FILE_NAME` / `PANEL_CODEX_SYNC_KEY` 下沉到 `service` 包：`tool` 写、`sessions` 读同一个文件。
- Rust 内核同步 schema v3（写 `source = 'dsh'`、查询投影带 `source`）；**它不解析 Codex**，
  因此扫到 Codex 日志的那轮运行跳过 native 走 TypeScript（`engine: 'native'` 时在 stderr 说明原因）。

### 实测（作者机器，852 会话 / 140k 条）

- 全量重建 25s、增量 274ms；Codex 贡献 88 会话 / 27752 条（user 1427 / assistant 8222 / tool 18069）
- 面板关掉：`removed 88`、引擎回落 native 1.98s；再打开：`added 88`、TypeScript 3.2s

## 0.2.0

### 破坏性变更

- **合并为单工具**：`sessiongraph_index` 被删除，建索引改为 `sessiongraph` 的 `operation=index`。
- **删除 `sessiongraph_index` 工具**同时意味着工具数量从两个变成一个，八个 operation。

### 新增

- `event`：读一条未删节的原始事件（回读源日志），可选前后窗口。
- `trace`：无 `seq` 时追会话血缘，有 `seq` 时追事件替换链 / 遮蔽范围 / 引用源事件。
- **Rust 查询内核**：`rusqlite` 只读打开同一份索引，与 TypeScript 实现逐 operation 对拍。
- **设置页「会话检索」tab**：`sessiongraph` / `kernel` / `both` 三档切换模型可见的会话工具。
- 可选服务改走 `ctx.get()`，属性访问在未注入的宿主上会抛。

## 0.1.21

- 版本一致性门禁接入 CI（`check:versions`），并补上遗漏的 win32 平台包白名单。
- 写锁按 pid 探活并校验所有权，超时运行不再造成两个写者。

## 0.1.20

- 自动索引不再注册宿主 job，避免完成通知污染会话（改为普通后台 promise）。
- 历史类问题在 `agent/pre-step` 追加一条使用提示（`historyHint`，每会话一次）。
- 原生内核改为五平台 npm 包分发（darwin-arm64 / darwin-x64 / linux-x64-gnu / linux-arm64-gnu / win32-x64-msvc）。

## 0.1.19 及更早

- 平台包分发、原生内核异步化、会话索引 MVP 与一系列修复，详见 `git log`。
