# Changelog

本项目从 0.3.0 起维护此文件；更早的版本只列关键节点，逐条变更见 `git log`。

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
