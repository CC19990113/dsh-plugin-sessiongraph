/**
 * The settings-page HTTP surface: `GET/POST /dsh-plugin-sessiongraph/api/tools`.
 *
 * Why this package owns the routes: the setting they edit is the very `toolSet` the model-facing
 * visibility layer reads, and the persisted file lives beside the index this package already knows
 * the root of. A separate host package would need that root and a second definition of the choice.
 *
 * The persisted file is `<indexRoot>/panel.json`, one JSON object holding two independent choices:
 * `toolSet` (which session-reading tools the model sees) and `codexSync` (whether Codex's rollout
 * logs join the index). It is the settings page's own storage, not an index artifact: it is read at
 * load and rewritten on every save, and a missing or unreadable file simply means "use the configured
 * value" — a broken panel must never stop the plugin from loading.
 *
 * The two choices take effect on different clocks, which is why this module never applies `codexSync`
 * itself: `toolSet` is applied to live agents here, while `codexSync` is read by the **indexer** on
 * each run (it is the same file — see `PANEL_FILE_NAME` in the seam package). A save therefore stores
 * the switch and lets the next index run act on it.
 *
 * The route table is deliberately tiny: a GET that reports the current choices plus which tools this
 * host actually registered, and a POST that validates them, persists them, and re-applies the tool
 * set to the live agents. Nothing here accepts a path, so there is no path-traversal surface at all.
 *
 * The port is loopback, which every page in the user's browser can reach, so "a request arrived" is
 * not evidence the user asked for it. The save therefore proves its provenance before it is allowed
 * to change anything: a JSON content type, an `Origin` that names this request's own literal host,
 * and no cross-site `Sec-Fetch-Site`.
 * @module dsh-plugin-sessiongraph-tool/panel
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { PANEL_FILE_NAME } from 'dsh-plugin-sessiongraph-service'
import type { ResolvedConfig } from './index.ts'
import { describeSessionTools, getToolSet, normalizeToolSet, setToolSet } from './visibility.ts'
import type { AvailableSessionTools, ToolSet } from './visibility.ts'

/** Path prefix every panel route lives under. The browser client hardcodes the same string. */
export const PANEL_ROUTE_PREFIX = '/dsh-plugin-sessiongraph/api'

// Re-exported so a consumer that already imports the panel surface keeps working; the constant
// itself lives in the seam package because the indexer reads the same file.
export { PANEL_FILE_NAME }

/**
 * What the panel shows for `codexSync` before anything was ever saved.
 *
 * Not read from a configuration member on purpose: `codex` is the **indexer's** option, and this
 * package never loads that indexer — inventing a second `codex` config here would let the panel
 * display one value while the run acts on another. `true` mirrors the indexer's own default, and the
 * indexer is the authority once a value is saved (it reads this same file).
 */
const DEFAULT_CODEX_SYNC = true

/**
 * Largest request body accepted by the save route, in bytes.
 *
 * The only body this API accepts is one JSON object with a single enum string, so 8 KiB is already
 * two orders of magnitude past the contract. The cap exists so a browser (or anything reaching the
 * port) cannot make the host buffer an unbounded request.
 */
const MAX_BODY_BYTES = 8 * 1024

/**
 * Loopback names trusted when a request carries no `Host` header to compare against.
 *
 * The primary same-origin test is `Origin`'s host against the request's own `Host`, which accepts any
 * address the panel is actually served from. Only an HTTP/1.0 probe has no `Host`, and then this
 * short list is the conservative reading of "this machine".
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1'])

/** `Sec-Fetch-Site` values that mean "no foreign site started this request". */
const SAME_ORIGIN_FETCH_SITES = new Set(['same-origin', 'none'])

/** Why a save was refused: the status to send and the line the panel shows. */
interface WriteRejection {
  /** HTTP status: 400 for a malformed request, 403 for a foreign one. */
  readonly code: number
  /** One line the panel can display verbatim. */
  readonly message: string
}

