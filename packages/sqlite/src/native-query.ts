/**
 * Optional native query engine for the store.
 *
 * The Rust kernel under `crates/sessiongraph-core` answers the same six index-backed operations, and
 * is faster on a large index. It is optional at every level: a machine without a built binary, a
 * kernel that predates the query export, and a call that throws all mean "answer this request with
 * the TypeScript queries instead". That is the same policy the sessions indexer applies to its own
 * native path, so one word (`engine`) configures both.
 *
 * The native boundary is structural rather than imported: the store declares the request/response
 * shape it needs (`QueryRequest` → `QueryResponse`, payload as a JSON string) and narrows whatever the
 * module returns before trusting it. That keeps a native build's ABI drift from becoming a provider
 * load failure, and means the store still typechecks and works when the kernel has not been built.
 * @module dsh-plugin-sessiongraph-sqlite/native-query
 */

import { loadNative } from 'dsh-plugin-sessiongraph-native'
import type { SessiongraphRequest, SessiongraphResult } from 'dsh-plugin-sessiongraph-service'

/** Which engine answers index-backed queries. */
export type SessiongraphStoreEngine = 'auto' | 'native' | 'typescript'

/** Default engine selection: native when this machine has it, TypeScript otherwise. */
export const DEFAULT_ENGINE: SessiongraphStoreEngine = 'auto'

/** The native query entry point, as this store expects it (napi camelCases Rust snake_case). */
interface NativeQueryKernel {
  query(request: Record<string, unknown>): Promise<unknown> | unknown
}

/** `undefined` until the first probe, then the usable kernel or `null` when this machine has none. */
let kernelCache: NativeQueryKernel | null | undefined

/** Whether a native failure has already been reported, so a broken build logs once, not per query. */
let failureReported = false

/**
 * Probe the loaded native module for a query entry point.
 *
 * `loadNative` promises never to throw; this wrapper keeps that promise part of the boundary, because
 * a loader bug must degrade to TypeScript rather than fail every query.
 * @returns the kernel, or undefined when this machine cannot answer natively.
 */
function queryKernel(): NativeQueryKernel | undefined {
  if (kernelCache !== undefined) return kernelCache ?? undefined
  kernelCache = null
  try {
    const kernel = loadNative() as unknown as Partial<NativeQueryKernel> | undefined
    if (typeof kernel?.query === 'function') {
      const usable: NativeQueryKernel = { query: request => kernel.query!(request) }
      kernelCache = usable
      return usable
    }
  } catch {
    // `loadNative` promises never to throw, so reaching this means the loader itself is broken. That
    // is a real engine fault — unlike "not built" — and is worth one diagnostic line.
    reportOnce('the native query module failed to load; falling back to the TypeScript store')
  }
  return undefined
}

/**
 * Answer one request through the native kernel.
 * @param engine - the configured engine, which decides whether a missing kernel is worth reporting.
 * @param request - the seam request.
 * @param indexRoot - the root the request targets.
 * @param maxSnippetChars - largest excerpt per hit; passed through so the native and TypeScript
 *   paths cannot render different lengths for the same configured value.
 * @returns the native answer, or `undefined` when the TypeScript path must answer instead.
 */
export async function queryNatively(
  engine: SessiongraphStoreEngine,
  request: SessiongraphRequest,
  indexRoot: string,
  maxSnippetChars: number,
): Promise<SessiongraphResult | undefined> {
  if (engine === 'typescript') return undefined
  // `touched` has only a TypeScript implementation: it parses every `tool` entry of one session and
  // the kernel has no answer for it yet. Handing it to the TypeScript path is not a degradation —
  // it is the only implementation — so this must not print "native unavailable", which would report
  // a missing build where there is nothing to build.
  if (request.operation === 'touched') return undefined
  const kernel = queryKernel()
  if (kernel === undefined) {
    // `auto` treats "no kernel" as the normal case on a machine without a build; asking for `native`
    // explicitly still falls back, but says once why the answer is not the one requested.
    if (engine === 'native') {
      reportOnce('the native query engine is unavailable on this machine; falling back to the TypeScript store')
    }
    return undefined
  }
  try {
    return decodeResponse(await kernel.query(nativeRequest(request, indexRoot, maxSnippetChars)), request.operation)
  } catch (error) {
    // A request the kernel rejected (an unknown session, an ambiguous prefix, a malformed filter) is
    // the caller's business, not an engine fault: the TypeScript store answers it and raises the same
    // typed error, so logging "native query failed" here would blame the wrong layer. Only a broken
    // kernel — an unexpected throw, a malformed envelope, an answer for another operation — is
    // reported, and `reportOnce` keeps a systematically broken build from crying wolf per query.
    if (isBusinessError(error)) return undefined
    reportOnce(`native query failed, falling back to the TypeScript store: ${describeError(error)}`)
    return undefined
  }
}

/**
 * Whether a native failure is the seam's own typed refusal rather than an engine fault.
 *
 * The kernel reports every failure as `ok: false` with a `SESSIONGRAPH_*` code; only the two codes a
 * caller can cause by asking for something that does not exist or does not make sense fall through
 * silently. `SESSIONGRAPH_CORRUPT`, `SESSIONGRAPH_IO`, and anything not from the kernel stay loud.
 * @param error - whatever the kernel or decoder raised.
 * @returns true when the TypeScript store should answer without logging.
 */
