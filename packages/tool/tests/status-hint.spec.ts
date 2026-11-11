import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { indexStatusHint } from '../src/status-hint.ts'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sessiongraph-hint-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Write the pair of files a finished indexing run leaves behind. */
function writeIndex(size: number, status: Record<string, number>): void {
  writeFileSync(join(root, 'index.db'), Buffer.alloc(size))
  writeFileSync(join(root, 'status.json'), JSON.stringify(status))
}

describe('the index state line', () => {
  it('names the operation that builds the index when there is none', () => {
    const text = indexStatusHint(root)
    expect(text).toContain('No index yet')
    expect(text).toContain('operation: "index"')
    expect(text).toContain('status')
  })

  it('says nothing that moves when the index is refreshed', () => {
    writeIndex(1024, { indexedAt: 1, sessions: 1, entries: 1, workspaces: 1, bytes: 1024 })
    const before = indexStatusHint(root)

    // Every incremental run changes all of these: more sessions, more entries, a new timestamp, a
    // larger file. The prompt line is assembled on every model request, so a line that moved with
    // them would rewrite the system prompt and invalidate its cache on each refresh.
    writeIndex(4096, { indexedAt: 2, sessions: 9, entries: 99, workspaces: 3, bytes: 4096 })
    expect(indexStatusHint(root)).toBe(before)
  })

  it('carries no digits at all, in either state', () => {
    const absent = indexStatusHint(root)
    writeIndex(2048, { indexedAt: 1_700_000_000_000, sessions: 822, entries: 123_125, workspaces: 18, bytes: 2048 })
    const present = indexStatusHint(root)
    expect(absent).not.toMatch(/\d/)
    expect(present).not.toMatch(/\d/)
    expect(present).toContain('Index ready')
  })

  it('points at status rather than reporting a size or a build time', () => {
    writeIndex(2048, { indexedAt: 1_700_000_000_000, sessions: 822, entries: 123_125, workspaces: 18, bytes: 2048 })
    const text = indexStatusHint(root)
    expect(text).toContain('operation: "status"')
    expect(text).toContain('freshness')
  })

  it('still answers when the file exists but no status sidecar does', () => {
    writeFileSync(join(root, 'index.db'), Buffer.alloc(64))
    expect(indexStatusHint(root)).toContain('Index ready')
  })
})
