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
  SESSIONGRAPH_INDEX_PARAMETERS,
  SESSIONGRAPH_PARAMETERS,
} from '../src/schema.ts'
import type { SessiongraphToolArgs } from '../src/schema.ts'

describe('SESSIONGRAPH_PARAMETERS', () => {
  it('accepts a well-formed search', () => {
    expect(validateArgs(SESSIONGRAPH_PARAMETERS, { operation: 'search', query: '广告' })).toEqual([])
  })

  it('accepts every declared operation, with the fields that operation takes', () => {
    expect(validateArgs(SESSIONGRAPH_PARAMETERS, { operation: 'session', session_id: 'abc' })).toEqual([])
    expect(validateArgs(SESSIONGRAPH_PARAMETERS, { operation: 'timeline', limit: 5 })).toEqual([])
    expect(validateArgs(SESSIONGRAPH_PARAMETERS, { operation: 'workspaces' })).toEqual([])
    expect(validateArgs(SESSIONGRAPH_PARAMETERS, { operation: 'status' })).toEqual([])
  })

  it('rejects an operation outside the enum', () => {
    const violations = validateArgs(SESSIONGRAPH_PARAMETERS, { operation: 'delete-everything' })
    expect(violations.length).toBeGreaterThan(0)
    expect(violations.join('\n')).toContain('operation')
  })

  it('rejects a missing operation', () => {
    expect(validateArgs(SESSIONGRAPH_PARAMETERS, { query: '广告' }).length).toBeGreaterThan(0)
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
})

describe('SESSIONGRAPH_INDEX_PARAMETERS', () => {
  it('accepts an empty call and every declared switch', () => {
    expect(validateArgs(SESSIONGRAPH_INDEX_PARAMETERS, {})).toEqual([])
    expect(validateArgs(SESSIONGRAPH_INDEX_PARAMETERS, {
      force: true,
      workspace: '/w',
      session_id: 'abc',
    })).toEqual([])
  })

  it('rejects a non-boolean force', () => {
    expect(validateArgs(SESSIONGRAPH_INDEX_PARAMETERS, { force: 'yes' }).length).toBeGreaterThan(0)
  })
})

describe('buildRequest', () => {
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
      limit: 5,
      offset: 3,
    })
  })

  it('omits filters the model did not name, rather than sending undefined fields', () => {
    const request = buildRequest({ operation: 'search', query: '广告' }, '/root', 100)
    expect(request).toEqual({ operation: 'search', indexRoot: '/root', query: '广告', limit: 10 })
    expect('workspace' in request).toBe(false)
    expect('after' in request).toBe(false)
    expect('kinds' in request).toBe(false)
    expect('offset' in request).toBe(false)
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

  it('rejects a session without a session id', () => {
    expect(() => buildRequest({ operation: 'session' }, '/root', 100)).toThrow(/requires a non-empty "session_id"/)
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