function isBusinessError(error: unknown): boolean {
  return (
    error instanceof NativeQueryError
    && (error.code === 'SESSIONGRAPH_NOT_FOUND' || error.code === 'SESSIONGRAPH_INVALID_REQUEST')
  )
}

/** A native answer the store refuses to trust, carrying the kernel's own `SESSIONGRAPH_*` code. */
class NativeQueryError extends Error {
  readonly code: string | undefined

  /**
   * @param message - the kernel's failure message.
   * @param code - the kernel's `SESSIONGRAPH_*` code, when it sent one.
   */
  constructor(message: string, code: string | undefined) {
    super(message)
    this.name = 'NativeQueryError'
    this.code = code
  }
}

/**
 * Translate one seam request into the kernel's flat request record.
 *
 * Field names are snake_case because the Rust side declares them so; absent optional fields are
 * omitted rather than sent as `null`, so the kernel's own "not filtered" default applies.
 * @param request - the seam request.
 * @param indexRoot - the resolved index root.
 * @param maxSnippetChars - excerpt cap the store is configured with, so both engines agree.
 * @returns the kernel request.
 */
function nativeRequest(
  request: SessiongraphRequest,
  indexRoot: string,
  maxSnippetChars: number,
): Record<string, unknown> {
  const base: Record<string, unknown> = { index_root: indexRoot, operation: request.operation }
  switch (request.operation) {
    case 'search':
      return {
        ...base,
        query: request.query,
        ...(request.sessionId === undefined ? {} : { session_id: request.sessionId }),
        ...(request.workspace === undefined ? {} : { workspace: request.workspace }),
        ...(request.after === undefined ? {} : { since: request.after }),
        ...(request.before === undefined ? {} : { until: request.before }),
        ...(request.kinds === undefined ? {} : { kinds: [...request.kinds] }),
        dedupe_by_session: request.dedupeBySession !== false,
        max_snippet_chars: maxSnippetChars,
        limit: request.limit,
        offset: request.offset ?? 0,
      }
    case 'session':
      return {
        ...base,
        session_id: request.sessionId,
        limit: request.limit,
        offset: request.offset ?? 0,
      }
    case 'event':
      return {
        ...base,
        session_id: request.sessionId,
        seq: request.seq,
        window_before: request.windowBefore ?? 0,
        window_after: request.windowAfter ?? 0,
      }
    case 'trace':
      return {
        ...base,
        session_id: request.sessionId,
        ...(request.seq === undefined ? {} : { seq: request.seq }),
        ...(request.depth === undefined ? {} : { depth: request.depth }),
      }
    case 'timeline':
      return {
        ...base,
        ...(request.workspace === undefined ? {} : { workspace: request.workspace }),
        ...(request.after === undefined ? {} : { since: request.after }),
        ...(request.before === undefined ? {} : { until: request.before }),
        limit: request.limit,
        offset: request.offset ?? 0,
      }
    case 'workspaces':
      return { ...base, limit: request.limit, offset: request.offset ?? 0 }
    case 'touched':
      // Unreachable: `queryNatively` returns before this point for `touched`. The case exists so the
      // switch stays exhaustive over the seam's operation union, where a missing arm is a type error.
      return base
    case 'status':
      // `status` is answered from the file itself, before any engine is consulted.
      return base
  }
}

/**
 * Narrow the kernel's response to a seam result.
 *
 * The payload crosses the boundary as a JSON string because a raw event can be tens of kilobytes and
 * a per-field napi conversion costs more than one `JSON.parse`. Anything that does not look like this
 * store's response is an error, which the caller turns into a TypeScript fallback.
 * @param raw - whatever the kernel returned.
 * @param operation - the operation the request asked for, checked against the payload.
 * @returns the decoded seam result.
 */
function decodeResponse(raw: unknown, operation: string): SessiongraphResult {
  if (typeof raw !== 'object' || raw === null) throw new Error('native query returned no response object')
  const response = raw as Record<string, unknown>
  if (response['ok'] !== true) {
    const message = response['error_message'] ?? response['errorMessage'] ?? 'native query failed'
    const code = response['error_code'] ?? response['errorCode']
    // The code rides along so the caller can tell a typed refusal (not found, bad request) from a
    // kernel fault without parsing the message.
    throw new NativeQueryError(String(message), typeof code === 'string' ? code : undefined)
  }
  const payload = response['payload_json'] ?? response['payloadJson']
  if (typeof payload !== 'string') throw new Error('native query response carries no payload')
  const parsed: unknown = JSON.parse(payload)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('native query payload is not an object')
  const result = parsed as Record<string, unknown>
  if (result['operation'] !== operation) {
    throw new Error(`native query answered "${String(result['operation'])}" for a "${operation}" request`)
  }
  return parsed as SessiongraphResult
}

/** Report one native-engine failure, once per process. */
function reportOnce(message: string): void {
  if (failureReported) return
  failureReported = true
  console.error(`sessiongraph-sqlite: ${message}`)
}

/** One diagnostic line from a caught value, without assuming it is an Error. */
function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
