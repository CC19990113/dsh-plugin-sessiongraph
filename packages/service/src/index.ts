/**
 * Service Definition for the session-graph capability seam (`ctx.sessiongraph`): a store-provider
 * and indexer-provider registry over local conversation history, plus the normalized query
 * vocabulary — `search`, `session`, `timeline`, `workspaces`, and `status`.
 *
 * A store reserves a branded id at registration and declares which index roots it can serve through
 * {@link SessiongraphStoreProvider.indexes}. Selection asks every registered store per query and
 * requires exactly one claimant, so registration and hot-reload order never change routing; zero
 * claimants and several claimants are both loud failures rather than a silent pick. The seam carries
 * no session text and performs no filesystem access of its own.
 *
 * Unlike the code-graph seam, `status` is answerable without an index: a caller that has never
 * indexed anything needs to learn that fact, and every other operation throws
 * `SESSIONGRAPH_UNAVAILABLE` instead of pretending the store is empty.
 * @module dsh-plugin-sessiongraph-service
 */

import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SessiongraphIndexerId, SessiongraphStoreId } from './brand.ts'
import { INDEX_RELATIVE_PATH } from './schema.ts'
import { SessiongraphError } from './types.ts'
import type {
  SessiongraphIndexer,
  SessiongraphIndexOptions,
  SessiongraphIndexReport,
  SessiongraphRequest,
  SessiongraphResultFor,
  SessiongraphService,
  SessiongraphStatusResult,
  SessiongraphStoreProvider,
} from './types.ts'

export { assertNever } from './assert.ts'
export { SessiongraphIndexerId, SessiongraphSessionId, SessiongraphStoreId } from './brand.ts'
export {
  ENTRY_FTS_TABLE,
  ENTRY_TABLE,
  INDEX_RELATIVE_PATH,
  META_DISCOVERED,
  META_FAILED,
  META_INDEXED_AT,
  META_SCHEMA_VERSION,
  SCHEMA_STATEMENTS,
  SCHEMA_VERSION,
  SESSION_TABLE,
} from './schema.ts'
export { PANEL_CODEX_SYNC_KEY, PANEL_FILE_NAME } from './panel.ts'
export { highlightTerms, isCjk, matchExpression, tokenize } from './tokenize.ts'
export { SessiongraphError } from './types.ts'
export type {
  SessiongraphEntry,
  SessiongraphEntryKind,
  SessiongraphErrorCode,
  SessiongraphEventRequest,
  SessiongraphEventResult,
  SessiongraphEventTraceResult,
  SessiongraphHit,
  SessiongraphIndexer,
  SessiongraphIndexOptions,
  SessiongraphIndexReport,
  SessiongraphOperation,
  SessiongraphRawEvent,
  SessiongraphRawEventSummary,
  SessiongraphRequest,
  SessiongraphRequestBase,
  SessiongraphResult,
  SessiongraphResultFor,
  SessiongraphSearchRequest,
  SessiongraphSearchResult,
  SessiongraphService,
  SessiongraphSessionRequest,
  SessiongraphSessionResult,
  SessiongraphSessionSummary,
  SessiongraphSessionTraceResult,
  SessiongraphSource,
  SessiongraphStatusRequest,
  SessiongraphStatusResult,
  SessiongraphStoreProvider,
  SessiongraphTimelineRequest,
  SessiongraphTimelineResult,
  SessiongraphTraceNode,
  SessiongraphTraceRequest,
  SessiongraphTraceResult,
  SessiongraphWorkspaceStat,
  SessiongraphWorkspacesRequest,
  SessiongraphWorkspacesResult,
} from './types.ts'
export { SESSIONGRAPH_ENTRY_KINDS, SESSIONGRAPH_OPERATIONS, SESSIONGRAPH_SOURCES } from './types.ts'

/**
 * `ctx.sessiongraph`. Holds the store and indexer reservations; selection reads them per call so a
 * provider that unloads mid-session stops serving without leaving a stale route behind.
 */
export class Sessiongraph extends Service implements SessiongraphService {
  private readonly stores = new Map<SessiongraphStoreId, SessiongraphStoreProvider>()
  private readonly indexers = new Map<SessiongraphIndexerId, SessiongraphIndexer>()

  constructor(ctx: Context) {
    super(ctx, 'sessiongraph')
  }

  registerStore(provider: SessiongraphStoreProvider): () => void {
    const id = provider.id
    if (id.trim() === '') {
      throw new SessiongraphError('a session-graph store id must be a non-empty string', 'SESSIONGRAPH_INVALID_PROVIDER')
    }
    if (this.stores.has(id)) {
      throw new SessiongraphError(`a session-graph store with id "${id}" is already registered`, 'SESSIONGRAPH_CONFLICT')
    }

    const dispose = this.ctx.effect(
      function* (this: Sessiongraph) {
        this.stores.set(id, provider)
        yield () => {
          this.stores.delete(id)
        }
      }.bind(this),
      'sessiongraph.registerStore()',
    )
    return () => void dispose()
  }

