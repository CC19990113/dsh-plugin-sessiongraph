/**
 * Discover the session logs an index run should read.
 *
 * Two harnesses are scanned, and they lay their logs out differently enough that each gets its own
 * walker. Both answer the same shape, because everything downstream — the incremental change key,
 * the parser dispatch, the source label stored per row — is shared:
 *
 * - **DSH** writes `<sessionsRoot>/<escaped-cwd>/<session-dir>/session.v<N>.jsonl.zstd`, exactly two
 *   directory levels deep. The walk never recurses into unrelated files (a `.DS_Store` sits at the
 *   root of a real `~/.dsh/sessions`) and never reads anything it will not index. Both `v3` and `v4`
 *   logs are indexed: the harness has shipped both, they carry the same event shape, and a machine
 *   that upgraded keeps its older `v3` files. Within one session directory the highest version wins,
 *   so a half-finished v3 → v4 rewrite contributes one session rather than two.
 * - **Codex** writes `rollout-*.jsonl.zst` in two places: `archived_sessions/` (flat, one file per
 *   conversation) and `sessions/<yyyy>/<mm>/<dd>/` (the same file shape, four levels deep). A
 *   conversation can appear in both after being archived, which is why the indexer de-duplicates on
 *   session id rather than on path.
 * @module dsh-plugin-sessiongraph-sessions/scan
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessiongraphSource } from 'dsh-plugin-sessiongraph-service'

/** A session log file the indexer can read. */
export interface SessionFile {
  /** Absolute path of the directory holding the log (the harness session directory). */
  readonly sessionDir: string
  /** Absolute path of the log file itself. */
  readonly filePath: string
  /**
   * The workspace directory name as the harness escaped it; a fallback when the header has no `cwd`.
   * Codex logs carry no such name, so a Codex file reports the constant `codex` here and relies on
   * its `session_meta.cwd` instead.
   */
  readonly workspaceDir: string
  /** Which harness wrote this log. */
  readonly source: SessiongraphSource
  /** Modification time in epoch milliseconds, truncated to a whole millisecond for integer storage. */
  readonly mtime: number
  /** File size in bytes, the other half of the incremental change key. */
  readonly size: number
}

/** `session.v4.jsonl.zstd`, `session.v3.jsonl.zstd`, … — the version is captured for the pick below. */
const SESSION_LOG = /^session\.v(\d+)\.jsonl\.zstd$/

/** `rollout-2026-03-17T18-23-27-019cfb52-….jsonl.zst` — Codex's one-file-per-conversation shape. */
const CODEX_ROLLOUT = /^rollout-.*\.jsonl\.zst$/

/** Directory name reported for a Codex file, which has no escaped-workspace parent. */
const CODEX_WORKSPACE_DIR = 'codex'

/**
 * List every session log under `sessionsRoot`, one entry per session directory.
 * @param sessionsRoot - absolute path of the harness session store.
 * @returns the logs found, ordered by workspace then session directory so runs are reproducible.
 */
export async function scanSessions(sessionsRoot: string): Promise<SessionFile[]> {
  const found: SessionFile[] = []
  let workspaces
  try {
    workspaces = await readdir(sessionsRoot, { withFileTypes: true })
  } catch (error) {
    // A machine that has never run a session has no store yet; that is an empty index, not a failure.
    if (isMissing(error)) return []
    throw error
  }

  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    const workspacePath = join(sessionsRoot, workspace.name)
    const sessions = await listDirectories(workspacePath)
    for (const session of sessions) {
      const sessionDir = join(workspacePath, session)
      const log = await pickLogFile(sessionDir)
      if (log === undefined) continue
      try {
        const stats = await stat(log.path)
        found.push({
          sessionDir,
          filePath: log.path,
          workspaceDir: workspace.name,
          source: 'dsh',
          mtime: Math.trunc(stats.mtimeMs),
          size: stats.size,
        })
      } catch (error) {
        // Vanished between the listing and the stat: the next run would drop it anyway.
        if (!isMissing(error)) throw error
      }
    }
  }

  found.sort((left, right) =>
    left.workspaceDir.localeCompare(right.workspaceDir) || left.sessionDir.localeCompare(right.sessionDir))
  return found
}

/**
 * List the session directories inside one workspace directory.
 * @param workspacePath - absolute path of one escaped workspace directory.
 * @returns directory names, or none when the directory vanished mid-scan.
 */
