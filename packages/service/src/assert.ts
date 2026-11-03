/**
 * A three-line re-statement of `assertNever`, owned here instead of imported from the host.
 *
 * `@deepseek-ai/dsh-llm` exported this through 0.1.x and dropped it in 0.2.x (the implementation
 * moved to `@deepseek-ai/dsh-util-values`, which 0.1.x does not ship). A static import of a symbol
 * the host no longer exports parses fine and fails at load, which removes the whole consumer plugin
 * from the host instead of failing at one unreachable branch.
 * @module dsh-plugin-sessiongraph-service/assert
 */

/**
 * Compile-time exhaustiveness check for a discriminated union.
 * @param value - the value that must never be reached.
 * @returns never; throws when the value is actually reachable.
 */
export function assertNever(value: never): never {
  throw new Error(`unreachable: ${JSON.stringify(value)}`)
}