/**
 * The request face of a route handler, declared structurally.
 *
 * `@deepseek-ai/dsh-host-webserver` is not a dependency of this package: the service may be absent,
 * and importing its types would tie the install to a host package this plugin is written to live
 * without. In practice the handler receives node's `IncomingMessage`; only these members are read.
 */
export interface PanelRequest {
  /** Origin-form request target, query included (node always supplies it for http). */
  readonly url?: string
  /** HTTP method; node always supplies it. */
  readonly method?: string
  /**
   * Request headers, as node supplies them (names already lowercased). Only the save route reads
   * them: a loopback port accepts a write from any page that can reach it, so the save inspects the
   * headers that identify the requesting page.
   */
  readonly headers?: Readonly<Record<string, string | readonly string[] | undefined>>
  /** Body chunks, used only by the save route. */
  [Symbol.asyncIterator](): AsyncIterator<Buffer | string>
}

/**
 * The response face of a route handler, declared structurally for the same reason as
 * {@link PanelRequest}. In practice this is node's `ServerResponse`.
 */
export interface PanelResponse {
  /** HTTP status the handler sets before writing the body. */
  statusCode: number
  /**
   * Set one response header.
   * @param name - header name.
   * @param value - header value.
   */
  setHeader(name: string, value: string): void
  /**
   * End the response.
   * @param body - complete response body.
   */
  end(body?: string): void
}

/** One route registration, as the web server's route table takes it. */
export interface PanelRoute {
  /** Prefix matching: every path under {@link PANEL_ROUTE_PREFIX} reaches the handler. */
  readonly kind: 'prefix'
  /** The claimed path prefix. */
  readonly path: string
  /**
   * Own the full request/response lifecycle.
   * @param req - the incoming request.
   * @param res - the response to write.
   */
  readonly handler: (req: PanelRequest, res: PanelResponse) => void | Promise<void>
}

/** The web server's registration surface, declared structurally. */
export interface PanelWebServer {
  /**
   * Claim one route.
   * @param route - kind, path, and handler.
   * @returns the disposer removing the registration.
   */
  register(route: PanelRoute): () => void
}

/** A successful `GET` or `POST /tools` answer. */
export interface PanelToolsResponse {
  /** This answer carries data. */
  readonly ok: true
  /** The choice now in effect. */
  readonly toolSet: ToolSet
  /**
   * Whether Codex history is part of the corpus.
   *
   * Reports the value the next index run will use, not merely what the file holds: an unsaved panel
   * shows the configured default, which is what the indexer would act on right now.
   */
  readonly codexSync: boolean
  /** Which session tools this host actually registered. */
  readonly available: AvailableSessionTools
}

/** The answer every failed route call carries, whatever its HTTP status. */
export interface PanelErrorResponse {
  /** No data accompanies this answer. */
  readonly ok: false
  /** One line the panel shows verbatim. */
  readonly message: string
}

/** Any JSON body these routes can write. */
type PanelBody = PanelToolsResponse | PanelErrorResponse

/** One route's decision: an HTTP status plus the JSON body describing it. */
interface RouteResult {
  /** HTTP status to send. */
  readonly code: number
  /** JSON body to send. */
  readonly body: PanelBody
}

/** The persisted settings document. */
interface PanelFile {
  /** The chosen session-tool set. */
  readonly toolSet: ToolSet
  /**
   * Whether Codex history should be indexed, when a human saved a deviation from the configuration.
   *
   * Absent means "follow the plugin config", which is what a panel nobody opened records. It is a
   * whole-document rewrite on save, so this member must be carried over explicitly when the caller
   * only changes `toolSet`.
   */
  readonly codexSync?: boolean
  /** When the choice was last saved, epoch milliseconds; diagnostics only. */
  readonly updatedAt: number
}

/** The host's filesystem seam, declared structurally: optional, and only the write half is used. */
interface FsSeam {
  /**
   * Resolve a path into the backend's opaque target identity.
   * @param path - absolute path.
   * @param options - resolution options.
   * @returns the target.
   */
  resolve?(path: string, options?: { readonly cwd?: string }): Promise<unknown>
  /**
   * Write text to one target atomically (the seam's own contract).
   * @param target - the resolved target.
   * @param content - full file content.
   * @returns whatever the backend returns.
   */
  writeText?(target: unknown, content: string): Promise<unknown>
}

