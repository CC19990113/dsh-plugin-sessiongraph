/**
 * Session-log indexer for the session-graph seam: turns `~/.dsh/sessions` into the SQLite index
 * `dsh-plugin-sessiongraph-sqlite` reads.
 *
 * Registers **only an indexer**, never a store. Indexing is caller-initiated (`sessiongraph_index`)
 * and never runs from a query: a full machine is hundreds of logs and more than a gigabyte of
 * decompressed JSON, so it has its own timeout budget and the query path stays millisecond-fast.
 *
 * The index root is an opaque directory the caller names; `indexRoot` is where `index.db` lives, and
 * `sessionsRoot` (the harness's own log directory) is a separate, configurable input. That split is
 * what lets a test build a fixture-driven index without a real `~/.dsh`.
 *
 * A run is incremental by default — only logs whose mtime or size moved are re-read — and `force`
 * rebuilds every log into a temporary file that replaces the old index atomically. A single bad log
 * is reported in `failed` and never aborts the run.
 *
 * Every session creation also does indexing work in the background (`agent/created`, `autoIndex`):
 * an existing index is refreshed incrementally, and a missing one is built from scratch (`autoBuild`,
 * default true) so a fresh install becomes searchable without the user running anything. Both runs
 * go through the host's job registry and never block session creation. `autoBuild: false` restores
 * the stricter behaviour where nothing is indexed until the caller asks for it.
 *
 * Sessions the host still holds in memory (`ctx.sessionQuery`) are indexed as well, in a second pass
 * after the file-path transaction commits: a conversation that is still running has no log on disk
 * yet, and "where did I say X" has to include what was just typed. That pass is optional — a host
 * without the service leaves the file-path result exactly as it was, and one that fails degrades to
 * it instead of failing the run.
 *
 * An explicit run is handed to the host's background-job registry too once the store is large enough
 * (`backgroundIndexThreshold`), because a run that grows past a tool's timeout budget must not hold
 * that call open. The seam types `index()` as returning a report, so a delegated run comes back as a
 * report carrying `jobId` — see {@link isBackgroundIndexReport} for the discrimination a consumer
 * needs, and {@link SessiongraphBackgroundIndexReport} for what its other fields then mean.
 * @module dsh-plugin-sessiongraph-sessions
 */

