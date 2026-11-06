/**
 * The settings-page HTTP surface: `GET/POST /dsh-plugin-sessiongraph/api/tools`.
 *
 * Why this package owns the routes: the setting they edit is the very `toolSet` the model-facing
 * visibility layer reads, and the persisted file lives beside the index this package already knows
 * the root of. A separate host package would need that root and a second definition of the choice.
 *
 * The persisted file is `<indexRoot>/panel.json`, one JSON object. It is the settings page's own
 * storage, not an index artifact: it is read once at load (so a choice survives a restart) and
 * rewritten on every save, and a missing or unreadable file simply means "use the configured value"
 * — a broken panel must never stop the plugin from loading.
 *
 * The route table is deliberately tiny: a GET that reports the current choice plus which tools this
 * host actually registered, and a POST that validates one enum value, persists it, and re-applies it
 * to the live agents. Nothing here accepts a path, so there is no path-traversal surface at all.
 * @module dsh-plugin-sessiongraph-tool/panel
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from './index.ts'
import { describeSessionTools, getToolSet, normalizeToolSet, setToolSet } from './visibility.ts'
import type { AvailableSessionTools, ToolSet } from './visibility.ts'

/** Path prefix every panel route lives under. The browser client hardcodes the same string. */
export const PANEL_ROUTE_PREFIX = '/dsh-plugin-sessiongraph/api'

/** Name of the settings file inside the index root. */
export const PANEL_FILE_NAME = 'panel.json'

/**
 * Largest request body accepted by the save route, in bytes.
 *
 * The only body this API accepts is one JSON object with a single enum string, so 8 KiB is already
 * two orders of magnitude past the contract. The cap exists so a browser (or anything reaching the
 * port) cannot make the host buffer an unbounded request.
 */
const MAX_BODY_BYTES = 8 * 1024

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
      respond(res, currentResult(ctx))
      return
    }
    if (route === '/tools' && method === 'POST') {
      respond(res, await saveResult(ctx, file, req))
      return
    }
    respond(res, { code: 404, body: { ok: false, message: '未知的面板接口' } })
  } catch (error) {
    respond(res, { code: 500, body: { ok: false, message: String(error) } })
  }
}

/**
 * Build the `GET /tools` answer from live state rather than the file: a reload of the plugin can
 * have changed the effective choice without touching what is on disk.
 * @param ctx - the plugin context.
 * @returns the current choice and the tools this host registered.
 */
function currentResult(ctx: Context): RouteResult {
  return {
    code: 200,
    body: { ok: true, toolSet: getToolSet(ctx) ?? normalizeToolSet(undefined), available: describeSessionTools(ctx) },
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
  const document: PanelFile = { toolSet, updatedAt: Date.now() }
  const written = await writePanelFile(ctx, file, document)
  if (!written) return { code: 500, body: { ok: false, message: `无法写入 ${file}` } }
  setToolSet(ctx, toolSet)
  return {
    code: 200,
    body: { ok: true, toolSet, available: describeSessionTools(ctx) },
  }
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
    return { toolSet, updatedAt: typeof updatedAt === 'number' ? updatedAt : 0 }
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
  const seam = (ctx as unknown as { fs?: FsSeam }).fs
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
