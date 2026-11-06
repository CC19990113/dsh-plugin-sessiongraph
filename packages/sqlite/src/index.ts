/**
 * SQLite store for `ctx.sessiongraph`. One plugin instance registers one store that answers every
 * seam operation from the on-disk conversation index an indexer writes to
 * `<indexRoot>/index.db`, opening each root read-only and keeping a bounded set of connections warm.
 * The two exceptions are `event` and `trace`'s event shape: the index holds *semantic text* clipped to
 * a per-entry cap, while those answers must be the original log line, so they read the session's
 * source log through `dsh-plugin-sessiongraph-sessions`.
 *
 * The store is host-local by construction: `node:sqlite` opens a path on the machine running the
 * harness, so availability is decided against the host filesystem rather than `ctx.fs`. Availability
 * is a synchronous `stat` of the index file (the seam asks this on every query); the file is only
 * opened when a query actually needs it.
 *
 * Namespace plugin (named exports, no default export). Lifecycle is effect-scoped: disposal
 * unregisters from `ctx.sessiongraph` first, then closes every open connection.
 * @module dsh-plugin-sessiongraph-sqlite
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SessiongraphStoreId, assertNever } from 'dsh-plugin-sessiongraph-service'
import type {
  SessiongraphRequest,
  SessiongraphResultFor,
  SessiongraphService,
  SessiongraphStoreProvider,
} from 'dsh-plugin-sessiongraph-service'
import type {} from 'dsh-plugin-sessiongraph-service'
import { IndexPool, indexExists } from './database.ts'
import { DEFAULT_ENGINE, queryNatively } from './native-query.ts'
import type { SessiongraphStoreEngine } from './native-query.ts'
import { event, search, session, status, timeline, trace, workspaces } from './queries.ts'

export { IndexPool, databasePath, indexExists, openIndex } from './database.ts'
export { DEFAULT_ENGINE, queryNatively } from './native-query.ts'
export type { SessiongraphStoreEngine } from './native-query.ts'
export { toEntry, toHitSubject, toRawEvent, toRawEventSummary, toSessionSummary, toWorkspaceStat } from './rows.ts'
export type { IndexRow } from './rows.ts'
export { event, search, session, status, timeline, trace, workspaces } from './queries.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'sessiongraph-sqlite'

/** Services required by this plugin. */
export const inject = ['sessiongraph']

/** Branded identity this store reserves on the seam. */
export const DEFAULT_STORE_ID = 'sessiongraph-sqlite'

/** Default number of index databases kept open at once. */
export const DEFAULT_MAX_OPEN_DATABASES = 4

/** Default ceiling on one rendered search snippet, in characters. */
export const DEFAULT_MAX_SNIPPET_CHARS = 240

/**
 * Default index root, the one `dsh-plugin-sessiongraph-sessions` builds into. Used only when a
 * request's `indexRoot` is empty — an explicit root always wins, so a deployment that moved the
 * index is served from where it actually is.
 */
export const DEFAULT_INDEX_ROOT = join(homedir(), '.dsh', 'sessiongraph')

/** Plugin configuration: the bounds the seam's requests cannot express. */
export interface Config {
  /**
   * Largest number of index databases held open at once (default 4). The least recently queried
   * connection closes when the limit is exceeded; a root queried again simply reopens.
   */
  maxOpenDatabases?: number
  /**
   * Largest excerpt rendered per search hit (default 240), in characters. Brackets marking matched
   * terms are added after this bound, so they never shorten the visible text.
   */
  maxSnippetChars?: number
  /**
   * Index root used when a request leaves `indexRoot` empty (default `~/.dsh/sessiongraph`). Kept
   * configurable so a profile can move the index without rebuilding the plugin.
   */
  defaultIndexRoot?: string
  /**
   * Which engine answers index-backed queries (default `auto`). `auto` prefers the native Rust
   * kernel and silently falls back to the TypeScript queries when this machine has no usable build;
   * `native` asks for the kernel explicitly, so an unavailable build is reported once before the same
   * fallback; `typescript` never probes the kernel at all. `status` is always answered locally.
   */
  engine?: SessiongraphStoreEngine
}