import { existsSync, readFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { loadNative } from 'dsh-plugin-sessiongraph-native'
import type { NativeIndexReport, NativeKernel } from 'dsh-plugin-sessiongraph-native'
import { INDEX_RELATIVE_PATH, SessiongraphIndexerId } from 'dsh-plugin-sessiongraph-service'
import type {
  SessiongraphIndexer,
  SessiongraphIndexOptions,
  SessiongraphIndexReport,
} from 'dsh-plugin-sessiongraph-service'
import { acquireIndexLock } from './lock.ts'
import { collectLiveSessions, LIVE_SOURCE_PREFIX } from './live.ts'
import type { SessionQueryService } from './live.ts'
import { parseSessionLog } from './parse.ts'
import type { ParsedSession } from './parse.ts'
import { scanSessions } from './scan.ts'
import { readIndexState, STATUS_RELATIVE_PATH, writeIndex } from './write.ts'
import type { IndexedSession, IndexWriteResult } from './write.ts'

export { decompressSessionLog, parseSessionLog } from './parse.ts'
export type { ParsedEntry, ParsedSession, SessionParseLimits } from './parse.ts'
export { scanSessions } from './scan.ts'
export type { SessionFile } from './scan.ts'
export { LIVE_SOURCE_PREFIX } from './live.ts'
export type { LiveIndexOptions, LiveIndexResult, SessionQueryService } from './live.ts'
export { readIndexState, STATUS_RELATIVE_PATH, writeIndex } from './write.ts'
export type { ExistingSession, IndexWritePlan, IndexWriteResult, IndexedSession } from './write.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'sessiongraph-sessions'

/** Services required by this plugin. */
export const inject = ['sessiongraph']

/** Default branded identity this indexer reserves on the seam. */
export const DEFAULT_INDEXER_ID = 'sessiongraph-sessions'

/** Default harness session directory. */
export const DEFAULT_SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions')

/**
 * Default index root, matching the tool's own default so a stock profile's automatic refresh writes
 * where its queries read. A deployment that moves one must move the other.
 */
export const DEFAULT_INDEX_ROOT = join(homedir(), '.dsh', 'sessiongraph')

/** Stable job kind of a background index run, used for retention and diagnostics. */
export const AUTO_INDEX_JOB_KIND = 'sessiongraph-index'

/** Default number of session logs at which a manual index run becomes a background job. */
export const DEFAULT_BACKGROUND_INDEX_THRESHOLD = 1_000

/**
 * Default cap on live sessions rebuilt per run. A host normally reports one or two; the cap exists
 * because replaying a live log is not incremental and a host could report many.
 */
export const DEFAULT_MAX_LIVE_SESSIONS = 8

/** Engine selection: prefer the native kernel, only the TypeScript indexer, or decide per machine. */
export type SessiongraphEngineSetting = 'auto' | 'native' | 'typescript'

/** Which engine produced one run's report. */
export type SessiongraphIndexEngine = 'native' | 'typescript'

/** Default engine selection. */
export const DEFAULT_ENGINE: SessiongraphEngineSetting = 'auto'

/** Default cap on stored message text, in characters. */
export const DEFAULT_MAX_ENTRY_CHARS = 4_000

/** Default cap on stored tool-invocation text, in characters. */
export const DEFAULT_TOOL_CALL_CHARS = 2_000

/**
 * Default cap on one compressed log file, in bytes. The largest session on a real machine is ~42MB
 * decompressed from ~13MB compressed, so 64MB leaves room for a long-running session without
 * letting a pathological log exhaust memory in one decompress.
 */
export const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024

/** Plugin configuration. */
export interface Config {
  /** Directory the harness writes its session logs to (default `~/.dsh/sessions`). */
  sessionsRoot?: string
  /**
   * Index root the automatic refresh reads and refreshes (default `~/.dsh/sessiongraph`). Queries
   * route on the root the tool passes, so this must name the same directory as the tool's
   * `indexRoot` or the refresh maintains an index nothing reads.
   */
  indexRoot?: string
  /** Longest message text stored whole; longer text is clipped (default 4000). */
  maxEntryChars?: number
  /** Longest tool invocation (name plus arguments) stored whole (default 2000). */
  toolCallChars?: number
  /** Logs larger than this are skipped and reported in `failed` (default 67108864). */
  maxFileBytes?: number
  /**
   * Do indexing work in the background whenever a session is created (default true). With no index
   * yet this builds the first one; with one already present it refreshes incrementally.
   */
  autoIndex?: boolean
  /**
   * Build the very first index automatically in the background when a session starts (default
   * true). The first build reads every log on the machine and can take seconds to minutes, so it
   * runs as a host background job and never blocks session creation. Set false to require an
   * explicit `sessiongraph_index` / `/sessiongraph index` before anything is searchable.
   */
  autoBuild?: boolean
  /**
   * Treat a write lock older than this many milliseconds as abandoned (default 300000). A crashed
   * run leaves `index.lock` behind; without a staleness window the index would stay unwritable until
   * someone deleted the file by hand.
   */
  indexLockStaleMs?: number
  /**
   * Hand an explicit index run to the host's background-job registry once the session store holds at
   * least this many logs (default 1000). Below it the run is synchronous, because a small index is
   * faster than the round-trip through `job_output`.
   */
  backgroundIndexThreshold?: number
  /**
   * Most live (still-running) sessions to rebuild per run (default 8). They come from the host's
   * `ctx.sessionQuery` and are always rebuilt in full, so the cap bounds the replay cost.
   */
  maxLiveSessions?: number
  /**
   * Which index engine to run (default `auto`): the native Rust kernel when this machine has a
   * loadable build, else the TypeScript indexer. `native` asks for the kernel explicitly and logs
   * once when it cannot be used before falling back; `typescript` never probes the kernel at all.
   */
  engine?: SessiongraphEngineSetting
}

export const Config: z<Config> = z.object({
  sessionsRoot: z.string().default(DEFAULT_SESSIONS_ROOT),
  indexRoot: z.string().default(DEFAULT_INDEX_ROOT),
  maxEntryChars: z.number().default(DEFAULT_MAX_ENTRY_CHARS),
  toolCallChars: z.number().default(DEFAULT_TOOL_CALL_CHARS),
  maxFileBytes: z.number().default(DEFAULT_MAX_FILE_BYTES),
  autoIndex: z.boolean().default(true),
  autoBuild: z.boolean().default(true),
  indexLockStaleMs: z.number().default(300_000),
  backgroundIndexThreshold: z.number().default(DEFAULT_BACKGROUND_INDEX_THRESHOLD),
  maxLiveSessions: z.number().default(DEFAULT_MAX_LIVE_SESSIONS),
  engine: z.union([z.const('auto'), z.const('native'), z.const('typescript')]).default(DEFAULT_ENGINE),
})

/** Configuration after the schema filled in every default. */
export type ResolvedConfig = Required<Config>

/**
 * Register the session-log indexer.
 * @param ctx - the plugin context (must inject `sessiongraph`).
 * @param config - the resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveInteger('maxEntryChars', resolved.maxEntryChars)
  assertPositiveInteger('toolCallChars', resolved.toolCallChars)
  assertPositiveInteger('maxFileBytes', resolved.maxFileBytes)
  assertPositiveInteger('backgroundIndexThreshold', resolved.backgroundIndexThreshold)
  assertPositiveInteger('maxLiveSessions', resolved.maxLiveSessions)
  if (resolved.indexRoot.trim() === '') {
    throw new Error('sessiongraph-sessions: indexRoot must be a non-empty directory path')
  }

  const indexer = createIndexer(ctx, resolved)
  // Process-local, private to this plugin instance: a root is auto-refreshed at most once per
  // process, so a burst of session creations cannot queue a burst of index runs.
  const autoIndexed = new Set<string>()
  // `agent/created` is typed by the host's agent service; this package reads only the two fields it
  // needs through a structural face rather than depending on that package.
  const agentEvents = ctx as unknown as AgentLifecycleContext

  ctx.effect(function* () {
    if (resolved.autoIndex) {
      yield agentEvents.on('agent/created', payload => {
        scheduleAutoIndex(ctx, resolved, autoIndexed, payload)
      })
    }
    yield ctx.sessiongraph.registerIndexer(indexer)
  }, name)
}

/**
 * Build the indexer object this plugin registers.
 * @param ctx - the plugin context; only its optional `jobs` service is consulted.
 * @param config - the resolved plugin configuration.
 * @returns the seam provider.
 */
export function createIndexer(ctx: Context, config: ResolvedConfig): SessiongraphIndexer {
  return {
    id: SessiongraphIndexerId(DEFAULT_INDEXER_ID),
    async canIndex(indexRoot) {
      try {
        return (await stat(indexRoot)).isDirectory()
      } catch (error) {
        // A root that does not exist yet is still ours to create; an unreadable one is not.
        return isMissingPath(error)
      }
    },
    async index(indexRoot, options, signal) {
      const jobId = await startBackgroundIndex(ctx, indexRoot, options, config)
      if (jobId !== undefined) return backgroundIndexReport(indexRoot, jobId)
      return runIndex(indexRoot, options, signal, config, ctx)
    },
  }
}

/**
 * The agent side of an `agent/created` payload. Only what this package reads is named: a session's
 * id (which owns the background job) and the workspace its header records.
 */
interface AgentCreatedPayload {
  /** The agent just registered; absent only on a malformed dispatch. */
  readonly agent?: {
    /** The agent's session id, which owns any background job it starts. */
    readonly id: string
    /** The agent's live session, whose header carries the workspace. */
    readonly session?: {
      /** Durable session metadata, always present on a real session. */
      readonly header?: {
        /** Absolute workspace path, absent when the session was created without one. */
        readonly cwd?: string
      }
    }
  }
}

/** The slice of `ctx`'s event surface this plugin listens on. */
interface AgentLifecycleContext {
  /**
   * Subscribe to one agent-created notification.
   * @param name - the event name, `agent/created`.
   * @param listener - receives the dispatch payload.
   * @returns the disposer that unsubscribes.
   */
  on(name: 'agent/created', listener: (payload: AgentCreatedPayload) => void): () => boolean
}

/**
 * The slice of the host's background-job registry this plugin calls. `@deepseek-ai/dsh-jobs` is
 * deliberately not a dependency — the service is optional, and its absence simply schedules nothing.
 */
interface AutoIndexJobRegistry {
  /**
   * Register a job and return its id immediately.
   * @param spec - the job's owner, kind, label, and producer body.
   * @returns the new job's id.
   */
  start(spec: AutoIndexJobSpec): string
}

/** One automatic refresh job's registration. */
interface AutoIndexJobSpec {
  /** Session id of the agent that owns the job; its disposal cancels the work. */
  readonly owner: string
  /** Stable kind, used for retention and diagnostics. */
  readonly kind: string
  /** Human-readable label shown in job listings and completion notices. */
  readonly label: string
  /** The producer body, invoked once while the registration is being built. */
  readonly run: (handle: AutoIndexJobHandle) => AutoIndexJobHooks
}

/** What an automatic refresh producer may write while its job runs. */
interface AutoIndexJobHandle {
  /**
   * Append one chunk of output to the job's log.
   * @param text - the text to append, verbatim.
   */
  append(text: string): void
}

/** What an automatic refresh producer hands back so the registry can stop and await it. */
interface AutoIndexJobHooks {
  /**
   * Stop the work.
   * @param reason - why the job was stopped, when the caller has a reason.
   */
  cancel(reason?: string): void
  /** Settles once the producer is done, carrying the job's terminal outcome. */
  readonly done: Promise<AutoIndexJobOutcome>
}

/** The terminal report an automatic refresh producer settles with. */
interface AutoIndexJobOutcome {
  /** Terminal status the registry records. */
  readonly status: 'completed' | 'failed'
  /** Failure detail, when the job failed. */
  readonly detail?: string
}

/**
 * The report a backgrounded index run returns. The seam types `index()` as returning a report, which
 * is what a caller awaits; a run that was delegated instead comes back with this extra field, and a
 * consumer distinguishes the two cases through {@link isBackgroundIndexReport}.
 */
export interface SessiongraphBackgroundIndexReport extends SessiongraphIndexReport {
  /** Id of the background job that owns the run. */
  readonly jobId: string
}

/**
 * Whether an index result came from a delegated run rather than a completed one.
 *
 * The seam's return type is the completed report, so a job id can only arrive as an extension of it;
 * every other field of a delegated result describes the index as it stood when the job started.
 * @param report - the value `ctx.sessiongraph.index()` resolved with.
 * @returns true when the run is still going in the host's job registry.
 */
export function isBackgroundIndexReport(report: SessiongraphIndexReport): report is SessiongraphBackgroundIndexReport {
  return typeof (report as Partial<SessiongraphBackgroundIndexReport>).jobId === 'string'
}

/**
 * Refresh an existing index in the background, once per process, when a session is created.
 *
 * Runs synchronously inside `agent/created` dispatch, which happens during agent registration, so it
 * must never block or throw: a synchronous index here would hold up the session's own creation. It
 * only decides whether a refresh is warranted and hands one to the host's job registry.
 * @param ctx - the plugin context, consulted for the optional job registry.
 * @param config - the resolved plugin configuration.
 * @param autoIndexed - index roots this process has already scheduled a refresh for.
 * @param payload - the `agent/created` dispatch payload.
 */
function scheduleAutoIndex(
  ctx: Context,
  config: ResolvedConfig,
  autoIndexed: Set<string>,
  payload: AgentCreatedPayload,
): void {
  try {
    const agent = payload.agent
    const workspace = agent?.session?.header?.cwd
    // A session created without a workspace is not an occasion to touch a machine-wide index.
    if (agent === undefined || workspace === undefined || workspace === '') return
    const indexRoot = expandHome(config.indexRoot)
    // Once per root per process: a burst of session creations must not queue a burst of index runs.
    if (autoIndexed.has(indexRoot)) return
    // A first build reads every log on the machine and can take a while, so it stays a background
    // job like the incremental refresh. `autoBuild: false` restores the stricter behaviour where
    // nothing becomes searchable until someone asks for it.
    const existing = hasExistingIndex(indexRoot)
    if (!existing && !config.autoBuild) return
    // `ctx.get` rather than an `inject` entry: background jobs are a host composition choice, and
    // requiring the service would hide this whole indexer from a profile that runs none.
    const jobs = ctx.get('jobs') as AutoIndexJobRegistry | undefined
    if (jobs === undefined) return
    jobs.start({
      // The registry keys a job by its owning session id, not the agent object.
      owner: agent.id,
      kind: AUTO_INDEX_JOB_KIND,
      label: existing
        ? `sessiongraph refresh for ${workspace}`
        : `sessiongraph first build for ${workspace}`,
      run: handle => runIndexJob(indexRoot, {}, config, handle),
    })
    // Marked only after the registry accepted the job, so a refusal leaves the root eligible for
    // the next session that opens.
    autoIndexed.add(indexRoot)
  } catch (error) {
    // A throwing listener would veto publication of the agent. Losing a refresh is a degradation,
    // never a reason to stop a session from starting; report once and carry on.
    console.error(`sessiongraph-sessions: automatic index after session creation failed: ${describeError(error)}`)
  }
}

/**
 * Hand one explicit index run to the host's background-job registry, when the run is large enough to
 * outlive a tool call.
 *
 * The indexer itself never sees the calling agent — the seam passes it an index root and switches,
 * not an execution context — so the owning session id arrives as a runtime extension of the options
 * object the tool passes through. Without it this returns immediately and the caller runs in place;
 * a composition that predates this contract keeps its old behaviour instead of failing.
 *
 * Every other reason not to start a job (no registry, no controller for the agent, the owner already
 * at its job cap) also falls back to the synchronous run rather than surfacing an error the model
 * cannot act on.
 * @param ctx - the plugin context, consulted for the optional job registry.
 * @param indexRoot - the index to build.
 * @param options - scope and rebuild switches, plus the caller's owning session id when it is known.
 * @param config - the resolved plugin configuration.
 * @returns the started job's id, or `undefined` when this call must index synchronously.
 */
async function startBackgroundIndex(
  ctx: Context,
  indexRoot: string,
  options: SessiongraphIndexOptions,
  config: ResolvedConfig,
): Promise<string | undefined> {
  try {
    const owner = indexJobOwner(options)
    if (owner === undefined) return undefined
    // A scoped run touches one workspace or one session: the round trip through `job_output` would
    // cost more than the run itself.
    if (options.workspace !== undefined || options.sessionId !== undefined) return undefined
    const jobs = ctx.get('jobs') as AutoIndexJobRegistry | undefined
    if (jobs === undefined) return undefined
    // Asked last, so a composition without a registry never pays for the store scan below. The
    // source count is the run's real size; the sidecar only describes what the last run saw.
    if ((await countSessionFiles(config.sessionsRoot)) < config.backgroundIndexThreshold) return undefined
    return jobs.start({
      owner,
      kind: AUTO_INDEX_JOB_KIND,
      label: `sessiongraph index ${indexRoot}`,
      run: handle => runIndexJob(indexRoot, options, config, handle),
    })
  } catch {
    // No controller serves this agent, or the owner already holds its maximum number of jobs: both
    // mean "do the work here instead", never "fail the model's call".
    return undefined
  }
}

/**
 * The report a delegated run resolves with: the index as it stands, plus the job that will replace it.
 *
 * Nothing was written by this call, so every per-run counter is zero; `sessions`, `entries`,
 * `workspaces` and `bytes` are the previous run's totals, read from the sidecar without opening
 * SQLite.
 * @param indexRoot - the index being built.
 * @param jobId - the job that owns the background run.
 * @returns the delegated result.
 */
function backgroundIndexReport(indexRoot: string, jobId: string): SessiongraphBackgroundIndexReport {
  const status = readStatusFile(indexRoot)
  return {
    indexPath: join(indexRoot, INDEX_RELATIVE_PATH),
    added: 0,
    updated: 0,
    skipped: 0,
    removed: 0,
    discovered: status?.sessions ?? 0,
    failed: [],
    entries: status?.entries ?? 0,
    sessions: status?.sessions ?? 0,
    workspaces: status?.workspaces ?? 0,
    bytes: status?.bytes ?? 0,
    elapsedMs: 0,
    jobId,
  }
}

/**
 * The owning session id a caller attached to an index request, when it attached one.
 * @param options - the seam's index options, possibly extended by the consumer.
 * @returns the session id, or undefined when the caller cannot own a job.
 */
function indexJobOwner(options: SessiongraphIndexOptions): string | undefined {
  const owner = (options as SessiongraphIndexOptions & { readonly owner?: unknown }).owner
  return typeof owner === 'string' && owner !== '' ? owner : undefined
}

/**
 * Count the session logs an index run would read.
 * @param sessionsRoot - the harness session store.
 * @returns the number of logs, or zero when the store cannot be listed.
 */
async function countSessionFiles(sessionsRoot: string): Promise<number> {
  try {
    return (await scanSessions(sessionsRoot)).length
  } catch {
    return 0
  }
}

/**
 * The producer body of one background index run.
 *
 * Both halves of the host's job contract are mandatory: `cancel` aborts the run, and `done` settles
 * even on failure — a rejected `done` breaks the registry's bookkeeping and leaves the job looking
 * stuck forever.
 * @param indexRoot - the index to build.
 * @param options - scope and rebuild switches.
 * @param config - the resolved plugin configuration.
 * @param handle - the job's producer face, for the job's live log.
 * @returns the job's cancellation hook and settlement promise.
 */
function runIndexJob(
  indexRoot: string,
  options: SessiongraphIndexOptions,
  config: ResolvedConfig,
  handle: AutoIndexJobHandle,
): AutoIndexJobHooks {
  const controller = new AbortController()
  const done = (async (): Promise<AutoIndexJobOutcome> => {
    try {
      // Deliberately not the caller's signal: a background run outlives the call that started it,
      // so aborting that call must not abort the job. The job's own cancel does.
      const report = await runIndex(indexRoot, options, controller.signal, config)
      handle.append(
        `Indexed ${indexRoot}: ${report.sessions} sessions, ${report.entries} entries ` +
        `(${report.added} added, ${report.updated} updated, ${report.removed} removed).\n`,
      )
      return { status: 'completed' }
    } catch (error) {
      const message = describeError(error)
      handle.append(`sessiongraph index failed for ${indexRoot}: ${message}\n`)
      return { status: 'failed', detail: message }
    }
  })()
  return { cancel: () => controller.abort(), done }
}

/** The facts a status sidecar carries, as this package writes and reads them. */
interface IndexStatusSnapshot {
  readonly indexedAt: number
  readonly sessions: number
  readonly entries: number
  readonly workspaces: number
  readonly bytes: number
}

/**
 * Read the sidecar summary a previous run left beside the index.
 * @param indexRoot - directory to inspect.
 * @returns the snapshot, or undefined when it is absent, unreadable, or not shaped like one.
 */
function readStatusFile(indexRoot: string): IndexStatusSnapshot | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(indexRoot, STATUS_RELATIVE_PATH), 'utf8'))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  const indexedAt = numberField(record, 'indexedAt')
  const sessions = numberField(record, 'sessions')
  const entries = numberField(record, 'entries')
  const workspaces = numberField(record, 'workspaces')
  const bytes = numberField(record, 'bytes')
  if (
    indexedAt === undefined || sessions === undefined || entries === undefined
    || workspaces === undefined || bytes === undefined
  ) return undefined
  return { indexedAt, sessions, entries, workspaces, bytes }
}