/** What reading a request body produced. */
type BodyResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string }

/**
 * Register the panel's routes when the host composition provides a web server.
 *
 * Returns nothing on purpose: the registration is a lifecycle effect that the plugin's fiber
 * disposes, and a profile without the service simply never runs the callback. The try/catch is
 * defence for an exotic context whose `inject` rejects synchronously; the panel is optional, so it
 * must never fail plugin startup.
 *
 * The persisted choice is applied here — synchronously, before the first model request — because
 * this is the only place that knows where `panel.json` lives. `applyVisibility` has already applied
 * the configured default, so this call is a lift-and-reapply of that one restriction at load time.
 * @param ctx - the plugin context.
 * @param config - the resolved plugin configuration (reads `indexRoot`).
 */
export function applyPanel(ctx: Context, config: ResolvedConfig): void {
  const indexRoot = expandHome(config.indexRoot)
  const file = join(indexRoot, PANEL_FILE_NAME)

  const persisted = readPanelFile(file)
  if (persisted !== undefined) setToolSet(ctx, persisted.toolSet)

  try {
    ctx.inject(['webServer'], child => {
      const webServer = (child as Context & { webServer: PanelWebServer }).webServer
      child.effect(
        () => webServer.register({
          kind: 'prefix',
          path: PANEL_ROUTE_PREFIX,
          handler: (req, res) => handleRequest(ctx, file, req, res),
        }),
        'sessiongraph: settings panel api',
      )
    })
  } catch (error) {
    // A host without a web server (or with a broken one) keeps its tools; only the panel is lost.
    console.warn('[sessiongraph] webServer service unavailable; the settings panel cannot load its data:', error)
  }
}

/**
 * Answer one request routed under the panel prefix.
 *
 * A thrown handler becomes a 400 from the web server itself with no body the client can render, so
 * every failure this module can foresee is turned into its own JSON answer here; the catch-all only
 * covers a malformed request target or a defect, and exists so the client still gets the `ok:false`
 * shape it knows how to display.
 * @param ctx - the plugin context.
 * @param file - absolute path of the persisted settings file.
 * @param req - the incoming request.
 * @param res - the response to write.
 * @returns settles once the response is written.
 */
async function handleRequest(ctx: Context, file: string, req: PanelRequest, res: PanelResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    // Trailing slashes are tolerated so `/tools/` and `/tools` are the same route; the client never
    // sends one, but a hand-typed probe might.
    const route = url.pathname.slice(PANEL_ROUTE_PREFIX.length).replace(/\/+$/u, '')
    const method = (req.method ?? 'GET').toUpperCase()
    if (route === '/tools' && method === 'GET') {
      respond(res, currentResult(ctx, file))
      return
    }
    if (route === '/tools' && method === 'POST') {
      const rejection = writeRejection(req)
      if (rejection !== undefined) {
        respond(res, { code: rejection.code, body: { ok: false, message: rejection.message } })
        return
      }
      respond(res, await saveResult(ctx, file, req))
      return
    }
    respond(res, { code: 404, body: { ok: false, message: '未知的面板接口' } })
  } catch (error) {
    respond(res, { code: 500, body: { ok: false, message: String(error) } })
  }
}

/**
 * Build the `GET /tools` answer.
 *
 * `toolSet` comes from live state (a plugin reload can change the effective choice without touching
 * the file), while `codexSync` comes from the file — the indexer reads that file on every run, so the
 * file is the only thing that truthfully describes what the next run will do.
 * @param ctx - the plugin context.
 * @param file - absolute path of the persisted settings file.
 * @returns the current choices and the tools this host registered.
 */
function currentResult(ctx: Context, file: string): RouteResult {
  const persisted = readPanelFile(file)
  return {
    code: 200,
    body: {
      ok: true,
      toolSet: getToolSet(ctx) ?? normalizeToolSet(undefined),
      codexSync: persisted?.codexSync ?? DEFAULT_CODEX_SYNC,
      available: describeSessionTools(ctx),
    },
  }
}