export const Config: z<Config> = z.object({
  maxOpenDatabases: z.number().default(DEFAULT_MAX_OPEN_DATABASES),
  maxSnippetChars: z.number().default(DEFAULT_MAX_SNIPPET_CHARS),
  defaultIndexRoot: z.string().default(DEFAULT_INDEX_ROOT),
  engine: z.union([z.const('auto'), z.const('native'), z.const('typescript')]).default(DEFAULT_ENGINE),
})

type ResolvedConfig = Required<Config>

/**
 * Register the SQLite session-graph store.
 * @param ctx - the plugin context (must inject `sessiongraph`).
 * @param config - the resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveInteger('maxOpenDatabases', resolved.maxOpenDatabases)
  assertPositiveInteger('maxSnippetChars', resolved.maxSnippetChars)
  if (resolved.defaultIndexRoot.trim() === '') {
    throw new Error('sessiongraph-sqlite: defaultIndexRoot must be a non-empty path')
  }

  const pool = new IndexPool(resolved.maxOpenDatabases)
  // `ctx.sessiongraph` is reached through `ctx.get` because the seam package does not (yet) augment
  // `Context` with it; `inject` guarantees the service is present before `apply` runs.
  const seam = ctx.get('sessiongraph') as SessiongraphService
  const store: SessiongraphStoreProvider = {
    id: SessiongraphStoreId(DEFAULT_STORE_ID),
    async indexes(indexRoot, signal) {
      signal?.throwIfAborted()
      return indexExists(resolveIndexRoot(resolved, indexRoot))
    },
    query<R extends SessiongraphRequest>(request: R, signal?: AbortSignal): Promise<SessiongraphResultFor<R>> {
      signal?.throwIfAborted()
      return run(pool, resolved, request)
    },
  }

  ctx.effect(function* () {
    // Registered first, so it disposes LAST: the store unregisters before its connections close,
    // and no query can be routed to a pool that is already shut.
    yield () => {
      pool.close()
    }
    yield seam.registerStore(store)
  }, 'sessiongraph-sqlite')
}

/**
 * The root a request targets: its own `indexRoot`, or the configured default when it left that empty.
 * @param config - the resolved plugin configuration.
 * @param indexRoot - the request's root.
 * @returns the root to stat and open.
 */
function resolveIndexRoot(config: ResolvedConfig, indexRoot: string): string {
  return indexRoot.trim() === '' ? config.defaultIndexRoot : indexRoot
}

/**
 * Answer one request from the pooled connection for its index root.
 * @param pool - the store's connection pool.
 * @param config - the resolved plugin configuration.
 * @param request - the normalized seam request.
 * @returns the result member matching `request.operation`.
 */
async function run<R extends SessiongraphRequest>(
  pool: IndexPool,
  config: ResolvedConfig,
  request: R,
): Promise<SessiongraphResultFor<R>> {
  const indexRoot = resolveIndexRoot(config, request.indexRoot)
  // `status` is the one operation that answers without an index, so it must not acquire a
  // connection up front. `ctx.sessiongraph` routes only to a store that claimed the root, but a
  // direct caller (a test, a future consumer) may still ask `status` about a root that has none.
  if (request.operation === 'status') {
    return status(pool, indexRoot) as SessiongraphResultFor<R>
  }
  // The kernel is asked first and owns its own error handling: every native failure (no build, an
  // older build, a throwing call) resolves to `undefined` here, which is this store's signal to
  // answer from SQLite instead. `indexRoot` is already resolved, so both engines see the same file.
  const native = await queryNatively(config.engine, request, indexRoot, config.maxSnippetChars)
  if (native !== undefined) return native as SessiongraphResultFor<R>
  const db = pool.acquire(indexRoot)
  switch (request.operation) {
    case 'search':
      return search(db, request, config.maxSnippetChars) as SessiongraphResultFor<R>
    case 'session':
      return session(db, request) as SessiongraphResultFor<R>
    case 'event':
      return event(db, request) as SessiongraphResultFor<R>
    case 'trace':
      return trace(db, request) as SessiongraphResultFor<R>
    case 'timeline':
      return timeline(db, request) as SessiongraphResultFor<R>
    case 'workspaces':
      return workspaces(db, request) as SessiongraphResultFor<R>
    /* v8 ignore next -- exhaustive over the seam's closed operation union; unreachable. */
    default:
      return assertNever(request)
  }
}

/** Reject a non-positive-integer config value at load, so misconfiguration fails loud. */
function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`sessiongraph-sqlite: ${field} must be a positive integer`)
  }
}