/**
 * Read one numeric field of a parsed object.
 * @param record - the parsed object.
 * @param key - field name.
 * @returns the number, or undefined when the field is absent or not finite.
 */
function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Whether `indexRoot` holds an index this plugin wrote, judged without opening SQLite.
 *
 * The sidecar proves a run completed; the database file proves the index it describes is still
 * there. Prompt assembly reads the same sidecar, so this is the one file format both sides agree on.
 * @param indexRoot - directory to inspect.
 * @returns true when an existing index is safe to refresh in place.
 */
function hasExistingIndex(indexRoot: string): boolean {
  return existsSync(join(indexRoot, INDEX_RELATIVE_PATH)) && readStatusFile(indexRoot) !== undefined
}

/**
 * Expand a leading `~` in a configured path.
 * @param path - configured directory, absolute or home-relative.
 * @returns an absolute path.
 */
function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/**
 * The engine a run should try first, or `undefined` when it must use the TypeScript indexer.
 *
 * `loadNative` promises never to throw — an absent or foreign-architecture binary is a normal state —
 * but the boundary stays: a loader bug must degrade to the TypeScript engine instead of taking the
 * whole indexer down on a machine that would otherwise work.
 * @param setting - the configured engine.
 * @returns the kernel, or undefined when this run must use the TypeScript path.
 */
