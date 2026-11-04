/**
 * Loader for the native Rust index kernel.
 *
 * The kernel is a napi-rs `cdylib` (`sessiongraph-core.<platform>-<arch>.node`) built from
 * `crates/sessiongraph-core` and copied beside this module by `build-native.sh`. Nothing here may
 * throw: a machine without a built binary is a normal state, and the caller decides whether to fall
 * back to the TypeScript indexer. So every probe is wrapped, and a load failure simply yields
 * `undefined`.
 *
 * Field names: the Rust side declares snake_case (`index_path`, `elapsed_ms`) and napi-rs maps them
 * to camelCase JS properties (`indexPath`, `elapsedMs`), which is what {@link NativeIndexReport}
 * describes. Verified against the built module by `tests/native.spec.ts`.
 * @module dsh-plugin-sessiongraph-native
 */

import { createRequire } from 'node:module'

/** Options for one native index run. Mirrors the Rust `IndexOptions` (napi camelCases it). */
export interface NativeIndexOptions {
  /** Directory the harness writes its session logs to (`~/.dsh/sessions`). */
  sessionsRoot: string
  /** Absolute path of the index file to write (`<indexRoot>/index.db`). */
  indexPath: string
  /** Rebuild every session from scratch into `index.db.tmp` and rename it into place. */
  force?: boolean
  /** Index only sessions whose `cwd` matches this workspace (exact, or a prefix without `/`). */
  workspaceFilter?: string
  /** Index only one session, by full id or unambiguous prefix. */
  sessionFilter?: string
  /** Longest message text stored whole (default 4000). */
  maxEntryChars?: number
  /** Longest tool invocation text stored whole (default 2000). */
  toolCallChars?: number
  /** Logs larger than this are skipped and reported in `failed` (default 67108864). */
  maxFileBytes?: number
}

/** One session log the native kernel could not parse. */
export interface NativeFailedSession {
  /** Absolute path of the log. */
  path: string
  /** Bounded reason, at most 200 characters. */
  reason: string
}

/** What one native index run did. Field-for-field `SessiongraphIndexReport`. */
export interface NativeIndexReport {
  /** Absolute path of the index the run wrote. */
  indexPath: string
  /** Sessions added since the previous run. */
  added: number
  /** Sessions whose source changed and were re-written. */
  updated: number
  /** Sessions skipped because their source was unchanged. */
  skipped: number
  /** Sessions dropped because their source file disappeared. */
  removed: number
  /**
   * Live (still-running) sessions rebuilt from the host's in-memory view this run. The native
   * kernel has no access to the host's `sessionQuery`, so it always reports 0: the caller's live
   * pass owns those rows, and this kernel preserves them (`live://` rows are never removed here).
   */
  liveSessions?: number
  /** Live sessions left out by the caller's cap. Always 0 from this kernel, for the same reason. */
  liveSkipped?: number
  /** Sessions discovered in total across all source roots. */
  discovered: number
  /** Sessions that failed to parse, with a bounded reason. */
  failed: NativeFailedSession[]
  /** Searchable entries in the index after the run. */
  entries: number
  /** Sessions in the index after the run. */
  sessions: number
  /** Distinct workspaces in the index after the run. */
  workspaces: number
  /** Bytes the index occupies after the run. */
  bytes: number
  /** Wall-clock duration of the run, milliseconds. */
  elapsedMs: number
}

/** The loaded native module's surface. */
export interface NativeKernel {
  /**
   * Build or refresh one index, off the JavaScript thread.
   *
   * Answers a promise because the kernel's body runs on libuv's thread pool. It used to be a
   * synchronous export — which held the host's event loop for the whole run and froze the UI even
   * though the call arrived through the job registry, measured at 1294 ms on one 17 MB session log.
   * @param options - roots and scope switches.
   * @returns what the run did.
   * @throws when the index cannot be written; parse failures are reported, not thrown.
   */
  indexSessions(options: NativeIndexOptions): Promise<NativeIndexReport>
}

/** `undefined` until the first {@link loadNative} call, then the kernel or `null` when absent. */
let cached: NativeKernel | null | undefined

/**
 * Load the native kernel, or report that this machine has none.
 *
 * Probes the build outputs in order — the local `.node` beside this module first, then the napi-rs
 * platform-package convention — and returns `undefined` when none of them loads. It never throws,
 * so an absent binary degrades to a caller-side fallback instead of a plugin load failure.
 * @returns the kernel, or `undefined` when no usable binary is present.
 */
export function loadNative(): NativeKernel | undefined {
  if (cached !== undefined) return cached ?? undefined
  cached = null
  try {
    const require = createRequire(import.meta.url)
    for (const specifier of candidateSpecifiers()) {
      try {
        const loaded: unknown = require(specifier)
        const kernel = asKernel(loaded)
        if (kernel !== undefined) {
          cached = kernel
          return kernel
        }
      } catch {
        // Missing, unbuilt, or built for another ABI: try the next candidate.
      }
    }
  } catch {
    // `createRequire` cannot fail in practice; keep the no-throw contract regardless.
  }
  return undefined
}

/**
 * Candidate module specifiers for the built binary, most local first.
 * @returns specifiers to probe in order.
 */
function candidateSpecifiers(): string[] {
  const platform = `${process.platform}-${process.arch}`
  return [
    `../sessiongraph-core.${platform}.node`,
    `../dsh-plugin-sessiongraph-native.${platform}.node`,
    `dsh-plugin-sessiongraph-native-${platform}`,
    '../sessiongraph-core.node',
  ]
}

/**
 * Narrow a loaded module to the kernel surface.
 * @param value - whatever `require` returned.
 * @returns the kernel, or undefined when the shape is wrong.
 */
function asKernel(value: unknown): NativeKernel | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { indexSessions?: unknown }
  return typeof candidate.indexSessions === 'function' ? (candidate as NativeKernel) : undefined
}
