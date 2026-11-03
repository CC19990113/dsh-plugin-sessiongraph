# dsh-plugin-sessiongraph

English | [中文](README.zh.md)

**Every DSH session on this machine, indexed as one searchable corpus.**

Ask "where did I work on that feature", "which session did I say this in", "who discussed splash-screen ads" — the model looks it up. No sidebar archaeology, no grepping `~/.dsh/sessions`.

> Indexes **every session** under `~/.dsh/sessions`, not just the caller's workspace.
> Maintains itself; you never have to remember to refresh it.

## What it solves

Session logs live at `~/.dsh/sessions/<workspace>/<session-id>/session.vN.jsonl.zstd`:

| Problem | Reality |
|---|---|
| `grep` finds nothing | The files are **zstd-compressed JSONL** — grep reads compressed bytes |
| The built-in session search cannot do Chinese | It uses SQLite's `unicode61` tokenizer with **no CJK handling at all**: `我今天在改广告SDK` is one single token, so searching `广告` matches nothing |
| Cross-workspace is awkward | Sessions are scattered across dozens of escaped directories, and the built-in tools only see the caller's workspace |
| Decompression is slow | Each file is **multi-frame zstd** (one 234 KB file can hold over a hundred frames); `zstdDecompressSync` returns only the first frame, so a naive read yields a few hundred bytes out of hundreds of KB. A mid-sized corpus decompresses to **gigabytes** |

sessiongraph handles all of it: frame-by-frame decompression, semantic event extraction, its own Chinese bigram index, and a parallel Rust kernel to build it.

## Automatic indexing: nothing for you to run

Three mechanisms, all automatic:

| When | Mechanism | Cost |
|---|---|---|
| **On session creation** | `agent/created` → background incremental run through `ctx.jobs`, never blocking the session | ~60–110 ms |
| **Before a query** | If `status.json`'s `indexedAt` is older than 5 minutes, refresh incrementally first | ~400 ms |
| **The current session** | Reads the host's `ctx.sessionQuery` and indexes **live** sessions that have not hit disk yet | negligible |

Manual entry points remain (`sessiongraph_index`, `/sessiongraph index`), but **day to day you do nothing**.

Only the very first build is explicit (a few seconds with the Rust kernel); everything after that is incremental.

## Three entry points

| Entry | How |
|---|---|
| **The model calls it** | Just ask; it reaches for `sessiongraph` on its own |
| **Slash command** | `/sessiongraph status` / `index` / `search <term>` / `workspaces` |
| **Command results flow back** | After the command runs, its result is injected into the conversation as a `plugin/notice` message, so the model's next turn knows what you looked up (the same mechanism `/plan` uses) |

## How it relates to memory

A memory system stores **conclusions**; sessiongraph stores **evidence**. They do not index the same thing:

| | Memory (OpenViking / MEMORY.md and the like) | **sessiongraph** |
|---|---|---|
| Stores | Extracted facts: preferences, decisions, entities, lessons | **Raw records**: every message, every tool call with its arguments |
| How it is produced | Summarized or extracted by a model, lossy, drops detail | **Kept verbatim**, only clipped, never rewritten |
| When it is written | Batched at session end or past a threshold; tens of seconds to minutes | Incremental on session creation, lazily before queries; hundreds of milliseconds |
| How you search | **Semantic** (embeddings), recalls by meaning | **Full-text** (bigram tokens), matches by characters |
| Storage | Markdown entries under `viking://` | Local SQLite (`~/.dsh/sessiongraph/index.db`) |
| Can it find the exact words | No — only what survived extraction | Yes — the whole thing, including the command and its arguments |
| Good for | "What do I prefer", "what did we decide", "how do we usually handle this" | "When did I say this", "what was that command", "which session discussed X" |

In one line: **memory answers "what is the conclusion"; sessiongraph answers "what was actually said".**

They do not overlap: a conversation may **never enter memory** (short, casual, below any threshold) yet it is always in sessiongraph's raw index. Conversely, a memory entry has usually lost its context, and the only way to check it is to go back to the original in sessiongraph.

## Performance (Rust kernel)

On an Apple Silicon developer machine, a few hundred sessions / ~1.6 GB decompressed:

| | Full rebuild | Incremental | Query | Index size |
|---|---|---|---|---|
| **Rust kernel** (napi-rs + Rayon + rusqlite) | **6.76 s** | **59–107 ms** | 0.1–6.9 ms | ~170 MB |
| TypeScript (fallback path) | 19.22 s | 230 ms | same | ~170 MB |
| Speed-up | **2.84×** | **~3×** | — | — |

**Both databases hold identical content** — this is not "a different index":

- `sqlite_master` DDL is byte-for-byte identical
- Every unchanged session compared field by field (session / entry / FTS tokens) → **zero differences**
- Entry rows, session rows and FTS token multisets hash to the **same SHA-256**
- The TypeScript store reads a Rust-built database directly, and vice versa

### Why napi-rs, not WASM