function resolveNativeEngine(setting: SessiongraphEngineSetting): NativeKernel | undefined {
  if (setting === 'typescript') return undefined
  try {
    return loadNative()
  } catch {
    return undefined
  }
}

/**
 * Run one index through the native kernel, then apply the live-session pass on top.
 *
 * The kernel is synchronous and covers the file path only — it has no access to the host's
 * `sessionQuery`, so its report always says zero live sessions. The live pass is therefore shared
 * with the TypeScript path and its numbers overwrite the kernel's.
 * @param native - the loaded kernel.
 * @param indexPath - absolute path of the index file.
 * @param options - scope and rebuild switches.
 * @param config - the resolved plugin configuration.
 * @param inScope - whether a session is in the run's scope.
 * @param ctx - the plugin context, consulted for the optional live-session source.
 * @param signal - aborts before the kernel starts.
 * @param startedAt - epoch milliseconds the run started, for `elapsedMs`.
 * @returns the run's report, or undefined when the kernel failed and the caller should fall back.
 */
async function runNativeEngine(
  native: NativeKernel,
  indexPath: string,
  options: SessiongraphIndexOptions,
  config: ResolvedConfig,
  inScope: (workspace: string, sessionId: string) => boolean,
  ctx: Context | undefined,
  signal: AbortSignal | undefined,
  startedAt: number,
): Promise<SessiongraphIndexReport | undefined> {
  let nativeReport: NativeIndexReport
  try {
    signal?.throwIfAborted()
    nativeReport = native.indexSessions({
      sessionsRoot: config.sessionsRoot,
      indexPath,
      ...(options.force === undefined ? {} : { force: options.force }),
      ...(options.workspace === undefined ? {} : { workspaceFilter: options.workspace }),
      ...(options.sessionId === undefined ? {} : { sessionFilter: options.sessionId }),
      maxEntryChars: config.maxEntryChars,
      toolCallChars: config.toolCallChars,
      maxFileBytes: config.maxFileBytes,
    })
  } catch (error) {
    // A binary built for another ABI, a corrupt previous index the kernel refuses, or a write it
    // could not finish: the TypeScript path below is the fallback, and it starts from whatever the
    // previous index left behind.
    console.error(
      `sessiongraph-sessions: native index failed, falling back to the TypeScript engine: ${describeError(error)}`,
    )
    return undefined
  }

  const live = await runLivePass(ctx, indexPath, config, inScope, {
    discovered: nativeReport.discovered,
    failed: nativeReport.failed.length,
    indexedAt: Date.now(),
  })
  return {
    indexPath: nativeReport.indexPath,
    added: nativeReport.added,
    updated: nativeReport.updated,
    skipped: nativeReport.skipped,
    removed: nativeReport.removed,
    liveSessions: live.liveSessions,
    liveSkipped: live.liveSkipped,
    discovered: nativeReport.discovered,
    failed: nativeReport.failed,
    entries: live.totals?.entries ?? nativeReport.entries,
    sessions: live.totals?.sessions ?? nativeReport.sessions,
    workspaces: live.totals?.workspaces ?? nativeReport.workspaces,
    bytes: live.totals?.bytes ?? nativeReport.bytes,
    elapsedMs: Date.now() - startedAt,
    engine: 'native',
  }
}