/**
 * Validate, persist, and apply one choice.
 *
 * Order matters: the choice is applied to the live agents only after it is on disk, so a failed write
 * cannot leave the running process and the saved file disagreeing about what the user asked for.
 * @param ctx - the plugin context.
 * @param file - absolute path of the persisted settings file.
 * @param req - the request whose body names the choice.
 * @returns the save answer, or the failure that explains why nothing changed.
 */
async function saveResult(ctx: Context, file: string, req: PanelRequest): Promise<RouteResult> {
  const read = await readJsonBody(req)
  if (!read.ok) return { code: 400, body: { ok: false, message: read.message } }
  const toolSet = toolSetField(read.value)
  if (toolSet === undefined) {
    return { code: 400, body: { ok: false, message: 'toolSet 必须是 sessiongraph、kernel 或 both 之一' } }
  }
  const requestedCodex = booleanField(read.value, 'codexSync')
  // A caller that changes only `toolSet` must not silently reset the Codex choice, so an absent
  // field inherits whatever the file already records — and only an explicit boolean is written.
  const existing = readPanelFile(file)
  const codexSync = requestedCodex ?? existing?.codexSync
  const document: PanelFile = {
    toolSet,
    ...(codexSync === undefined ? {} : { codexSync }),
    updatedAt: Date.now(),
  }
  const written = await writePanelFile(ctx, file, document)
  if (!written) return { code: 500, body: { ok: false, message: `无法写入 ${file}` } }
  setToolSet(ctx, toolSet)
  return {
    code: 200,
    body: {
      ok: true,
      toolSet,
      codexSync: codexSync ?? DEFAULT_CODEX_SYNC,
      available: describeSessionTools(ctx),
    },
  }
}

/**
 * The `codexSync` member of a parsed document, when it is a boolean.
 * @param body - whatever `JSON.parse` produced.
 * @returns the value, or `undefined` when the member is absent or not a boolean.
 */
function booleanField(body: unknown, key: string): boolean | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const value = (body as Record<string, unknown>)[key]
  return typeof value === 'boolean' ? value : undefined
}

/**
 * The `toolSet` member of a parsed request body, validated.
 * @param body - whatever `JSON.parse` produced.
 * @returns the choice, or `undefined` when the body does not name a valid one.
 */
function toolSetField(body: unknown): ToolSet | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const value = (body as Record<string, unknown>).toolSet
  return value === 'sessiongraph' || value === 'kernel' || value === 'both' ? value : undefined
}

/**
 * Read the persisted choice.
 *
 * Synchronously on purpose: this runs inside `apply`, where the choice must be in effect before the
 * first prompt is assembled, and one small file read is cheaper than deferring it. Every failure —
 * missing file, unreadable, malformed, unknown value — is "no persisted choice", never an error.
 * @param file - absolute path of the settings file.
 * @returns the persisted document, or `undefined` when there is no usable one.
 */
function readPanelFile(file: string): PanelFile | undefined {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const toolSet = toolSetField(parsed)
    if (toolSet === undefined) return undefined
    const updatedAt = (parsed as Record<string, unknown>).updatedAt
    const codexSync = booleanField(parsed, 'codexSync')
    return {
      toolSet,
      ...(codexSync === undefined ? {} : { codexSync }),
      updatedAt: typeof updatedAt === 'number' ? updatedAt : 0,
    }
  } catch {
    return undefined
  }
}

/**
 * The host filesystem seam, or undefined when this composition has none.
 *
 * This plugin deliberately does not `inject` `fs` — the panel is optional and must not add a
 * dependency to the tool's load path — so the lookup has to tolerate absence without throwing.
 * @param ctx - the plugin context.
 * @returns the seam when the host provides one.
 */
function optionalFsSeam(ctx: Context): FsSeam | undefined {
  try {
    return ctx.get('fs') as unknown as FsSeam | undefined
  } catch {
    return undefined
  }
}

