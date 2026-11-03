import { describe, expect, it } from 'vitest'
import { highlightTerms, isCjk, matchExpression, tokenize } from '../src/tokenize.ts'

describe('tokenize', () => {
  it('expands a CJK run into overlapping bigrams', () => {
    expect(tokenize('广告点击')).toEqual(['广告', '告点', '点击'])
  })

  it('keeps a single CJK character as its own token', () => {
    expect(tokenize('改')).toEqual(['改'])
  })

  it('lowercases Latin runs and keeps them whole', () => {
    expect(tokenize('FTP 148W codegraph_index')).toEqual(['ftp', '148w', 'codegraph', 'index'])
  })

  it('interleaves CJK and Latin tokens in document order', () => {
    expect(tokenize('改广告SDK')).toEqual(['改广', '广告', 'sdk'])
  })

  it('drops punctuation and whitespace', () => {
    expect(tokenize('，。！ ( ) [ ]')).toEqual([])
  })

  it('returns nothing for empty input', () => {
    expect(tokenize('')).toEqual([])
  })
})

describe('matchExpression', () => {
  it('AND-joins the deduped tokens of a CJK query', () => {
    // `广告` is one bigram; `点击` + `击跳` + `跳转` come from `点击跳转`.
    expect(matchExpression('广告 点击跳转')).toBe('"广告" AND "点击" AND "击跳" AND "跳转"')
  })

  it('splits on underscores so a word still finds its prefixed form', () => {
    expect(tokenize('codegraph_index')).toEqual(['codegraph', 'index'])
  })

  it('returns undefined when the query has no searchable token', () => {
    expect(matchExpression('   ')).toBeUndefined()
  })
})

describe('highlightTerms', () => {
  it('dedupes and orders terms longest first', () => {
    // Both runs produce `广告`; the longer Latin term must win the highlight.
    expect(highlightTerms('广告 codegraph 广告')).toEqual(['codegraph', '广告'])
  })
})

describe('isCjk', () => {
  it('recognizes ideographs and rejects Latin', () => {
    expect(isCjk('广')).toBe(true)
    expect(isCjk('a')).toBe(false)
  })
})
