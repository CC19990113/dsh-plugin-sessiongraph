/**
 * The one tokenizer both sides use: the indexer tokenizes an entry on write, the store tokenizes a
 * query on read. Keeping them in the seam package is the whole point — a write-side and read-side
 * tokenizer that drift by one rule produce an index that silently cannot answer its own queries.
 *
 * ## Why bigrams
 *
 * SQLite's `unicode61` tokenizer splits on characters that are neither alphanumeric nor `_`, and
 * every CJK character is alphanumeric, so a whole Chinese sentence becomes ONE token: `广告` matches
 * nothing in `我今天在改广告SDK`, verified against SQLite 3.50.4. FTS5's `trigram` tokenizer fixes
 * three-or-more-character substrings but still misses the very common two-character Chinese word
 * (`广告`, `域名`, `功率`). So Chinese runs are expanded into overlapping two-character tokens on
 * BOTH sides: `广告点击` writes `广告 告点 点击`, and a query for `点击跳转` becomes
 * `"点击" AND "跳转" AND ...`. Latin and digit runs stay whole words in lower case.
 *
 * The cost is a bigger token stream (roughly one token per Chinese character) and AND-semantics
 * recall rather than exact phrase matching: `广告跳转` can match an entry where those characters are
 * not adjacent. For "find the conversation where I talked about this", recall beats phrase fidelity,
 * and a caller who needs adjacency can quote a longer term.
 * @module dsh-plugin-sessiongraph-service/tokenize
 */

/** Longest Latin/digit run kept as one token before it is split on `_`/`-` boundaries. */
const MAX_LATIN_TOKEN_LENGTH = 64

/** A CJK ideograph, including the extension-A block and the compatibility block. */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/** A run of one or more CJK ideographs. */
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g

/**
 * A run of Latin letters and digits. `_` deliberately does NOT belong to the run: FTS5's `unicode61`
 * treats it as a separator, and a caller searching `codegraph` must still find an entry that says
 * `codegraph_index`, so the write side splits on it exactly like the tokenizer would.
 */
const LATIN_RUN = /[A-Za-z0-9]+/g

/**
 * Tokenize text into the stream written to `entry_fts.tokens` and compared against a query.
 *
 * @param text - raw entry text or query text.
 * @returns tokens in document order, with duplicates kept (FTS5 deduplicates per position itself).
 */
export function tokenize(text: string): string[] {
  if (text === '') return []
  const tokens: string[] = []

  // Walk the two character classes in one pass so a mixed string keeps its order; positions do not
  // matter to the query, but a stable order keeps a written index byte-reproducible for tests.
  const matched: { at: number; value: string[] }[] = []
  for (const match of text.matchAll(CJK_RUN)) {
    matched.push({ at: match.index, value: bigrams(match[0]) })
  }
  for (const match of text.matchAll(LATIN_RUN)) {
    const token = match[0].toLowerCase()
    if (token.length === 0) continue
    matched.push({ at: match.index, value: token.length > MAX_LATIN_TOKEN_LENGTH ? [token.slice(0, MAX_LATIN_TOKEN_LENGTH)] : [token] })
  }
  matched.sort((left, right) => left.at - right.at)
  for (const entry of matched) tokens.push(...entry.value)
  return tokens
}

/**
 * Expand one CJK run into overlapping two-character tokens.
 * @param run - a non-empty run of ideographs.
 * @returns one token per character for a single character, else one per adjacent pair.
 */
function bigrams(run: string): string[] {
  if (run.length <= 1) return [run]
  const tokens: string[] = []
  for (let index = 0; index < run.length - 1; index += 1) tokens.push(run.slice(index, index + 2))
  return tokens
}

/**
 * Build the FTS5 MATCH expression for a user query.
 *
 * Tokens are double-quoted (so FTS5 treats them as literals rather than barewords) and joined with
 * `AND`, which is the OR-free form that keeps a multi-token query narrowing instead of widening.
 *
 * @param query - raw query text.
 * @returns an FTS5 MATCH expression, or `undefined` when the query has no searchable token.
 */
export function matchExpression(query: string): string | undefined {
  const tokens = dedupe(tokenize(query))
  if (tokens.length === 0) return undefined
  return tokens.map(token => `"${token.replaceAll('"', '""')}"`).join(' AND ')
}

/**
 * Tokenize a query the way the index expects, deduplicated, for snippet highlighting.
 * @param query - raw query text.
 * @returns distinct tokens, longest first so a longer term claims the highlight before a bigram does.
 */
export function highlightTerms(query: string): string[] {
  return dedupe(tokenize(query)).sort((left, right) => right.length - left.length)
}

/**
 * Remove duplicate tokens while preserving first-seen order.
 * @param tokens - tokens to dedupe.
 * @returns distinct tokens.
 */
function dedupe(tokens: readonly string[]): string[] {
  return [...new Set(tokens)]
}

/**
 * Whether a character is a CJK ideograph.
 * @param char - one character.
 * @returns true for an ideograph.
 */
export function isCjk(char: string): boolean {
  return CJK.test(char)
}