/**
 * Persist the settings document, preferring the host's filesystem seam.
 *
 * The seam is the right backend when one exists (it owns read/write policy and atomic publication),
 * but this plugin does not inject `fs` — the panel is optional and must not add a dependency to the
 * tool's load path. So the seam is tried first and a plain synchronous write is the fallback, which
 * is also what makes the route work in a bare `node` host and in tests.
 * @param ctx - the plugin context.
 * @param file - absolute path of the settings file.
 * @param document - the document to write.
 * @returns whether the write succeeded.
 */
async function writePanelFile(ctx: Context, file: string, document: PanelFile): Promise<boolean> {
  const text = `${JSON.stringify(document, undefined, 2)}\n`
  // `ctx.<service>` on a Cordis context whose plugin does not inject that service THROWS rather
  // than reading as undefined, so a property access here escaped the fallback entirely and turned
  // every save into `cannot get property "fs" without inject`. `ctx.get(name)` is the safe read.
  const seam = optionalFsSeam(ctx)
  if (seam !== undefined && typeof seam.resolve === 'function' && typeof seam.writeText === 'function') {
    try {
      const target = await seam.resolve(file, { cwd: dirname(file) })
      await seam.writeText(target, text)
      return true
    } catch (error) {
      // Falls through to the plain write: the seam may be present but unable to reach a path outside
      // the workspace it was configured for, and the panel must still be able to save.
      console.warn('[sessiongraph] writing panel.json through ctx.fs failed; falling back to node:fs:', error)
    }
  }
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text, 'utf8')
    return true
  } catch (error) {
    console.warn('[sessiongraph] writing panel.json failed:', error)
    return false
  }
}

/**
 * Check that a save came from this panel's own page.
 *
 * Three checks, in increasing cost: the body must declare JSON (a cross-site HTML form cannot send
 * that media type without a preflight, which this route never answers, so the POST fails), an
 * `Origin` that is present must name this request's own host, and `Sec-Fetch-Site` that is present
 * must say same-origin or none. Absent `Origin` / `Sec-Fetch-Site` are allowed: a non-browser client
 * (the tests, curl, a script) sends neither, and the JSON media type is already something a foreign
 * page cannot produce without a preflight.
 * @param req - the request to judge.
 * @returns the refusal, or `undefined` when the save may proceed.
 */
function writeRejection(req: PanelRequest): WriteRejection | undefined {
  if (!declaresJsonBody(req.headers)) {
    return { code: 400, message: '保存请求必须带 content-type: application/json' }
  }
  const origin = headerValue(req.headers, 'origin')
  if (origin !== undefined && !isSameOrigin(origin, headerValue(req.headers, 'host'))) {
    return { code: 403, message: '跨源页面不能修改面板设置' }
  }
  const site = headerValue(req.headers, 'sec-fetch-site')
  if (site !== undefined && !SAME_ORIGIN_FETCH_SITES.has(site.trim().toLowerCase())) {
    return { code: 403, message: '跨源页面不能修改面板设置' }
  }
  return undefined
}

/**
 * Read one request header, tolerating either case in the header bag.
 * @param headers - the request's headers, when the host supplied them.
 * @param name - lowercase header name to find.
 * @returns the first value sent for that name, or `undefined` when it was absent.
 */
function headerValue(headers: PanelRequest['headers'], name: string): string | undefined {
  if (headers === undefined) return undefined
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue
    return typeof value === 'string' ? value : value?.[0]
  }
  return undefined
}

/**
 * Whether the request declares a JSON body. Only the media type matters; parameters such as
 * `charset=utf-8` are expected and ignored.
 * @param headers - the request's headers.
 * @returns whether `content-type` names `application/json`.
 */
function declaresJsonBody(headers: PanelRequest['headers']): boolean {
  const value = headerValue(headers, 'content-type')
  if (value === undefined) return false
  return (value.split(';')[0] ?? '').trim().toLowerCase() === 'application/json'
}

