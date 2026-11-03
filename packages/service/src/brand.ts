/**
 * dsh-plugin-sessiongraph's owned branded ids: {@link SessiongraphStoreId}, the identity a read
 * provider reserves on `ctx.sessiongraph`; {@link SessiongraphIndexerId}, the identity a write
 * provider reserves; and {@link SessiongraphSessionId}, a harness session id taken verbatim from a
 * session log's header.
 *
 * The brand is declared here rather than borrowed from `@deepseek-ai/dsh-brand` on purpose: a host
 * utility that exists in one DSH line and not another turns into a load-time failure that removes
 * the whole plugin, which is exactly the failure mode a four-line `unique symbol` avoids. Keeping
 * each type with its factory lets `index.ts` re-export all three under one name.
 * @module dsh-plugin-sessiongraph-service/brand
 */

declare const SESSIONGRAPH_STORE_BRAND: unique symbol
declare const SESSIONGRAPH_INDEXER_BRAND: unique symbol
declare const SESSIONGRAPH_SESSION_BRAND: unique symbol

/** Opaque store-provider identity, reserved at registration and released by the disposer. */
export type SessiongraphStoreId = string & { readonly [SESSIONGRAPH_STORE_BRAND]: true }

/**
 * Brand a string as a {@link SessiongraphStoreId}. No validation — the registry rejects an empty id
 * at registration.
 * @param id - the provider's stable identifier.
 * @returns the same string, branded.
 */
export function SessiongraphStoreId(id: string): SessiongraphStoreId {
  return id as SessiongraphStoreId
}

/** Opaque indexer-provider identity, reserved at registration and released by the disposer. */
export type SessiongraphIndexerId = string & { readonly [SESSIONGRAPH_INDEXER_BRAND]: true }

/**
 * Brand a string as a {@link SessiongraphIndexerId}. No validation — the registry rejects an empty id
 * at registration.
 * @param id - the provider's stable identifier.
 * @returns the same string, branded.
 */
export function SessiongraphIndexerId(id: string): SessiongraphIndexerId {
  return id as SessiongraphIndexerId
}

/** Identity of one harness session, as recorded in its log header. */
export type SessiongraphSessionId = string & { readonly [SESSIONGRAPH_SESSION_BRAND]: true }

/**
 * Brand a string as a {@link SessiongraphSessionId}.
 * @param id - the session id read from a session log header.
 * @returns the same string, branded.
 */
export function SessiongraphSessionId(id: string): SessiongraphSessionId {
  return id as SessiongraphSessionId
}