/** What the shared live-session pass contributed to a run. */
interface LivePassOutcome {
  /** Live sessions rebuilt this run. */
  readonly liveSessions: number
  /** Live sessions left out by {@link Config.maxLiveSessions}. */
  readonly liveSkipped: number
  /** Final totals when the pass wrote rows; undefined when it wrote nothing. */
  readonly totals: IndexWriteResult | undefined
}

/** A live pass that found nothing, or failed and was skipped. */
const EMPTY_LIVE_PASS: LivePassOutcome = { liveSessions: 0, liveSkipped: 0, totals: undefined }

/**
 * Rebuild the host's live sessions on top of an already-committed file-path index.
 *
 * Runs in its own transaction after the file path has committed, because a replay reads a whole
 * in-memory log and can be slow — the file results must already be durable before it starts, and a
 * failure here must not roll them back. Shared by both engines: the native kernel cannot see live
 * sessions, and the TypeScript path must not grow a second copy of this logic.
 * @param ctx - the plugin context, consulted for the optional `sessionQuery` service.
 * @param indexPath - absolute path of the index file.
 * @param config - the resolved plugin configuration.
 * @param inScope - whether a session is in the run's scope.
 * @param provenance - this run's discovery counts, for the `meta` rows the live write refreshes.
 * @returns the live counts and, when rows were written, the index's new totals.
 */