/**
 * Whether an `Origin` names the host this request was addressed to.
 *
 * A page opened at 127.0.0.1:PORT, localhost:PORT or a LAN address sends its own address as
 * `Origin`, while the request's `Host` is the very address it dialled: the two are strings for the
 * same host and port, so equality is the standard same-origin test and needs no list of names the
 * host might bind. A page from another origin sends its own address while `Host` stays this host,
 * so the two differ. Comparing the port too is what separates two panels on one machine.
 *
 * Equality alone is not enough: a page whose *domain* resolves to this machine (the DNS-rebinding
 * attack) also sends matching `Origin` and `Host`, because both carry that domain. The host half is
 * therefore required to be a literal address or `localhost` — see {@link isLiteralHostname}.
 * @param origin - the `Origin` header value.
 * @param host - the `Host` header value, when the request carried one.
 * @returns whether the origin is this request's own host.
 */
function isSameOrigin(origin: string, host: string | undefined): boolean {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    // `null` — the serialized origin of a sandboxed frame or a file URL — is foreign, not unknown.
    return false
  }
  if (host !== undefined) {
    const named = host.trim().toLowerCase()
    return parsed.host.toLowerCase() === named && isLiteralHostname(named)
  }
  // No `Host` (an HTTP/1.0 probe): fall back to the loopback names, the conservative reading of
  // "this machine". WHATWG keeps IPv6 brackets in `hostname`, so strip them before comparing.
  return LOOPBACK_HOSTNAMES.has(parsed.hostname.replace(/^\[|\]$/gu, '').toLowerCase())
}

/**
 * The hostname half of a `Host` header value, port removed.
 *
 * A bracketed IPv6 literal is taken through its closing bracket, so its colons are not read as a
 * port separator; anything else ends at the first colon.
 * @param host - the `Host` header value.
 * @returns its hostname, brackets kept for IPv6.
 */
function hostnameOf(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end === -1 ? host : host.slice(0, end + 1)
  }
  const colon = host.indexOf(':')
  return colon === -1 ? host : host.slice(0, colon)
}

/**
 * Whether a `Host` header names an address rather than a domain.
 *
 * This is the DNS-rebinding guard. `Origin` equals `Host` for a page served from this machine, but
 * also for a page whose domain was pointed at this machine after the browser loaded it: the page's
 * origin never changes, and `Host` carries whatever name the browser dialled, so both read
 * `attacker.example` while the request actually reaches the panel. A browser cannot forge `Host`, so
 * requiring a literal address (or `localhost`) keeps loopback, LAN and IPv6 usable while a domain
 * name — the only thing an attacker can make resolve here — is refused.
 * @param host - the `Host` header value, port included.
 * @returns whether its hostname is an IPv4 or IPv6 literal, or `localhost`.
 */
function isLiteralHostname(host: string): boolean {
  const hostname = hostnameOf(host)
  if (hostname.startsWith('[')) return hostname.endsWith(']') && hostname.length > 2
  if (hostname === 'localhost') return true
  const parts = hostname.split('.')
  if (parts.length !== 4) return false
  return parts.every(part => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
}

/**
 * Read a JSON request body under the size cap.
 * @param req - the request to consume.
 * @returns the parsed value, or the one-line reason it cannot be used.
 */
async function readJsonBody(req: PanelRequest): Promise<BodyResult> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) return { ok: false, message: '请求体过大' }
    chunks.push(buffer)
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  } catch {
    return { ok: false, message: '请求体不是合法 JSON' }
  }
}

/**
 * Write one JSON answer.
 * @param res - the response to write.
 * @param result - status and body.
 */
function respond(res: PanelResponse, result: RouteResult): void {
  res.statusCode = result.code
  // The payload is live state the user just changed; a cached copy would be a lie.
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(result.body))
}

/**
 * Expand a configured index root: a leading `~` becomes the home directory, and a relative path is
 * resolved against the process working directory so the file path handed to node is always absolute.
 * Mirrors `index.ts`, which does not export its copy.
 * @param path - the configured path.
 * @returns the absolute path.
 */
function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return isAbsolute(path) ? path : resolve(path)
}
