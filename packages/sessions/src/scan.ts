/**
 * Discover the harness session logs under `sessionsRoot`.
 *
 * The harness lays sessions out as `<sessionsRoot>/<escaped-cwd>/<session-dir>/session.v<N>.jsonl.zstd`,
 * so the walk is exactly two directory levels deep followed by a filename match — it never recurses
 * into unrelated files (a `.DS_Store` sits at the root of a real `~/.dsh/sessions`) and never reads
 * anything it will not index.
 *
 * Both `v3` and `v4` logs are indexed: the harness has shipped both, they carry the same event shape,
 * and a machine that upgraded keeps its older `v3` files. Within one session directory the highest
 * version wins, so a half-finished v3 → v4 rewrite contributes one session rather than two.
 * @module dsh-plugin-sessiongraph-sessions/scan
 */

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** A session log file the indexer can read. */
export interface SessionFile {
  /** Absolute path of the directory holding the log (the harness session directory). */
  readonly sessionDir: string
  /** Absolute path of the log file itself. */
  readonly filePath: string
  /** The workspace directory name as the harness escaped it; a fallback when the header has no `cwd`. */
  readonly workspaceDir: string
  /** Modification time in epoch milliseconds, truncated to a whole millisecond for integer storage. */
  readonly mtime: number
  /** File size in bytes, the other half of the incremental change key. */
  readonly size: number
}

/** `session.v4.jsonl.zstd`, `session.v3.jsonl.zstd`, … — the version is captured for the pick below. */
const SESSION_LOG = /^session\.v(\d+)\.jsonl\.zstd$/

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
 * Whether an error is a missing path rather than a real I/O failure.
 * @param error - the caught value.
 * @returns true for ENOENT.
 */
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}