async function runLivePass(
  ctx: Context | undefined,
  indexPath: string,
  config: ResolvedConfig,
  inScope: (workspace: string, sessionId: string) => boolean,
  provenance: { readonly discovered: number; readonly failed: number; readonly indexedAt: number },
): Promise<LivePassOutcome> {
  const sessionQuery = ctx?.get('sessionQuery') as SessionQueryService | undefined
  // `ctx.get` rather than an `inject` entry: a host without the service keeps the file-path index.
  if (sessionQuery === undefined) return EMPTY_LIVE_PASS
  try {
    const live = await collectLiveSessions(sessionQuery, {
      maxLiveSessions: config.maxLiveSessions,
      limits: { maxEntryChars: config.maxEntryChars, toolCallChars: config.toolCallChars },
      inScope,
    })
    if (live.sessions.length === 0) {
      return { liveSessions: 0, liveSkipped: live.skipped, totals: undefined }
    }
    const totals = writeIndex({
      indexPath,
      force: false,
      preserveExisting: false,
      sessions: live.sessions,
      removed: [],
      discovered: provenance.discovered,
      failed: provenance.failed,
      indexedAt: provenance.indexedAt,
    })
    return { liveSessions: live.sessions.length, liveSkipped: live.skipped, totals }
  } catch (error) {
    // An older kernel, a failed persistence read, or a write conflict: the file-path index is
    // complete and committed, so the run degrades rather than failing.
    console.error(`sessiongraph-sessions: live session indexing skipped: ${describeError(error)}`)
    return EMPTY_LIVE_PASS
  }
}