async function listDirectories(workspacePath: string): Promise<string[]> {
  try {
    const entries = await readdir(workspacePath, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch (error) {
    // Only a directory that vanished mid-scan is ignorable. Failing to read one for any other reason
    // must abort the run: a silently short scan would look like "sources disappeared" and delete the
    // rows of every session it could not list.
    if (isMissing(error)) return []
    throw error
  }
}

/**
 * Pick the newest-version log inside one session directory.
 * @param sessionDir - absolute path of the session directory.
 * @returns the chosen log path with its version, or undefined when the directory holds none.
 */
async function pickLogFile(sessionDir: string): Promise<{ path: string; version: number } | undefined> {
  let entries
  try {
    entries = await readdir(sessionDir, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  let chosen: { path: string; version: number } | undefined
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const match = SESSION_LOG.exec(entry.name)
    if (match === null) continue
    const version = Number.parseInt(match[1] ?? '0', 10)
    if (chosen === undefined || version > chosen.version) {
      chosen = { path: join(sessionDir, entry.name), version }
    }
  }
  return chosen
}

/**
 * List every Codex rollout log under a Codex home directory.
 *
 * A machine that has never run Codex has no `~/.codex`, and that is an empty contribution to the
 * index rather than a failure of the run — the same tolerance {@link scanSessions} applies to a
 * machine that has never run this harness.
 * @param codexRoot - absolute path of the Codex home (`~/.codex`).
 * @returns the logs found, ordered by path so runs are reproducible.
 */
export async function scanCodexSessions(codexRoot: string): Promise<SessionFile[]> {
  const found: SessionFile[] = []
  // Archived conversations are flat; live ones are nested under `<yyyy>/<mm>/<dd>`. The depth bound
  // is what stops a stray deep tree from turning the walk into an unbounded recursive read.
  await collectCodexLogs(join(codexRoot, 'archived_sessions'), found, 0)
  await collectCodexLogs(join(codexRoot, 'sessions'), found, 3)
  found.sort((left, right) => left.filePath.localeCompare(right.filePath))
  return found
}

/**
 * Recursively collect Codex rollout logs below one directory.
 * @param directory - directory to list.
 * @param out - destination list.
 * @param depth - how many more directory levels may be descended.
 */
async function collectCodexLogs(directory: string, out: SessionFile[], depth: number): Promise<void> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    // Only a directory that does not exist is ignorable. A read that fails for any other reason must
    // abort: a silently short scan looks like "sources disappeared" and deletes their rows.
    if (isMissing(error)) return
    throw error
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (depth > 0) await collectCodexLogs(path, out, depth - 1)
      continue
    }
    if (!entry.isFile() || !CODEX_ROLLOUT.test(entry.name)) continue
    try {
      const stats = await stat(path)
      out.push({
        sessionDir: directory,
        filePath: path,
        workspaceDir: CODEX_WORKSPACE_DIR,
        source: 'codex',
        mtime: Math.trunc(stats.mtimeMs),
        size: stats.size,
      })
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
}

/**
 * Read Codex's thread-name index.
 *
 * A rollout log records the conversation but not what Codex shows in its sidebar; that lives in
 * `~/.codex/session_index.jsonl` as `{ id, thread_name, updated_at }`. Titles are read once per run
 * rather than once per file, and a malformed line costs that one title — the index file is appended
 * to by Codex itself, so a partially written last line is normal.
 * @param codexRoot - absolute path of the Codex home.
 * @returns session id → thread name, empty when the file is absent.
 */
export async function readCodexTitles(codexRoot: string): Promise<ReadonlyMap<string, string>> {
  let text: string
  try {
    text = await readFile(join(codexRoot, 'session_index.jsonl'), 'utf8')
  } catch (error) {
    if (isMissing(error)) return new Map()
    throw error
  }
  const titles = new Map<string, string>()
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const record: unknown = JSON.parse(line)
      if (typeof record !== 'object' || record === null || Array.isArray(record)) continue
      const fields = record as Record<string, unknown>
      const id = fields['id']
      const title = fields['thread_name']
      if (typeof id !== 'string' || typeof title !== 'string' || title.trim() === '') continue
      titles.set(id, title)
    } catch {
      // One corrupt line is one missing title, not a failed run.
    }
  }
  return titles
}

/**
 * Whether an error is a missing path rather than a real I/O failure.
 * @param error - the caught value.
 * @returns true for ENOENT.
 */
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}
