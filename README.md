# dsh-plugin-sessiongraph

English | [中文](README.zh.md)

Every DSH **and Codex** session on this machine, indexed as one searchable corpus — the model looks up "where did I say or do this" in milliseconds, instead of you digging through the sidebar or grepping compressed logs.

## Architecture

Six packages behind one strict seam: **adding a store or an indexer never touches the model tools.**

| Package | Role |
|---|---|
| `service` | Defines the `ctx.sessiongraph` seam: query vocabulary, store/indexer registries, schema v1, the Chinese bigram tokenizer |
| `sqlite` | Read provider: answers the seven queries from `index.db`, routing between the native and TypeScript engines |
| `sessions` | Write provider: scan both harnesses' session logs (DSH and Codex), decode, extract entries, write the database; `raw.ts` reads unabridged events back |
| `tool` | Consumer: **one** `sessiongraph` tool (eight operations), the `/sessiongraph` command, the system-prompt section, the settings HTTP route, and tool visibility |
| `native` | Rust kernel: index writes (`indexSessions`) and queries (`query`); returns `undefined` on any failure, never throws |
| `panel` | Browser half only: the settings "会话检索" tab (`dsh.client`; the host entry is an empty apply) |
| `bundle` | Installable meta-package: `cordis.patch.yml` |

**Routing is "exactly one claimant", never first match.** Every registered store is asked concurrently on each query; zero claimants and several claimants both throw (`SESSIONGRAPH_UNAVAILABLE` / `SESSIONGRAPH_CONFLICT`). Registration order and hot reload therefore never change the result. `status` is the one operation that answers with no store at all — someone who has never built an index needs to learn that fact, not receive the same failure every other operation raises.

### Rust kernel

The indexing path is a napi-rs native module (Rayon for parallelism, rusqlite for the database), not WASM: the kernel must read the filesystem directly, write SQLite directly, and move gigabyte-scale data. WASM's boundary copies and absent fs/sqlite are disqualifying.

| | Full rebuild | Incremental | Query | Index size |
|---|---|---|---|---|
| **Rust kernel** | **6.76 s** | **59–107 ms** | 0.1–6.9 ms | ~170 MB |
| TypeScript (fallback) | 19.22 s | 230 ms | same | ~170 MB |

Both databases hold **identical content**, so this is not "a different index": `sqlite_master` DDL is byte-for-byte equal, every unchanged session compares field by field with zero differences, entry rows / session rows / FTS token multisets hash to the same SHA-256, and the TypeScript store reads a Rust-built database directly.

Engine selection is `engine: 'auto' | 'native' | 'typescript'`, defaulting to `auto`: use the native kernel when present, fall back silently otherwise — **a missing binary is never an error**.

## How it relates to memory and to the built-in session search

The same question has three homes, and picking the wrong one means finding nothing:

| | Memory (OpenViking / MEMORY.md) | **Built-in DSH `session_search`** | **sessiongraph** |
|---|---|---|---|
| Stores | Extracted conclusions: preferences, decisions, entities | **Semantic text** projected from session events, per event type | **Raw entries**: message bodies, tool-call names and arguments |
| Form | Markdown entries under `viking://` | SQLite FTS5 in an **in-memory** database (`openAt: first-search`, rebuilt every start) | SQLite **on disk**, maintained incrementally |
| Scope | Machine-wide | **The caller's workspace** | Machine-wide, across workspaces |
| Chinese | Semantic (embeddings), recalls by meaning | No — the `unicode61` tokenizer does **no CJK handling** at all: `我今天在改广告SDK` is one token, so `广告` matches nothing | Yes — purpose-built bigram tokenizer, **two-character terms match** |
| How you search | By meaning | By token or phrase (English keywords, whole words) | By characters, full text (Chinese and English) |
| Can it find the exact words | No — only what survived extraction | Partly: returns an excerpt | Yes — the whole thing, including commands and arguments |
| Good for | "What do I prefer", "what did we decide" | English keywords, exact phrases, recent sessions | "When did I say this", "what was that command" |

In one line: **memory answers "what is the conclusion", the built-in search answers "which session mentioned it", sessiongraph answers "what was actually said".**