/**
 * Build or refresh one index.
 * @param indexRoot - directory to write `index.db` into.
 * @param options - scope and rebuild switches.
 * @param signal - aborts between sessions.
 * @param config - the resolved plugin configuration.
 * @param ctx - the plugin context, consulted for the optional live-session source. Omitted by
 *   callers that only exercise the file path, which then behave exactly as an older host would.
 * @returns what the run did.
 */
export async function runIndex(
  indexRoot: string,
  options: SessiongraphIndexOptions,
  signal: AbortSignal | undefined,
  config: ResolvedConfig,
  ctx?: Context,
): Promise<SessiongraphIndexReport> {
  // Serialize every writer of this root — the automatic refresh, the lazy refresh and an explicit
  // `/sessiongraph index` all land here, and two engines opening the same SQLite file is how the
  // index got corrupted before. Waiting for another run to finish is always better than rebuilding.
  const release = await acquireIndexLock(indexRoot, { staleMs: config.indexLockStaleMs })
  try {
    return await runIndexUnlocked(indexRoot, options, signal, config, ctx)
  } finally {
    release()
  }
}

/**
 * The actual run, with the write lock already held.
 * @param indexRoot - directory holding the index.
 * @param options - caller switches.
 * @param signal - aborts the run.
 * @param config - resolved plugin configuration.
 * @param ctx - plugin context, consulted for the optional live-session service.
 * @returns the run's report.
 */
