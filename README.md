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

## How it relates to memory

A memory system stores **conclusions**; sessiongraph stores **evidence**:

| | Memory (OpenViking / MEMORY.md and the like) | **sessiongraph** |
|---|---|---|
| Stores | Extracted facts: preferences, decisions, entities | **Raw records**: every message, every tool call with its arguments |
| How it is produced | Summarized or extracted by a model — lossy, drops detail | **Kept verbatim**, only clipped, never rewritten |
| When it is written | Batched at session end or past a threshold | Incremental on session creation, lazily before queries — hundreds of milliseconds |
| How you search | Semantic (embeddings), recalls by meaning | Full-text (bigram tokens), matches by characters |
| Can it find the exact words | No — only what survived extraction | Yes — including the command and its arguments |
| Good for | "What do I prefer", "what did we decide" | "When did I say this", "what was that command" |

In one line: **memory answers "what is the conclusion"; sessiongraph answers "what was actually said".**

They do not overlap: a conversation may **never enter memory** (short, casual, below any threshold) yet it is always in sessiongraph's raw index. Conversely, a memory entry has usually lost its context, and the only way to check it is to go back to the original.

## Usage

### Three entry points

| Entry | How |
|---|---|
| **The model calls it** | Just ask "which session discussed the splash screen"; it reaches for `sessiongraph` |
| **Slash command** | `/sessiongraph status` / `index` / `search <term>` / `workspaces` |
| **Command results flow back** | After the command runs, its result is injected into the conversation as a `plugin/notice` message, so the model's next turn knows what you looked up — the same mechanism `/plan` uses |

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

Three mechanisms, all automatic:

| When | Mechanism | Cost |
|---|---|---|
| **On session creation** | `agent/created` → background incremental run through `ctx.jobs`, never blocking | 59–107 ms |
| **Before a query** | If `status.json`'s `indexedAt` is older than 5 minutes, refresh incrementally first | ~400 ms |
| **The current session** | Reads the host's `ctx.sessionQuery` and indexes live sessions that have not hit disk yet | negligible |

Only the very first build needs an explicit `sessiongraph_index` call.

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