Since 0.2.0 the model no longer has to choose: the settings page hides the host's five `session_*` tools by default and leaves only `sessiongraph` (see "Settings: which session tools the model sees"). Switch back any time.

Three differences that matter in practice:

- **Chinese**: the built-in search is effectively unusable for Chinese (its tokenizer has no CJK handling); sessiongraph is built for two-character Chinese terms
- **Scope**: the built-in search only sees the caller's workspace; sessiongraph spans every workspace
- **Persistence**: the built-in index lives in memory, opens on first search, and is gone after a restart; sessiongraph's index is on disk, usable immediately, kept fresh incrementally

Memory does not overlap with either: a conversation may **never enter memory** (short, casual, below any threshold) yet it is always in sessiongraph's raw index. Conversely, a memory entry has usually lost its context, and checking it means going back to the original.

## Usage

### Three entry points

| Entry | How |
|---|---|
| **The model calls it** | Just ask "which session discussed the splash screen"; it reaches for `sessiongraph` |
| **Slash command** | `/sessiongraph status` / `index` / `search <term>` / `workspaces` |
| **Command results flow back** (opt-in, off by default) | With `injectCommandResults: true` the command's result is injected into the conversation as a `plugin/notice` message, so the model's next turn knows what you looked up — the same mechanism `/plan` uses. Off by default because commands run on the host's main thread, and calling `agent.inject` from a handler drags the agent loop onto that stack: `/sessiongraph status` hung the desktop that way |

### Tools

`sessiongraph`:

**One tool, eight operations.** Since 0.2.0 indexing is no longer a separate tool (`sessiongraph_index` is gone).

| Operation | What it does |
|---|---|
| `search` | Cross-session full-text search; filters on `sessionId` / `workspace` / `source` / `after` / `before` / `kinds`. One hit per session by default (`dedupeBySession: false` to disable). Returns source, title, workspace, time, turn and a highlighted snippet |
| `session` | Open one session by full id or unique prefix: metadata, ordered entries, child sessions |
| `event` | Read **one unabridged raw event** from the source log (not the index's clipped text), with optional `windowBefore` / `windowAfter` neighbours |
| `trace` | Without `seq`: session lineage (ancestor chain + recursive descendant tree). With `seq`: that event's replacement chain, shadowed range and cited source events |
| `timeline` | List sessions newest-first, optionally scoped to a workspace |
| `workspaces` | Workspace inventory with session/entry counts |
| `status` | The index's own state — **the only operation that answers before an index exists** |
| `index` | Build or refresh inside the shared 30-second tool budget; unchanged sources are skipped, and past a thousand sessions the run becomes a host background job returning a job id |

Tool parameters are **snake_case** (`session_id`, `window_before`, `dedupe_by_session`), matching the built-in tools.

Ranking is `bm25 / weight` with `user 1.0 / title 1.1 / assistant 1.2 / tool 1.5`. FTS5's bm25 is negative, so **dividing** by the weight demotes — multiplying would push tool calls to the top.

### Settings: which session tools the model sees, and whether Codex joins

Settings → **会话检索** (Session search): a three-way dropdown plus one Codex switch.

The dropdown decides which session tools the model sees:

| Choice | Effect |
|---|---|
| `sessiongraph` (default) | Hides the host's `session_search` / `session_event_search` / `session_trace` / `session_event_trace` / `session_event_read`, keeping only `sessiongraph` |
| `kernel` | The reverse: hides `sessiongraph`, keeps the host's five |
| `both` | Exposes both. The model may check the same thing twice, and it costs more context |

**The tool-set switch is immediate, no restart.** It works through the host's `agent.ctx.tools.restrict({ deny })` (a per-agent restriction — a hidden tool's schema never enters the request) plus a per-agent system-prompt override.

**"同步 Codex 的历史会话" is one checkbox that saves the moment it moves** — a boolean should not need a second confirmation button, and a failed save flips the switch back. It decides whether the Codex source from the section above is part of the corpus. It is not the same kind of setting as the dropdown: the dropdown changes *which tools the model sees* (immediate), while this changes *which conversations are in the index* (**effective on the next index run**, because that is when the indexer reads it). Turning it off drops those rows on the next run; it never touches a file under `~/.codex`.

