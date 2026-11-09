/**
 * Codex history over the settings panel: the switch, the run, and the rows it adds or removes.
 *
 * The panel route tests already cover that `codexSync` reaches `panel.json`; this file covers the
 * other half — that the indexer reads that file on **every** run, so flipping the switch takes effect
 * without a restart, and that turning it off actually drops the rows instead of only stopping new
 * ones.
 * @module dsh-plugin-sessiongraph-sessions/tests/codex-index
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PANEL_FILE_NAME } from 'dsh-plugin-sessiongraph-service'
import { runIndex } from '../src/index.ts'
import type { ResolvedConfig } from '../src/index.ts'

interface Fixture {
  readonly work: string
  readonly sessionsRoot: string
  readonly codexRoot: string
  readonly indexRoot: string
}

let fixture: Fixture

beforeEach(() => {
  const work = mkdtempSync(join(tmpdir(), 'sessiongraph-codex-'))
  fixture = {
    work,
    sessionsRoot: join(work, 'sessions'),
    codexRoot: join(work, 'codex'),
    indexRoot: join(work, 'index'),
  }
  mkdirSync(fixture.sessionsRoot, { recursive: true })
})

afterEach(() => {
  rmSync(fixture.work, { recursive: true, force: true })
})

/**
 * The resolved configuration a real deployment hands the indexer.
 * @param overrides - members this test needs to differ.
 * @returns the configuration.
 */
function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    sessionsRoot: fixture.sessionsRoot,
    indexRoot: fixture.indexRoot,
    maxEntryChars: 4_000,
    toolCallChars: 2_000,
    maxFileBytes: 64 * 1024 * 1024,
    autoIndex: false,
    autoIndexMinIntervalMs: 60_000,
    autoBuild: false,
    indexLockStaleMs: 300_000,
    backgroundIndexThreshold: 1_000,
    autoIndexTimeoutMs: 900_000,
    maxLiveSessions: 8,
    engine: 'typescript',
    codex: true,
    codexRoot: fixture.codexRoot,
    ...overrides,
  }
}

/**
 * Write one Codex rollout under `archived_sessions/`.
 * @param id - session id recorded in `session_meta`.
 * @returns the absolute path written.
 */
function writeRollout(id: string): string {
  const directory = join(fixture.codexRoot, 'archived_sessions')
  mkdirSync(directory, { recursive: true })
  const path = join(directory, `rollout-2026-03-18T10-00-00-${id}.jsonl.zst`)
  const records = [
    {
      timestamp: '2026-03-18T02:00:00.000Z',
      ordinal: 0,
      type: 'session_meta',
      payload: { session_id: id, cwd: '/Users/admin/www/demo', originator: 'Codex Desktop' },
    },
    {
      timestamp: '2026-03-18T02:00:10.000Z',
      ordinal: 1,
      type: 'turn_context',
      payload: { turn_id: 'turn-1', model: 'gpt-5.4' },
    },
    {
      timestamp: '2026-03-18T02:00:20.000Z',
      ordinal: 2,
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '鸿蒙上架要哪些材料' }] },
    },
  ]
  writeFileSync(path, zstdCompressSync(Buffer.from(records.map(record => `${JSON.stringify(record)}\n`).join(''))))
  return path
}

/**
 * Record a panel choice the way the settings page does.
 * @param codexSync - the switch value to store.
 */
function savePanel(codexSync: boolean): void {
  mkdirSync(fixture.indexRoot, { recursive: true })
  writeFileSync(
    join(fixture.indexRoot, PANEL_FILE_NAME),
    `${JSON.stringify({ toolSet: 'sessiongraph', codexSync, updatedAt: Date.now() }, undefined, 2)}\n`,
  )
}

/**
 * Read every indexed session as `id → source`.
 * @returns the map, empty when the index does not exist yet.
 */
function indexedSessions(): Map<string, string> {
  let database: DatabaseSync
  try {
    database = new DatabaseSync(join(fixture.indexRoot, 'index.db'), { readOnly: true })
  } catch {
    return new Map()
  }
  try {
    const rows = database.prepare('SELECT id, source FROM session ORDER BY id').all() as Array<{
      readonly id: string
      readonly source: string
    }>
    return new Map(rows.map(row => [row.id, row.source]))
  } finally {
    database.close()
  }
}

describe('Codex history and the panel switch', () => {
  it('indexes Codex sessions when the configuration enables them', async () => {
    writeRollout('aaa-111')
    const report = await runIndex(fixture.indexRoot, { force: true }, undefined, config())

    expect(report.discovered).toBe(1)
    expect(report.failed).toEqual([])
    expect(indexedSessions()).toEqual(new Map([['aaa-111', 'codex']]))
  })

  it('skips Codex when the plugin configuration disables it', async () => {
    writeRollout('aaa-111')
    const report = await runIndex(fixture.indexRoot, { force: true }, undefined, config({ codex: false }))

    expect(report.discovered).toBe(0)
    expect(indexedSessions()).toEqual(new Map())
  })

  it('lets a saved panel choice override the configuration without a restart', async () => {
    writeRollout('aaa-111')
    // The config says on; the panel says off. The panel is the human's later word, so it wins.
    savePanel(false)
    const off = await runIndex(fixture.indexRoot, { force: true }, undefined, config({ codex: true }))
    expect(off.discovered).toBe(0)
    expect(indexedSessions()).toEqual(new Map())

    // Flipping it back must work on the next run, in the same process, with no reload.
    savePanel(true)
    const on = await runIndex(fixture.indexRoot, {}, undefined, config({ codex: true }))
    expect(on.discovered).toBe(1)
    expect(indexedSessions()).toEqual(new Map([['aaa-111', 'codex']]))
  })

  it('drops indexed Codex rows once the switch is turned off', async () => {
    writeRollout('aaa-111')
    await runIndex(fixture.indexRoot, { force: true }, undefined, config())
    expect(indexedSessions().size).toBe(1)

    savePanel(false)
    const off = await runIndex(fixture.indexRoot, {}, undefined, config())
    // The source file still exists; what disappeared is the choice to read it, and the removed count
    // is how the report says so.
    expect(off.removed).toBe(1)
    expect(indexedSessions()).toEqual(new Map())
  })

  it('keeps a plain saved choice working when the panel only changed the tool set', async () => {
    writeRollout('aaa-111')
    // A panel document without `codexSync` (written by a client that predates the switch) must not be
    // read as "off": the indexer falls back to the configured value.
    mkdirSync(fixture.indexRoot, { recursive: true })
    writeFileSync(
      join(fixture.indexRoot, PANEL_FILE_NAME),
      `${JSON.stringify({ toolSet: 'kernel', updatedAt: Date.now() })}\n`,
    )
    await runIndex(fixture.indexRoot, { force: true }, undefined, config({ codex: true }))

    expect(indexedSessions()).toEqual(new Map([['aaa-111', 'codex']]))
  })

  it('survives a corrupt panel file by using the configured value', async () => {
    writeRollout('aaa-111')
    mkdirSync(fixture.indexRoot, { recursive: true })
    writeFileSync(join(fixture.indexRoot, PANEL_FILE_NAME), '{ not json')

    const report = await runIndex(fixture.indexRoot, { force: true }, undefined, config({ codex: true }))

    expect(report.failed).toEqual([])
    expect(indexedSessions()).toEqual(new Map([['aaa-111', 'codex']]))
  })
})
