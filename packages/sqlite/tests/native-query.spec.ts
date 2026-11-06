import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessiongraphRequest } from 'dsh-plugin-sessiongraph-service'
import type { NativeKernel, NativeQueryRequest, NativeQueryResponse } from 'dsh-plugin-sessiongraph-native'

// The kernel is a native module: the selection and failure-classification logic is driven with a
// stub, never the real `.node`. The real kernel's answers are covered by the parity tests in
// `packages/native/tests/query.spec.ts`.
vi.mock('dsh-plugin-sessiongraph-native', () => ({ loadNative: vi.fn() }))

/**
 * Import the store's native path with a clean module cache.
 *
 * `native-query.ts` remembers "no kernel" and "already reported" for the life of the process, so
 * each case needs its own module instance — otherwise one case's probe hides the next one's.
 * @returns the mocked loader and the fresh engine.
 */
async function freshSeam() {
  vi.resetModules()
  const native = await import('dsh-plugin-sessiongraph-native')
  const store = await import('../src/native-query.ts')
  return { loadNative: vi.mocked(native.loadNative), queryNatively: store.queryNatively }
}

/** A kernel whose `query` answers with the given response (or throws). */
function kernelResponding(
  respond: (request: NativeQueryRequest) => Promise<NativeQueryResponse> | NativeQueryResponse,
): NativeKernel {
  return {
    indexSessions: async () => {
      throw new Error('the query tests never index')
    },
    query: async request => respond(request),
  }
}

/** One request the adapter translates; only its shape matters to these tests. */
const TIMELINE: SessiongraphRequest = { operation: 'timeline', indexRoot: '/index', limit: 5 }

/** Silence and observe the one report a broken kernel is allowed to write. */
function spyOnConsoleError() {
  return vi.spyOn(console, 'error').mockImplementation(() => {})
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('queryNatively engine selection', () => {
  it('never probes the kernel when the engine is typescript', async () => {
    const { loadNative, queryNatively } = await freshSeam()
    const error = spyOnConsoleError()

    expect(await queryNatively('typescript', TIMELINE, '/index', 240)).toBeUndefined()
    expect(loadNative).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('answers undefined without throwing or logging when the machine has no kernel', async () => {
    const { loadNative, queryNatively } = await freshSeam()
    const error = spyOnConsoleError()
    loadNative.mockReturnValue(undefined)

    await expect(queryNatively('auto', TIMELINE, '/index', 240)).resolves.toBeUndefined()
    // `auto` treats "not built" as the normal state, so it must stay quiet.
    expect(error).not.toHaveBeenCalled()
  })
})

describe('queryNatively failure classification', () => {
  it('falls back silently for the seam business errors the TypeScript store will raise itself', async () => {
    const { loadNative, queryNatively } = await freshSeam()
    const error = spyOnConsoleError()
    let code = 'SESSIONGRAPH_NOT_FOUND'
    loadNative.mockReturnValue(
      kernelResponding(() => ({
        ok: false,
        payload_json: '',
        error_code: code,
        error_message: `${code} from the kernel`,
      })),
    )

    expect(await queryNatively('native', TIMELINE, '/index', 240)).toBeUndefined()
    code = 'SESSIONGRAPH_INVALID_REQUEST'
    expect(await queryNatively('native', TIMELINE, '/index', 240)).toBeUndefined()
    // A not-found session or an ambiguous prefix is the caller's business, not an engine fault:
    // blaming the native build would send someone debugging a healthy kernel.
    expect(error).not.toHaveBeenCalled()
  })

  it('still reports a kernel failure that is not a typed refusal', async () => {
    const { loadNative, queryNatively } = await freshSeam()
    const error = spyOnConsoleError()
    loadNative.mockReturnValue(
      kernelResponding(() => ({
        ok: false,
        payload_json: '',
        error_code: 'SESSIONGRAPH_CORRUPT',
        error_message: 'database disk image is malformed',
      })),
    )

    expect(await queryNatively('native', TIMELINE, '/index', 240)).toBeUndefined()
    // A damaged index is an engine fault, so it is worth one diagnostic line.
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('rejects a payload for another operation', async () => {
    const { loadNative, queryNatively } = await freshSeam()
    const error = spyOnConsoleError()
    loadNative.mockReturnValue(
      kernelResponding(() => ({
        ok: true,
        payload_json: JSON.stringify({ operation: 'session', sessionId: 'x', entries: [] }),
      })),
    )

    expect(await queryNatively('auto', TIMELINE, '/index', 240)).toBeUndefined()
    // A wrong-operation answer is a kernel bug, so it is reported — once.
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('falls back and reports once when the kernel throws', async () => {
    const { loadNative, queryNatively } = await freshSeam()
    const error = spyOnConsoleError()
    loadNative.mockReturnValue(
      kernelResponding(() => {
        throw new Error('napi exploded')
      }),
    )

    await expect(queryNatively('auto', TIMELINE, '/index', 240)).resolves.toBeUndefined()
    await expect(queryNatively('auto', TIMELINE, '/index', 240)).resolves.toBeUndefined()
    // A systematically broken build must not log per query.
    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0]?.[0])).toContain('napi exploded')
  })
})

describe('queryNatively request translation', () => {
  it('passes offset through for timeline and workspaces so paging agrees with the TypeScript store', async () => {
    const { loadNative, queryNatively } = await freshSeam()
    const seen: NativeQueryRequest[] = []
    loadNative.mockReturnValue(
      kernelResponding((request) => {
        seen.push(request)
        return { ok: true, payload_json: JSON.stringify({ operation: request.operation, sessions: [], workspaces: [] }) }
      }),
    )

    await queryNatively('native', { operation: 'timeline', indexRoot: '/index', limit: 2, offset: 3 }, '/index', 240)
    await queryNatively('native', { operation: 'workspaces', indexRoot: '/index', limit: 1, offset: 4 }, '/index', 240)

    expect(seen[0]).toMatchObject({ operation: 'timeline', limit: 2, offset: 3 })
    expect(seen[1]).toMatchObject({ operation: 'workspaces', limit: 1, offset: 4 })
  })
})