The kernel must **read the filesystem directly** (hundreds of logs), **write SQLite** (six-figure entry counts plus FTS5), and move **gigabyte-scale** data. WASM's boundary copies and lack of fs/sqlite are disqualifying; napi-rs gets real multi-threaded decompression and parsing through Rayon.

### Engine selection

```ts
engine: 'auto'        // default: use the native kernel when present, silently fall back otherwise
engine: 'native'      // require it; falls back and logs one error if unavailable
engine: 'typescript'  // force the TypeScript path
```

A machine without the `.node` binary (wrong architecture, never built) behaves **exactly as before** — a missing binary is never an error.

Build it with:

```sh
packages/native/build-native.sh
```

> Gotcha: when rustup's default toolchain does not match the Node architecture (typically a Rosetta `x86_64` toolchain next to an arm64 Node), loading the artifact fails with "incompatible architecture". The script pins `aarch64-apple-darwin` and verifies the result with `file`.

## What gets indexed

Only what is worth searching, by event type (byte shares measured across a session sample):

| Event | Indexed | Why |
|---|---|---|
| `user/message` | yes | Only `source.kind === 'user'` — text a human actually typed. Runtime context, skill catalogs and plugin injections are skipped |
| `assistant/message` | yes | Only `content[].type === 'text'`. `reasoning` is **61%** of all bytes and is not indexed |
| `tool/call` | yes | Tool name plus arguments (clipped at 2 KB) |
| `session/title` | yes | Latest one wins |
| `tool/result` | no | 15% of the bytes, little retrieval value |
| `request/header`, `step/*`, `job/*` | no | Noise |

Resulting mix: tool calls 76%, assistant text 19%, user messages 3%, titles 2%.

## Why two-character Chinese terms match

Measured on SQLite 3.50.4 — does `广告` match `我今天在改广告SDK`?

| Tokenizer | Result |
|---|---|
| `unicode61` | no — the whole sentence is one token |
| `trigram` | no — requires three characters, so two-character words never match |
| **Own bigram index** | yes |

Write and read paths share **one tokenizer** (`packages/service/src/tokenize.ts`):

- CJK runs → overlapping bigrams: `广告点击` → `广告` `告点` `点击`
- Latin/digit runs → lowercased whole words, split on `_` (`graph_index` → `graph` `index`)
- Query tokens are double-quoted and joined with `AND`

The trade-off is recall over phrase precision: `广告跳转` may match an entry where those characters are not adjacent. Searching your own history is a "find it" problem, not a "match this exact phrase" problem — so the trade is the right one.

## Tools

### `sessiongraph`

| Operation | What it does |
|---|---|
| `search` | Cross-session full-text search; filters on `workspace`, `after`, `before`, `kinds`. Returns title, workspace, time, turn, and a highlighted snippet |
| `session` | Open one session by full id or **unique prefix**: metadata, ordered entries, child sessions |
| `timeline` | List sessions newest-first, optionally scoped to a workspace |
| `workspaces` | Workspace inventory with session/entry counts and time spans |
| `status` | The index's own state — **the only operation that answers before an index exists** |

### `sessiongraph_index`

Build or refresh, on its own 300-second budget. Sessions whose source mtime and size are unchanged are skipped; past a thousand sessions the run becomes a host background job and returns a job id.

## Install

```sh
dsh plugin add dsh-plugin-sessiongraph
```

Or link a local checkout in a profile:

```json
"dependencies": { "dsh-plugin-sessiongraph": "link:/path/to/dsh-plugin-sessiongraph" },
"dsh": { "profile": { "bundles": [ "...", "dsh-plugin-sessiongraph" ] } }
```

Restart DSH afterwards. The first `sessiongraph_index` call builds the database; everything after that is incremental.

## Architecture

| Package | Role |
|---|---|
| `service` | Defines the `ctx.sessiongraph` seam: query vocabulary, store/indexer registries, schema v1, bigram tokenizer |
| `sqlite` | Read provider: answers the five queries from `index.db` |
| `sessions` | Write provider: scan, frame-by-frame decode, parse, write (TypeScript and Rust engines) |
| `tool` | Consumer: the two model tools, the `/sessiongraph` command, and the system-prompt section |
| `native` | Loader for the Rust kernel — returns `undefined` on any failure, never throws |
| `bundle` | Installable meta-package: `cordis.patch.yml` |

**Routing is "exactly one claimant", never first match.** Every registered store is asked concurrently on every query; zero claimants and several claimants both throw (`SESSIONGRAPH_UNAVAILABLE` / `SESSIONGRAPH_CONFLICT`). Registration order and hot reload therefore never change the result.

**`status` is the one operation that answers with no store at all** — someone who has never built an index needs to learn that fact, not receive the same failure every other operation raises.

## Development

```sh
pnpm install
pnpm build      # tsc -b, five TypeScript project references
pnpm test       # vitest run, 200+ tests
```

Internal contracts — data format, schema, tokenizer rules, per-package responsibilities, and which host capabilities this plugin reuses — live in [`DESIGN.md`](./DESIGN.md).
