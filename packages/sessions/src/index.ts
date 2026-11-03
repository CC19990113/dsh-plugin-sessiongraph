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
 * Every session creation also refreshes an **existing** index in the background (`agent/created`,
 * `autoIndex`): a machine that already has one stays fresh without the model remembering to ask. A
 * missing index is deliberately left alone — the first build reads every log on the machine and is
 * the caller's explicit decision (`sessiongraph_index`), not something to trigger on a session start.
 * @module dsh-plugin-sessiongraph-sessions
 */

import { existsSync, readFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { INDEX_RELATIVE_PATH, SessiongraphIndexerId } from 'dsh-plugin-sessiongraph-service'
import type {
  SessiongraphIndexer,
  SessiongraphIndexOptions,
  SessiongraphIndexReport,
} from 'dsh-plugin-sessiongraph-service'
import { parseSessionLog } from './parse.ts'
import type { ParsedSession } from './parse.ts'
import { scanSessions } from './scan.ts'
import { readIndexState, STATUS_RELATIVE_PATH, writeIndex } from './write.ts'
import type { IndexedSession } from './write.ts'

export { decompressSessionLog, parseSessionLog } from './parse.ts'
export type { ParsedEntry, ParsedSession, SessionParseLimits } from './parse.ts'
export { scanSessions } from './scan.ts'
export type { SessionFile } from './scan.ts'
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

/** Stable job kind of an automatic session-start refresh, used for retention and diagnostics. */
export const AUTO_INDEX_JOB_KIND = 'sessiongraph-index'

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
   * Refresh an existing index in the background whenever a session is created (default true). A
   * machine with no index yet is skipped on purpose — see {@link DEFAULT_INDEX_ROOT}.
   */
  autoIndex?: boolean
}

export const Config: z<Config> = z.object({
  sessionsRoot: z.string().default(DEFAULT_SESSIONS_ROOT),
  indexRoot: z.string().default(DEFAULT_INDEX_ROOT),
  maxEntryChars: z.number().default(DEFAULT_MAX_ENTRY_CHARS),
  toolCallChars: z.number().default(DEFAULT_TOOL_CALL_CHARS),
  maxFileBytes: z.number().default(DEFAULT_MAX_FILE_BYTES),
  autoIndex: z.boolean().default(true),
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
  if (resolved.indexRoot.trim() === '') {
    throw new Error('sessiongraph-sessions: indexRoot must be a non-empty directory path')
  }

  const indexer = createIndexer(resolved)
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
 * @param config - the resolved plugin configuration.
 * @returns the seam provider.
 */
export function createIndexer(config: ResolvedConfig): SessiongraphIndexer {
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
      return runIndex(indexRoot, options, signal, config)
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
    // Only an index that already exists is refreshed: the first build reads every log on the
    // machine, and that is the caller's explicit decision, not something a session start triggers.
    if (!hasExistingIndex(indexRoot)) return
    // `ctx.get` rather than an `inject` entry: background jobs are a host composition choice, and
    // requiring the service would hide this whole indexer from a profile that runs none.
    const jobs = ctx.get('jobs') as AutoIndexJobRegistry | undefined
    if (jobs === undefined) return
    jobs.start({
      // The registry keys a job by its owning session id, not the agent object.
      owner: agent.id,
      kind: AUTO_INDEX_JOB_KIND,
      label: `sessiongraph refresh for ${workspace}`,
      run: handle => runAutoIndexJob(indexRoot, config, handle),
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
 * The producer body of one automatic refresh job.
 *
 * Both halves of the host's job contract are mandatory: `cancel` aborts the run, and `done` settles
 * even on failure — a rejected `done` breaks the registry's bookkeeping and leaves the job looking
 * stuck forever.
 * @param indexRoot - the index to refresh.
 * @param config - the resolved plugin configuration.
 * @param handle - the job's producer face, for the job's live log.
 * @returns the job's cancellation hook and settlement promise.
 */
function runAutoIndexJob(indexRoot: string, config: ResolvedConfig, handle: AutoIndexJobHandle): AutoIndexJobHooks {
  const controller = new AbortController()
  const done = (async (): Promise<AutoIndexJobOutcome> => {
    try {
      // No `force`: an unchanged log is skipped, which is what makes a session-start refresh cheap.
      const report = await runIndex(indexRoot, {}, controller.signal, config)
      handle.append(
        `Refreshed ${indexRoot}: ${report.sessions} sessions, ${report.entries} entries ` +
        `(${report.added} added, ${report.updated} updated, ${report.removed} removed).\n`,
      )
      return { status: 'completed' }
    } catch (error) {
      const message = describeError(error)
      handle.append(`sessiongraph refresh failed for ${indexRoot}: ${message}\n`)
      return { status: 'failed', detail: message }
    }
  })()
  return { cancel: () => controller.abort(), done }
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
  if (!existsSync(join(indexRoot, INDEX_RELATIVE_PATH))) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(indexRoot, STATUS_RELATIVE_PATH), 'utf8'))
  } catch {
    return false
  }
  if (typeof parsed !== 'object' || parsed === null) return false
  const record = parsed as Record<string, unknown>
  return typeof record['indexedAt'] === 'number' && typeof record['sessions'] === 'number'
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
 * Build or refresh one index.
 * @param indexRoot - directory to write `index.db` into.
 * @param options - scope and rebuild switches.
 * @param signal - aborts between sessions.
 * @param config - the resolved plugin configuration.
 * @returns what the run did.
 */
export async function runIndex(
  indexRoot: string,
  options: SessiongraphIndexOptions,
  signal: AbortSignal | undefined,
  config: ResolvedConfig,
): Promise<SessiongraphIndexReport> {
  const startedAt = Date.now()
  const indexPath = join(indexRoot, INDEX_RELATIVE_PATH)
  const files = await scanSessions(config.sessionsRoot)
  signal?.throwIfAborted()

  const previous = readIndexState(indexPath)
  // A missing or unusable previous index is rebuilt through the temporary file too, so a corrupt or
  // schema-mismatched file is replaced atomically instead of being written into.
  const force = options.force === true || previous === undefined
  const workspaceFilter = options.workspace
  const sessionFilter = options.sessionId
  const scoped = workspaceFilter !== undefined || sessionFilter !== undefined
  const inScope = (workspace: string, id: string): boolean =>
    matchesWorkspace(workspaceFilter, workspace) && matchesSession(sessionFilter, id)

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
    candidates.push({ session, file })
    if (existing === undefined) added += 1
    else updated += 1
  }

  // A scoped run only removes what it can see: rows outside the requested workspace or session are
  // kept, because "not in this scan" says nothing about a source the caller excluded on purpose.
  const removed: string[] = []
  for (const [sourcePath, row] of previous ?? []) {
    if (seen.has(sourcePath)) continue
    if (scoped && !inScope(row.workspace, row.id)) continue
    removed.push(row.id)
  }

  signal?.throwIfAborted()
  const indexedAt = Date.now()
  const outcome = writeIndex({
    indexPath,
    force,
    preserveExisting: scoped && previous !== undefined,
    sessions: candidates,
    removed,
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
    discovered: files.length,
    failed,
    entries: outcome.entries,
    sessions: outcome.sessions,
    workspaces: outcome.workspaces,
    bytes: outcome.bytes,
    elapsedMs: Date.now() - startedAt,
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