Both choices land in `<indexRoot>/panel.json` and are read back on start. A document without `codexSync` — or a corrupt one — falls back to the configured `codex`, so the panel is never the only source of truth: only a value a human actually saved is authoritative.

### Query engines

Two implementations read the same `index.db`:

- **Native (Rust)**: `rusqlite` opened read-only, reusing the same Chinese bigram tokenizer the indexer uses, one napi call returning JSON
- **TypeScript**: `node:sqlite`

`engine: auto` (the default) prefers native and falls back to TypeScript silently — logging once — when the binary is missing or a call throws. Measured on a real 700+ session index, one `search`: Rust **3.5–4 ms**, TypeScript **22 ms**. The two are held together by per-operation parity tests (11 request shapes, identical results).

### Commands

| Command | What it does |
|---|---|
| `/sessiongraph` | Same as `status` |
| `/sessiongraph status` | Index size, disk usage, last build time, live session count, current workspace |
| `/sessiongraph index [--force]` | Build or refresh; large corpora delegate to a background job and print the job id |
| `/sessiongraph search <term>` | Search directly, printing the top ten hits |
| `/sessiongraph workspaces` | Workspace list, `*` marking the current one |

### Automatic indexing

**A fresh install needs nothing from you.** Four mechanisms, all automatic:

| When | Mechanism | Cost |
|---|---|---|
| **The first time** (no index yet) | Session creation builds it in the background (`autoBuild`, on by default) | seconds to minutes, off the critical path |
| **On session creation** (index present) | `agent/created` → background incremental run, never blocking and never registered as a host job (a job's completion notice would inject into the conversation) | 59–107 ms |
| **Before a query** | If `status.json`'s `indexedAt` is older than 5 minutes, refresh incrementally first | ~400 ms |
| **The current session** | Reads the host's `ctx.sessionQuery` and indexes live sessions that have not hit disk yet | negligible |

Prefer to drive it yourself? `autoBuild: false` disables the first automatic build and `autoIndex: false` disables the incremental refreshes; everything then goes through `sessiongraph` (operation `index`) / `/sessiongraph index`.

**A run has a deadline.** Each automatic refresh is aborted after `autoIndexTimeoutMs` (fifteen minutes by default) and its index root released, so a run that never settles cannot suppress every later session's refresh.

### When the registry has a newer release

**It says so once, after a tool runs.** A plugin cannot upgrade itself — it lives in a profile's dependency tree, and rewriting that tree is the host's job. So it does the next best thing: after one of its tools runs, it checks the registry in the background and, when the published version is newer than the running one, appends a notice to the next step of the conversation, where both the model and the user can see it. Three details keep it from turning into noise: the check only ever happens *after* a tool was used; a release is announced once, with `notifiedVersion` persisted so a desktop restart does not replay it; and checks run at most every six hours, while an unreachable registry, a timeout, or an unwritable state file all mean "nothing to report" rather than an error. The registry follows npm's own resolution order — `npm_config_registry`, then `registry=` in the user's `~/.npmrc`, then npm's public default — so a machine behind a mirror checks the mirror it actually installs from. `updateCheck: false` turns the whole thing off, and `updateCheckIntervalMs` changes the interval.

### A nudge for history questions

The system prompt already says to search the index instead of grepping compressed logs. This release adds the moment-of-use reminder: when the last message the user typed reads like a question about past conversations (`上次`, `之前`, `昨天`, `last time`, …) and this conversation has not used either tool yet, the plugin appends one short notice to that model request pointing at `sessiongraph`. Three rules keep it quiet: only a message whose source is the user's own typing can trigger it (injected context, tool results and other plugins' notices are ignored, so the reminder cannot trigger itself); it speaks at most once per conversation; and it never speaks after `sessiongraph` or `sessiongraph` (operation `index`) has run. `historyHint: false` turns it off.

### What gets indexed

`user/message` (only `source.kind === 'user'`, i.e. text a human typed), the `text` blocks of `assistant/message` (`reasoning` is 61% of the bytes and is not indexed), `tool/call` names and arguments, and `session/title`. Skipped: `tool/result` bodies, `request/header`, `step/*`, `job/*`.

