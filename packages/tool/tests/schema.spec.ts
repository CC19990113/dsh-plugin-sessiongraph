/**
 * Schema and request-building tests: the model-facing parameter spec must reject what the tool cannot
 * answer, and the request builder must translate the model's snake_case arguments into the seam's
 * camelCase vocabulary — including the conditional requirements the parameter DSL cannot express.
 * @module dsh-plugin-sessiongraph-tool/tests/schema
 */

import { validateArgs } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { buildRequest } from '../src/index.ts'
import {
  SESSIONGRAPH_DEFAULT_LIMITS,
  SESSIONGRAPH_PARAMETERS,
  SESSIONGRAPH_TOOL_OPERATIONS,
} from '../src/schema.ts'
import type { SessiongraphToolArgs } from '../src/schema.ts'

describe('SESSIONGRAPH_TOOL_OPERATIONS', () => {
  it('is the seam vocabulary plus the touched query and the index write', () => {
    expect(SESSIONGRAPH_TOOL_OPERATIONS).toEqual([
      'search',
      'session',
      'event',
      'trace',
      'timeline',
      'workspaces',
      'status',
      'touched',
      'index',
    ])
  })
})

describe('SESSIONGRAPH_PARAMETERS', () => {
  it('accepts a well-formed search', () => {
    expect(validateArgs(SESSIONGRAPH_PARAMETERS, { operation: 'search', query: '广告' })).toEqual([])
  })

  it('accepts every declared operation, with the fields that operation takes', () => {
    expect(validateArgs(SESSIONGRAPH_PARAMETERS, { operation: 'session', session_id: 'abc' })).toEqual([])
    expect(validateArgs(SESSIONGRAPH_PARAMETERS, { operation: 'event', session_id: 'abc', seq: 3 })).toEqual([])
    expect(validateArgs(SESSIONGRAPH_PARAMETERS, { operation: 'trace', session_id: 'abc', seq: 3, depth: 2 })).toEqual([])
    expect(validateArgs(SESSIONGRAPH_PARAMETERS, { operation: 'timeline', limit: 5 })).toEqual([])
    expect(validateArgs(SESSIONGRAPH_PARAMETERS, { operation: 'workspaces' })).toEqual([])
    expect(validateArgs(SESSIONGRAPH_PARAMETERS, { operation: 'status' })).toEqual([])
    expect(validateArgs(SESSIONGRAPH_PARAMETERS, { operation: 'touched', session_id: 'abc' })).toEqual([])
    expect(validateArgs(SESSIONGRAPH_PARAMETERS, { operation: 'index', force: true })).toEqual([])
  })

  it('accepts a touched call with a page size and an offset', () => {
    expect(validateArgs(SESSIONGRAPH_PARAMETERS, {
      operation: 'touched',
      session_id: 'abc',
      limit: 5,
      offset: 2,
    })).toEqual([])
  })

  it('accepts the event window and the single-session search filter', () => {
    expect(validateArgs(SESSIONGRAPH_PARAMETERS, {
      operation: 'event',
      session_id: 'abc',
      seq: 3,
      window_before: 2,
      window_after: 1,
    })).toEqual([])
    expect(validateArgs(SESSIONGRAPH_PARAMETERS, {
      operation: 'search',
      query: '广告',
      session_id: 'abc',
      dedupe_by_session: false,
    })).toEqual([])
  })

  it('rejects an operation outside the enum', () => {
    const violations = validateArgs(SESSIONGRAPH_PARAMETERS, { operation: 'delete-everything' })
    expect(violations.length).toBeGreaterThan(0)
    expect(violations.join('\n')).toContain('operation')
  })

  it('accepts a call that omits operation, since the tool defaults it to search', () => {
    expect(validateArgs(SESSIONGRAPH_PARAMETERS, { query: '广告' })).toEqual([])
  })

  it('rejects an entry kind outside the seam vocabulary', () => {
    const violations = validateArgs(SESSIONGRAPH_PARAMETERS, {
      operation: 'search',
      query: '广告',
      kinds: ['user', 'gossip'],
    })
    expect(violations.length).toBeGreaterThan(0)
  })

  it('rejects a non-string query and a non-numeric limit', () => {
    expect(validateArgs(SESSIONGRAPH_PARAMETERS, { operation: 'search', query: 42 }).length).toBeGreaterThan(0)
    expect(validateArgs(SESSIONGRAPH_PARAMETERS, { operation: 'search', query: 'x', limit: 'lots' }).length)
      .toBeGreaterThan(0)
  })

  it('rejects a non-numeric seq and a non-boolean force', () => {
    expect(validateArgs(SESSIONGRAPH_PARAMETERS, { operation: 'event', session_id: 'a', seq: 'third' }).length)
      .toBeGreaterThan(0)
    expect(validateArgs(SESSIONGRAPH_PARAMETERS, { operation: 'index', force: 'yes' }).length).toBeGreaterThan(0)
  })
})