async function runIndexUnlocked(
  indexRoot: string,
  options: SessiongraphIndexOptions,
  signal: AbortSignal | undefined,
  config: ResolvedConfig,
  ctx?: Context,
): Promise<SessiongraphIndexReport> {
  const startedAt = Date.now()
  const indexPath = join(indexRoot, INDEX_RELATIVE_PATH)
  const workspaceFilter = options.workspace
  const sessionFilter = options.sessionId
  const scoped = workspaceFilter !== undefined || sessionFilter !== undefined
  const inScope = (workspace: string, id: string): boolean =>
    matchesWorkspace(workspaceFilter, workspace) && matchesSession(sessionFilter, id)

  // `auto` prefers the kernel and falls back silently; `native` asks for it explicitly, so a machine
  // without a usable build is told why it got TypeScript results instead.
  const native = resolveNativeEngine(config.engine)
  if (native !== undefined) {
    const nativeReport = await runNativeEngine(native, indexPath, options, config, inScope, ctx, signal, startedAt)
    if (nativeReport !== undefined) return nativeReport
  } else if (config.engine === 'native') {
    console.error(
      'sessiongraph-sessions: the native index engine is unavailable on this machine; ' +
      'falling back to the TypeScript engine',
    )
  }

  const files = await scanSessions(config.sessionsRoot)
  signal?.throwIfAborted()

  const previous = readIndexState(indexPath)
  // A missing or unusable previous index is rebuilt through the temporary file too, so a corrupt or
  // schema-mismatched file is replaced atomically instead of being written into.
  const force = options.force === true || previous === undefined

  const failed: { path: string; reason: string }[] = []
  const candidates: IndexedSession[] = []
  const seen = new Set<string>()
  let added = 0
  let updated = 0
  let skipped = 0

  for (const file of files) {
    seen.add(file.filePath)
    const existing = previous?.get(file.filePath)
    const unchanged = existing !== undefined && existing.mtime === file.mtime && existing.size === file.size
    if (unchanged && !force) {
      if (scoped && !inScope(existing.workspace, existing.id)) continue
      skipped += 1
      continue
    }
    if (file.size > config.maxFileBytes) {
      failed.push({
        path: file.filePath,
        reason: `session log is ${file.size} bytes, over maxFileBytes (${config.maxFileBytes})`,
      })
      continue
    }

    signal?.throwIfAborted()
    let session: ParsedSession
    try {
      const buffer = await readFile(file.filePath)
      session = parseSessionLog(buffer, basename(file.sessionDir), {
        maxEntryChars: config.maxEntryChars,
        toolCallChars: config.toolCallChars,
      })
    } catch (error) {
      failed.push({ path: file.filePath, reason: describeError(error) })
      continue
    }

    if (scoped && !inScope(session.cwd, session.id)) continue
    candidates.push({ session, sourcePath: file.filePath, mtime: file.mtime, size: file.size })
    if (existing === undefined) added += 1
    else updated += 1
  }

  // A scoped run only removes what it can see: rows outside the requested workspace or session are
  // kept, because "not in this scan" says nothing about a source the caller excluded on purpose.
  const removed: string[] = []
  for (const [sourcePath, row] of previous ?? []) {
    // Live rows carry a synthetic source path and are rebuilt from the live view every run; a file
    // scan saying nothing about them is not evidence that their session disappeared.
    if (sourcePath.startsWith(LIVE_SOURCE_PREFIX)) continue
    if (seen.has(sourcePath)) continue
    if (scoped && !inScope(row.workspace, row.id)) continue
    removed.push(row.id)
  }

  signal?.throwIfAborted()
  const indexedAt = Date.now()
  const outcome = writeIndex({
    indexPath,
    force,
    preserveExisting: force && scoped && previous !== undefined,
    sessions: candidates,
    removed,
    discovered: files.length,
    failed: failed.length,
    indexedAt,
  })

  const live = await runLivePass(ctx, indexPath, config, inScope, {
    discovered: files.length,
    failed: failed.length,
    indexedAt,
  })

  return {
    indexPath,
    added,
    updated,
    skipped,
    removed: removed.length,
    liveSessions: live.liveSessions,
    liveSkipped: live.liveSkipped,
    discovered: files.length,
    failed,
    entries: live.totals?.entries ?? outcome.entries,
    sessions: live.totals?.sessions ?? outcome.sessions,
    workspaces: live.totals?.workspaces ?? outcome.workspaces,
    bytes: live.totals?.bytes ?? outcome.bytes,
    elapsedMs: Date.now() - startedAt,
    engine: 'typescript',
  }
}

/**
 * Whether a session's workspace matches an optional workspace filter.
 *
 * An exact match always counts. A value without a trailing separator is also a path prefix, which is
 * how one indexed root serves the whole `~/www` subtree; a value with the trailing separator is the
 * exact directory only.
 * @param filter - configured workspace filter, or undefined for "every workspace".
 * @param workspace - the session's working directory.
 * @returns whether the session is in scope.
 */
export function matchesWorkspace(filter: string | undefined, workspace: string): boolean {
  if (filter === undefined) return true
  if (filter.endsWith('/')) return workspace === filter.slice(0, -1)
  return workspace === filter || workspace.startsWith(filter)
}

/**
 * Whether a session id matches an optional id filter (full id or any prefix).
 * @param filter - configured session filter, or undefined for "every session".
 * @param id - the session's id.
 * @returns whether the session is in scope.
 */
export function matchesSession(filter: string | undefined, id: string): boolean {
  if (filter === undefined) return true
  return id === filter || id.startsWith(filter)
}

/**
 * Bound an error to a readable one-line reason for the report.
 * @param error - the caught value.
 * @returns a short message.
 */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length <= 300 ? message : `${message.slice(0, 300)}…`
}

/**
 * Whether a filesystem error means the path does not exist.
 * @param error - the caught value.
 * @returns true for ENOENT.
 */
function isMissingPath(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/** Reject a non-positive-integer config value at load, so misconfiguration fails loud. */
function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`sessiongraph-sessions: ${field} must be a positive integer`)
  }
}