### Two harnesses, one index

DSH's own logs and OpenAI Codex's rollout logs are parsed into **one** index, each session row tagged with `session.source` (`dsh` / `codex`) — "how did we decide this for this repo" should not depend on which agent happened to be driving.

| | Where | Shape |
|---|---|---|
| `dsh` | `~/.dsh/sessions/<escaped-cwd>/<id>/session.vN.jsonl.zstd` | header line + flat events |
| `codex` | `~/.codex/archived_sessions/*.jsonl.zst` (archived) and `~/.codex/sessions/<yyyy>/<mm>/<dd>/` (active) | envelopes `{timestamp, ordinal, type, payload}` |

Three Codex rules were learned the hard way:

- **`developer` is not a human.** Codex injects its whole instruction set as a `developer` message on every turn; indexing it would make the system prompt the most-matching document in the corpus.
- **`user` is not always a human either.** `<environment_context>`, `<user_instructions>` and `<permissions instructions>` all arrive as `user` role — on this machine 251 of 1678 user-role records carried nothing but injected context. The tags are stripped and a record that reduces to nothing is dropped; discarding whole records instead would lose the question that follows an environment block.
- **The title is not in the log.** Codex keeps thread names in `~/.codex/session_index.jsonl`, read once per run to fill titles (34 of this machine's 88 sessions have one).

Measured here: Codex 88 sessions / 27752 entries (1427 user, 8222 assistant, 18069 tool), DSH 764 sessions / 112562 entries — 27 s for a full rebuild, 274 ms incremental.

**The native kernel does not read Codex yet** — the Rust parser covers DSH logs only. So when `codex` is on and `~/.codex` really holds logs, that run takes the TypeScript engine (with a stderr line when `engine: 'native'` was pinned) rather than silently dropping half the corpus. `codex: false` turns Codex collection off; `codexRoot` points at another Codex home.

### Why two-character Chinese terms match

SQLite's `unicode61` treats `我今天在改广告SDK` as a single token, so searching `广告` finds nothing; `trigram` needs at least three characters, so two-character words stay unreachable. Write and read paths therefore share one purpose-built tokenizer (`packages/service/src/tokenize.ts`): CJK runs split into overlapping bigrams (`广告点击` → `广告` `告点` `点击`), Latin/digit runs become lowercased whole words split on `_`, and query tokens are quoted and joined with `AND`. The trade-off is recall over phrase precision — searching your own history is a "find it" problem.

## Install

```sh
dsh plugin add dsh-plugin-sessiongraph
```

Or link a local checkout in a profile:

```json
"dependencies": { "dsh-plugin-sessiongraph": "link:/path/to/dsh-plugin-sessiongraph" },
"dsh": { "profile": { "bundles": [ "...", "dsh-plugin-sessiongraph" ] } }
```

Restart DSH afterwards; the first `sessiongraph` (operation `index`) call builds the database, and everything after that is incremental.

## Development

```sh
pnpm install
pnpm build      # tsc -b, five TypeScript project references
pnpm test       # vitest run, 200+ tests
```

Internal contracts — data format, schema, tokenizer rules, per-package responsibilities, and which host capabilities this plugin reuses — live in [`DESIGN.md`](./DESIGN.md).

## Releasing

Two commands, because `pnpm-lock.yaml` cannot be regenerated before the platform addons exist on the
registry: an addon version only becomes resolvable after the tag-triggered workflow publishes it.

```sh
pnpm run release:prepare 0.1.22     # every published manifest + the five addon pins + the exclude list
git commit -am "chore(release): 0.1.22"
git tag v0.1.22 && git push --tags  # publish.yml builds the kernels first, then the five packages
pnpm run release:finish             # regenerate the lockfile, then re-run the gate CI runs
git add -A && git commit -m "chore: 补上平台包在 lockfile 里的记录"
```

`pnpm run check:versions` is that gate. It compares the six package versions, the five kernel
manifests, `packages/native`'s `optionalDependencies` pins, the lockfile's recorded specifiers and the
`minimumReleaseAgeExclude` list — and fails *before* anything is published rather than halfway through
a release. Both `ci.yml` and `publish.yml` run it first.