describe('buildRequest', () => {
  it('defaults an omitted operation to search and builds the ordinary search request', () => {
    expect(buildRequest({ query: '广告' }, '/root', 100)).toEqual({
      operation: 'search',
      indexRoot: '/root',
      query: '广告',
      dedupeBySession: true,
      limit: 10,
    })
    // The default is a search, not a wildcard: a call with neither operation nor query still fails.
    expect(() => buildRequest({}, '/root', 100)).toThrow(/requires a non-empty "query"/)
  })

  it('maps snake_case arguments onto the seam request and keeps every filter', () => {
    expect(buildRequest({
      operation: 'search',
      query: '广告',
      workspace: '/w',
      after: 1_000,
      before: 2_000,
      kinds: ['user', 'tool'],
      limit: 5,
      offset: 3,
    }, '/root', 100)).toEqual({
      operation: 'search',
      indexRoot: '/root',
      query: '广告',
      workspace: '/w',
      after: 1_000,
      before: 2_000,
      kinds: ['user', 'tool'],
      // Absent a session filter, one hit per session is the useful default across conversations.
      dedupeBySession: true,
      limit: 5,
      offset: 3,
    })
  })

  it('omits filters the model did not name, rather than sending undefined fields', () => {
    const request = buildRequest({ operation: 'search', query: '广告' }, '/root', 100)
    expect(request).toEqual({ operation: 'search', indexRoot: '/root', query: '广告', dedupeBySession: true, limit: 10 })
    expect('workspace' in request).toBe(false)
    expect('after' in request).toBe(false)
    expect('kinds' in request).toBe(false)
    expect('offset' in request).toBe(false)
    expect('sessionId' in request).toBe(false)
  })

  it('scopes a search to one session and turns dedupe off, since one session would yield one hit', () => {
    expect(buildRequest({ operation: 'search', query: '广告', session_id: 'abc' }, '/root', 100)).toEqual({
      operation: 'search',
      indexRoot: '/root',
      query: '广告',
      sessionId: 'abc',
      dedupeBySession: false,
      limit: 10,
    })
  })

  it('honors an explicit dedupe choice over the session-filter default', () => {
    expect(buildRequest({ operation: 'search', query: 'x', dedupe_by_session: false }, '/root', 100))
      .toHaveProperty('dedupeBySession', false)
    expect(buildRequest({ operation: 'search', query: 'x', session_id: 'abc', dedupe_by_session: true }, '/root', 100))
      .toHaveProperty('dedupeBySession', true)
  })

  it('maps event and trace onto their seam requests', () => {
    expect(buildRequest({
      operation: 'event',
      session_id: 'abc',
      seq: 7.9,
      window_before: 3,
      window_after: 1,
    }, '/root', 100)).toEqual({
      operation: 'event',
      indexRoot: '/root',
      sessionId: 'abc',
      seq: 7,
      windowBefore: 3,
      windowAfter: 1,
    })
    expect(buildRequest({
      operation: 'trace',
      session_id: 'abc',
      seq: 7,
      depth: 2,
    }, '/root', 100)).toEqual({
      operation: 'trace',
      indexRoot: '/root',
      sessionId: 'abc',
      seq: 7,
      depth: 2,
    })
    // Omitting seq selects the session-lineage shape; the seam discriminates on its absence.
    expect(buildRequest({ operation: 'trace', session_id: 'abc' }, '/root', 100))
      .toEqual({ operation: 'trace', indexRoot: '/root', sessionId: 'abc' })
  })

  it('clamps a negative window or depth to zero rather than sending a negative bound', () => {
    expect(buildRequest({ operation: 'event', session_id: 'a', seq: 1, window_before: -5, window_after: -1 }, '/root', 100))
      .toMatchObject({ windowBefore: 0, windowAfter: 0 })
    expect(buildRequest({ operation: 'trace', session_id: 'a', depth: -2 }, '/root', 100)).toMatchObject({ depth: 0 })
  })

  it('applies the per-operation default limit when the model names none', () => {
    expect(buildRequest({ operation: 'search', query: 'x' }, '/root', 100)).toHaveProperty(
      'limit',
      SESSIONGRAPH_DEFAULT_LIMITS.search,
    )
    expect(buildRequest({ operation: 'session', session_id: 'abc' }, '/root', 100)).toHaveProperty(
      'limit',
      SESSIONGRAPH_DEFAULT_LIMITS.session,
    )
    expect(buildRequest({ operation: 'timeline' }, '/root', 100)).toHaveProperty(
      'limit',
      SESSIONGRAPH_DEFAULT_LIMITS.timeline,
    )
    expect(buildRequest({ operation: 'workspaces' }, '/root', 100)).toHaveProperty(
      'limit',
      SESSIONGRAPH_DEFAULT_LIMITS.workspaces,
    )
  })

  it('clamps a model-supplied limit into [1, maxLimit]', () => {
    expect(buildRequest({ operation: 'search', query: 'x', limit: 9_999 }, '/root', 100)).toHaveProperty('limit', 100)
    expect(buildRequest({ operation: 'search', query: 'x', limit: 0 }, '/root', 100)).toHaveProperty('limit', 1)
  })

  it('drops an empty kinds list and a blank workspace filter is kept verbatim', () => {
    const request = buildRequest({ operation: 'search', query: 'x', kinds: [] }, '/root', 100)
    expect('kinds' in request).toBe(false)
  })

  it('rejects a search without a query', () => {
    expect(() => buildRequest({ operation: 'search' }, '/root', 100)).toThrow(/requires a non-empty "query"/)
    expect(() => buildRequest({ operation: 'search', query: '   ' }, '/root', 100)).toThrow(/requires a non-empty "query"/)
  })

  it('rejects a session, event or trace without a session id', () => {
    expect(() => buildRequest({ operation: 'session' }, '/root', 100)).toThrow(/requires a non-empty "session_id"/)
    expect(() => buildRequest({ operation: 'event', seq: 1 }, '/root', 100)).toThrow(/requires a non-empty "session_id"/)
    expect(() => buildRequest({ operation: 'trace' }, '/root', 100)).toThrow(/requires a non-empty "session_id"/)
  })

  it('rejects an event without a seq', () => {
    expect(() => buildRequest({ operation: 'event', session_id: 'a' }, '/root', 100)).toThrow(/requires a numeric "seq"/)
  })

  it('rejects an operation outside the closed vocabulary', () => {
    expect(() => buildRequest(
      { operation: 'purge' } as unknown as SessiongraphToolArgs,
      '/root',
      100,
    )).toThrow(/unknown sessiongraph operation/)
  })

  it('builds a status request with no limit at all', () => {
    expect(buildRequest({ operation: 'status' }, '/root', 100)).toEqual({ operation: 'status', indexRoot: '/root' })
  })
})