  registerIndexer(provider: SessiongraphIndexer): () => void {
    const id = provider.id
    if (id.trim() === '') {
      throw new SessiongraphError(
        'a session-graph indexer id must be a non-empty string',
        'SESSIONGRAPH_INVALID_PROVIDER',
      )
    }
    if (this.indexers.has(id)) {
      throw new SessiongraphError(
        `a session-graph indexer with id "${id}" is already registered`,
        'SESSIONGRAPH_CONFLICT',
      )
    }

    const dispose = this.ctx.effect(
      function* (this: Sessiongraph) {
        this.indexers.set(id, provider)
        yield () => {
          this.indexers.delete(id)
        }
      }.bind(this),
      'sessiongraph.registerIndexer()',
    )
    return () => void dispose()
  }

  async available(indexRoot: string, signal?: AbortSignal): Promise<boolean> {
    if (this.stores.size === 0) return false
    const candidates = [...this.stores.values()]
    const claims = await Promise.all(candidates.map(store => store.indexes(indexRoot, signal)))
    return claims.some(Boolean)
  }

  async query<R extends SessiongraphRequest>(request: R, signal?: AbortSignal): Promise<SessiongraphResultFor<R>> {
    // `status` is the one operation answerable with nothing indexed: a caller whose root has no
    // store claim needs to learn *that fact*, not receive the same unavailable error every other
    // operation raises. A conflict is still a real error — two stores claiming one root is a
    // deployment mistake, and silently reporting "not indexed" would hide it.
    let store: SessiongraphStoreProvider | undefined
    try {
      store = await this.select(request.indexRoot, signal)
    } catch (error) {
      if (request.operation === 'status' && error instanceof SessiongraphError && error.code === 'SESSIONGRAPH_UNAVAILABLE') {
        return emptyStatus(request.indexRoot) as SessiongraphResultFor<R>
      }
      throw error
    }
    return store.query(request, signal)
  }

  async index(
    indexRoot: string,
    options: SessiongraphIndexOptions = {},
    signal?: AbortSignal,
  ): Promise<SessiongraphIndexReport> {
    const indexer = await this.selectIndexer(indexRoot, signal)
    return indexer.index(indexRoot, options, signal)
  }

  /**
   * The one store that serves `indexRoot`. Every registered store is asked concurrently, so the
   * answer does not depend on registration order; zero and several claimants both throw.
   * @param indexRoot - directory the request targets.
   * @param signal - aborts the availability checks.
   * @returns the single claiming store.
   */
  private async select(indexRoot: string, signal?: AbortSignal): Promise<SessiongraphStoreProvider> {
    const candidates = [...this.stores.values()]
    if (candidates.length === 0) {
      throw new SessiongraphError('no session-graph store is registered', 'SESSIONGRAPH_UNAVAILABLE')
    }
    const claims = await Promise.all(candidates.map(store => store.indexes(indexRoot, signal)))
    const claimants = candidates.filter((_, index) => claims[index])
    const [only, rival] = claimants
    if (only === undefined) {
      throw new SessiongraphError(`no session-graph store indexes "${indexRoot}"`, 'SESSIONGRAPH_UNAVAILABLE')
    }
    if (rival !== undefined) {
      const ids = claimants.map(store => store.id).join(', ')
      throw new SessiongraphError(`several session-graph stores index "${indexRoot}": ${ids}`, 'SESSIONGRAPH_CONFLICT')
    }
    return only
  }

  /**
   * The one indexer that can build `indexRoot`. Same one-claimant rule as {@link Sessiongraph.select}.
   * @param indexRoot - directory to build into.
   * @param signal - aborts the availability checks.
   * @returns the single claiming indexer.
   */
  private async selectIndexer(indexRoot: string, signal?: AbortSignal): Promise<SessiongraphIndexer> {
    const candidates = [...this.indexers.values()]
    if (candidates.length === 0) {
      throw new SessiongraphError('no session-graph indexer is registered', 'SESSIONGRAPH_UNAVAILABLE')
    }
    const claims = await Promise.all(candidates.map(indexer => indexer.canIndex(indexRoot, signal)))
    const claimants = candidates.filter((_, index) => claims[index])
    const [only, rival] = claimants
    if (only === undefined) {
      throw new SessiongraphError(`no session-graph indexer can index "${indexRoot}"`, 'SESSIONGRAPH_UNAVAILABLE')
    }
    if (rival !== undefined) {
      const ids = claimants.map(indexer => indexer.id).join(', ')
      throw new SessiongraphError(
        `several session-graph indexers can index "${indexRoot}": ${ids}`,
        'SESSIONGRAPH_CONFLICT',
      )
    }
    return only
  }
}

export default Sessiongraph

/** Cordis plugin name for loader diagnostics. */
export const name = 'sessiongraph'

/**
 * Publish the seam. Registers nothing else: providers arrive from their own plugins, which is what
 * lets a deployment swap the store or the indexer without touching the model-facing tool.
 * @param ctx - Cordis context to install into.
 */
export function apply(ctx: Context): void {
  ctx.plugin(Sessiongraph)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The session-graph seam. Present whenever this package's plugin is loaded. */
    sessiongraph: SessiongraphService
  }
}

/**
 * The zero-value status a root with no store claim reports: the index has never been built.
 * @param indexRoot - directory the caller asked about.
 * @returns a status result shaped exactly like a store's own, with nothing indexed.
 */
function emptyStatus(indexRoot: string): SessiongraphStatusResult {
  return {
    operation: 'status',
    indexed: false,
    indexPath: join(indexRoot, INDEX_RELATIVE_PATH),
    sessions: 0,
    entries: 0,
    workspaces: 0,
    indexedAt: undefined,
    bytes: 0,
  }
}
