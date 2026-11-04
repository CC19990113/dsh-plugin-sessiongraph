# dsh-plugin-sessiongraph

English | [中文](README.zh.md)

Every DSH session on this machine, indexed as one searchable corpus — the model looks up "where did I say or do this" in milliseconds, instead of you digging through the sidebar or grepping compressed logs.

## Architecture

Six packages behind one strict seam: **adding a store or an indexer never touches the model tools.**

| Package | Role |
|---|---|
| `service` | Defines the `ctx.sessiongraph` seam: query vocabulary, store/indexer registries, schema v1, the Chinese bigram tokenizer |
| `sqlite` | Read provider: answers the five queries from `index.db` |
| `sessions` | Write provider: scan session logs, decode frame by frame, extract entries, write the database (TypeScript and Rust engines) |
| `tool` | Consumer: the two model tools, the `/sessiongraph` command, and the system-prompt section |
| `native` | Loader for the Rust kernel (returns `undefined` on any failure, never throws) |
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

| Operation | What it does |
|---|---|
| `search` | Cross-session full-text search; filters on `workspace` / `after` / `before` / `kinds`. Returns title, workspace, time, turn and a highlighted snippet |
| `session` | Open one session by full id or unique prefix: metadata, ordered entries, child sessions |
| `timeline` | List sessions newest-first, optionally scoped to a workspace |
| `workspaces` | Workspace inventory with session/entry counts |
| `status` | The index's own state — **the only operation that answers before an index exists** |

`sessiongraph_index`: build or refresh on its own 300-second budget; sessions whose source mtime and size are unchanged are skipped, and past a thousand sessions the run becomes a host background job returning a job id.

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

Prefer to drive it yourself? `autoBuild: false` disables the first automatic build and `autoIndex: false` disables the incremental refreshes; everything then goes through `sessiongraph_index` / `/sessiongraph index`.

### When the registry has a newer release

**It says so once, after a tool runs.** A plugin cannot upgrade itself — it lives in a profile's dependency tree, and rewriting that tree is the host's job. So it does the next best thing: after one of its tools runs, it checks the registry in the background and, when the published version is newer than the running one, appends a notice to the next step of the conversation, where both the model and the user can see it. Three details keep it from turning into noise: the check only ever happens *after* a tool was used; a release is announced once, with `notifiedVersion` persisted so a desktop restart does not replay it; and checks run at most every six hours, while an unreachable registry, a timeout, or an unwritable state file all mean "nothing to report" rather than an error. The registry follows npm's own resolution order — `npm_config_registry`, then `registry=` in the user's `~/.npmrc`, then npm's public default — so a machine behind a mirror checks the mirror it actually installs from. `updateCheck: false` turns the whole thing off, and `updateCheckIntervalMs` changes the interval.

### What gets indexed

`user/message` (only `source.kind === 'user'`, i.e. text a human typed), the `text` blocks of `assistant/message` (`reasoning` is 61% of the bytes and is not indexed), `tool/call` names and arguments, and `session/title`. Skipped: `tool/result` bodies, `request/header`, `step/*`, `job/*`.

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

Restart DSH afterwards; the first `sessiongraph_index` call builds the database, and everything after that is incremental.

## Development

```sh
pnpm install
pnpm build      # tsc -b, five TypeScript project references
pnpm test       # vitest run, 200+ tests
```

Internal contracts — data format, schema, tokenizer rules, per-package responsibilities, and which host capabilities this plugin reuses — live in [`DESIGN.md`](./DESIGN.md).
