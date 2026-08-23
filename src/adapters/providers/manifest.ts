import { GatewayError, type ErrorCode } from '../../domain/errors.ts'
import type { AdapterContext, Maturity, ProviderAdapter, ToolDef, ToolResult } from './registry.ts'

/**
 * Closed on purpose: the executor branches on the method to decide whether
 * unmatched arguments become a query string or a JSON body, so an unrecognised
 * one would silently take the query path instead of failing.
 */
export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

/**
 * Nine of every ten providers in the widest catalog anyone has built take an
 * API key rather than an OAuth grant, so bearer alone locks most of the
 * addressable surface out by construction. The two shapes differ only in where
 * the secret is written, which is data.
 */
export type AuthScheme =
  | { type: 'bearer' }
  | {
      type: 'api_key'
      /** Where the key travels. */
      in: 'header' | 'query'
      /** Header or query parameter name, for example authorization or api_key. */
      name: string
      /** Written before the key. Discord bots want "Bot ", including the space. */
      prefix?: string
    }

export type ArgDef = {
  type: 'string' | 'number' | 'boolean' | 'string[]' | 'base64'
  description?: string
  required?: boolean
  enum?: string[]
  default?: string | number | boolean
  /**
   * Upstream parameter name, when it differs from the one the agent sees.
   * In a query string it is a literal key, dots included, because X really
   * does call one `tweet.fields`. In a JSON body it is a dotted path, because
   * X really does nest a reply as {reply: {in_reply_to_tweet_id}}.
   */
  param?: string
  /**
   * Where the argument travels. Defaults to the method rule: the query string
   * on a GET or a DELETE, the JSON body otherwise. Drive moves a file with
   * addParents and removeParents in the query of a PATCH, which the method
   * alone cannot express.
   */
  in?: 'query' | 'body'
}

export type Pagination =
  | { style: 'page'; size: number; sizeParam: string; pageParam: string }
  | {
      style: 'cursor'
      size?: number
      sizeParam?: string
      param: string
      nextPath: string
      hasMorePath?: string
    }
  /**
   * The response carries no cursor at all and the caller is expected to ask
   * for what came before the last id it holds. Discord pages this way, and so
   * does anything modelled on a snowflake id.
   */
  | {
      style: 'id'
      size: number
      sizeParam: string
      param: string
      idPath?: string
      /** Dotted path to the vendor's own answer. Without it the executor infers
       *  from page fullness, which is wrong whenever a last page is exactly
       *  full: the caller is told there is more and finds nothing. */
      hasMorePath?: string
    }

export type ErrorRules = {
  /** What a bare 403 means here. Defaults to reauth_required, which is right
   *  for a vendor that answers 403 for a revoked credential. Google is not
   *  one: it answers 401 for that, and keeps 403 for things reconnecting
   *  cannot fix, such as an API that was never enabled. */
  forbidden?: ErrorCode
  rateLimited?: { status: number; header: string; equals: string }
  retryAfter?: { header: string; as: 'seconds' | 'epoch' }[]
  bodyFailure?: {
    path: string
    equals: unknown
    codeFrom: string
    codes: Record<string, ErrorCode>
  }
}

export type ToolManifest = {
  name: string
  description: string
  write: boolean
  /** "GET /repos/{owner}/{repo}/issues". The template literal keeps the method
   *  under the typechecker, so "FETCH /x" does not compile. */
  request: `${Method} /${string}`
  args: Record<string, ArgDef>
  /** Overrides the provider's pagination for this tool. Rarely needed, but
   *  Slack pages some methods by cursor and others by number. */
  pagination?: Pagination
  /** Dotted path to the array of items, "$" when the response is the array.
   *  Presence is what makes a tool paginated. */
  items?: string
  /** Dotted paths kept in the result. Absent returns the response whole. */
  fields?: string[]
  /**
   * The argument that carries the upstream's own field selector. When a caller
   * sets it, `fields` is skipped: the upstream has already narrowed the
   * response to exactly what was asked for, and projecting again can only take
   * away fields the caller named on purpose.
   */
  selector?: string
  /** The request carries bytes. The named arguments are pulled out of the
   *  JSON body and sent as a multipart/related upload instead, which is how
   *  one call can carry a file's metadata and its contents together. */
  upload?: {
    content: string
    mimeType: string
    /** The argument that names a file the gateway already holds, so bytes it
     *  produced can go back out without passing through the model that asked
     *  for them. */
    fileId?: string
  }
  /** The response carries bytes, not JSON. The result is {mime_type, size,
   *  data} with data base64, and fields and pagination do not apply. Drive
   *  answers files.get?alt=media and files.export this way. */
  binary?: boolean
}

export type ProviderManifest = {
  id: string
  prefix: string
  /** Defaults to `id`. Set it when one OAuth application backs several
   *  prefixes, the way a single google grant backs gmail and gdrive. */
  grantId?: string
  maturity: Maturity
  baseUrl: string
  scopes: string[]
  auth: AuthScheme
  /** Merged under the headers the executor sets, never over them. */
  headers?: Record<string, string>
  pagination?: Pagination
  errors?: ErrorRules
  tools: ToolManifest[]
}

const PLACEHOLDER = /\{(\w+)\}/g
/** A refusal, not a budget. Anything past the inline limit is stored and
 *  answered as a reference by the application layer, so this only has to stop a
 *  single response from being held whole in memory.
 *  ponytail: one number for every provider, split per tool if one earns it. */
const MAX_BINARY_BYTES = 25 * 1024 * 1024
const CURSOR_DESCRIPTION = 'Opaque cursor from a previous page'
const DEFAULT_RETRY_AFTER = 60

export function manifestProvider(manifest: ProviderManifest): ProviderAdapter {
  const byName = new Map(manifest.tools.map((tool) => [tool.name, tool]))
  for (const tool of manifest.tools) assertPathIsFillable(tool)

  const fail = (code: ErrorCode, message: string, retryAfter?: number) =>
    new GatewayError(code, message, {
      provider: manifest.prefix,
      ...(retryAfter === undefined ? {} : { retryAfter }),
    })

  return {
    id: manifest.id,
    prefix: manifest.prefix,
    grantId: manifest.grantId ?? manifest.id,
    maturity: manifest.maturity,
    scopes: manifest.scopes,
    credential: manifest.auth.type === 'api_key' ? 'api_key' : 'oauth',
    listTools: () => manifest.tools.map(toolDef),

    async callTool(ctx: AdapterContext, name: string, rawArgs: unknown): Promise<ToolResult> {
      const tool = byName.get(name)
      if (!tool) throw fail('tool_not_found', `${manifest.prefix} has no tool ${name}`)

      const args = validate(fail, tool, rawArgs)
      await resolveFileArgument(ctx, tool, args, fail)
      const paging = pagingFor(manifest, tool)
      const cursor = readCursor(fail, paging, rawArgs)
      // The default does not count. Only a value the caller actually sent means
      // they chose the shape of the response.
      const chose =
        tool.selector !== undefined &&
        (rawArgs as Record<string, unknown> | null)?.[tool.selector] !== undefined
      const request = buildRequest(manifest, tool, args, paging, cursor)

      const secret = ctx.accessToken ?? ''
      const res = await followRedirects(
        ctx.fetch,
        fail,
        manifest.auth,
        withKeyInQuery(request.url, manifest.auth, secret),
        {
          ...request.init,
          headers: {
            ...manifest.headers,
            ...authHeader(manifest.auth, secret),
            'x-request-id': ctx.requestId,
            ...(request.contentType ? { 'content-type': request.contentType } : {}),
          },
        },
      )

      return readResponse(manifest, tool, paging, cursor, res, fail, chose)
    },

    mapError(err: unknown): GatewayError {
      if (err instanceof GatewayError) return err
      return fail('upstream_error', `${manifest.prefix} request failed`)
    },
  }
}

type Fail = (code: ErrorCode, message: string, retryAfter?: number) => GatewayError

const MAX_HOPS = 5

/**
 * Redirects are followed here rather than by fetch, for one reason: a redirect
 * to another origin must not carry our credential to it. Left to the default,
 * the Authorization header travels to wherever the upstream points, and the
 * only thing stopping that being a leak today is that every base URL in the
 * registry is a constant this project chose.
 *
 * Cross-origin redirects are followed, not refused, because they are ordinary:
 * a Drive download answers with one to googleusercontent.com, and that target
 * carries its own signature and needs no header from us.
 *
 * Only GET and HEAD follow. Anything with a body is returned as it came, so a
 * write is never replayed against an address the upstream picked.
 */
async function followRedirects(
  doFetch: typeof fetch,
  fail: Fail,
  auth: AuthScheme,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase()
  let current = url
  let headers = { ...(init.headers as Record<string, string>) }

  for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
    const res = await doFetch(current, { ...init, headers, redirect: 'manual' })
    const location = res.headers.get('location')
    if (!isRedirect(res.status) || !location) return res
    if (method !== 'GET' && method !== 'HEAD') return res

    const next = new URL(location, current)
    if (new URL(current).origin !== next.origin) headers = withoutCredentials(headers, auth)
    current = next.toString()
  }
  throw fail('upstream_error', `more than ${MAX_HOPS} redirects from ${new URL(url).host}`)
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/** Both places a secret can travel in a header: the bearer, and whatever an
 *  api_key provider named. Matched case-insensitively, because a header name
 *  is. */
function withoutCredentials(
  headers: Record<string, string>,
  auth: AuthScheme,
): Record<string, string> {
  const drop = new Set(['authorization'])
  if (auth.type === 'api_key' && auth.in === 'header') drop.add(auth.name.toLowerCase())
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !drop.has(name.toLowerCase())),
  )
}

/** Merged over any static manifest header, so a manifest cannot make itself a
 *  way to send somebody else's credential. */
function authHeader(auth: AuthScheme, secret: string): Record<string, string> {
  if (auth.type === 'bearer') return { authorization: `Bearer ${secret}` }
  if (auth.in === 'header') return { [auth.name]: `${auth.prefix ?? ''}${secret}` }
  return {}
}

function withKeyInQuery(url: string, auth: AuthScheme, secret: string): string {
  if (auth.type !== 'api_key' || auth.in !== 'query') return url
  // A key in the query string ends up in vendor access logs, which is the
  // vendor's choice and not ours. Nothing here writes it anywhere else.
  const parsed = new URL(url)
  parsed.searchParams.set(auth.name, `${auth.prefix ?? ''}${secret}`)
  return parsed.toString()
}

/**
 * Turns a file id into the bytes and media type the upload path expects, so a
 * download and an upload can be joined without either set of bytes reaching the
 * caller. Resolved before buildRequest because that one is synchronous, and
 * because an argument that names something is not the same as one that is it.
 */
async function resolveFileArgument(
  ctx: AdapterContext,
  tool: ToolManifest,
  args: Record<string, unknown>,
  fail: Fail,
): Promise<void> {
  const upload = tool.upload
  if (!upload?.fileId) return

  const id = args[upload.fileId]
  if (id === undefined) {
    if (args[upload.content] === undefined) {
      throw fail('invalid_arguments', `give either ${upload.content} or ${upload.fileId}`)
    }
    return
  }
  if (args[upload.content] !== undefined) {
    throw fail('invalid_arguments', `give ${upload.content} or ${upload.fileId}, not both`)
  }
  if (!ctx.readFile) {
    throw fail('invalid_arguments', `${upload.fileId} is not available on this deployment`)
  }

  const found = await ctx.readFile(ctx.workspaceId, String(id))
  if (!found) throw fail('invalid_arguments', 'no such file, or it expired')

  args[upload.content] = found.bytes.toString('base64')
  // An explicit media type wins: the caller may be uploading a converted form
  // of what was downloaded.
  if (args[upload.mimeType] === undefined) args[upload.mimeType] = found.mimeType
  delete args[upload.fileId]
}

function pagingFor(manifest: ProviderManifest, tool: ToolManifest): Pagination | undefined {
  return tool.items ? (tool.pagination ?? manifest.pagination) : undefined
}

/** A placeholder with no required argument behind it would build a URL with a
 *  hole in it, so it is a manifest defect and it fails at boot. */
function assertPathIsFillable(tool: ToolManifest): void {
  for (const match of tool.request.matchAll(PLACEHOLDER)) {
    const name = match[1] as string
    if (!tool.args[name]?.required) {
      throw new Error(`${tool.name}: {${name}} in the path needs a required argument of that name`)
    }
  }
}

function toolDef(tool: ToolManifest): ToolDef {
  const properties: Record<string, object> = {}
  const required: string[] = []
  for (const [name, def] of Object.entries(tool.args)) {
    const shape =
      def.type === 'string[]'
        ? { type: 'array', items: { type: 'string' } }
        : { type: def.type === 'base64' ? 'string' : def.type }
    properties[name] = {
      ...shape,
      ...(def.description ? { description: def.description } : {}),
      ...(def.enum ? { enum: def.enum } : {}),
      ...(def.default === undefined ? {} : { default: def.default }),
    }
    if (def.required) required.push(name)
  }
  // Never written by hand, which is what stops one provider breaking the
  // pagination contract on its own.
  if (tool.items) properties.cursor = { type: 'string', description: CURSOR_DESCRIPTION }

  return {
    name: tool.name,
    description: tool.description,
    write: tool.write,
    inputSchema: {
      type: 'object',
      properties,
      ...(required.length ? { required } : {}),
    },
  }
}

function validate(fail: Fail, tool: ToolManifest, rawArgs: unknown): Record<string, unknown> {
  const given = (rawArgs ?? {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}

  for (const [name, def] of Object.entries(tool.args)) {
    const raw = given[name]
    const value = raw === undefined || raw === null || raw === '' ? def.default : raw
    if (value === undefined) {
      if (def.required) throw fail('invalid_arguments', `${name} is required`)
      continue
    }

    if (def.type === 'number') {
      const num = Number(value)
      if (!Number.isFinite(num)) throw fail('invalid_arguments', `${name} must be a number`)
      out[name] = num
      continue
    }
    if (def.type === 'boolean') {
      if (typeof value === 'boolean') out[name] = value
      else if (value === 'true' || value === 'false') out[name] = value === 'true'
      else throw fail('invalid_arguments', `${name} must be a boolean`)
      continue
    }

    const oneOf = (item: unknown): string => {
      const text = String(item)
      if (def.enum && !def.enum.includes(text)) {
        throw fail('invalid_arguments', `${name} must be one of ${def.enum.join(', ')}`)
      }
      return text
    }

    if (def.type === 'base64') {
      const text = String(value).replace(/\s/g, '')
      // Buffer.from ignores anything outside the alphabet rather than failing,
      // so a mistyped payload would upload as silent garbage without this.
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
        throw fail('invalid_arguments', `${name} must be base64`)
      }
      out[name] = text
      continue
    }

    // A bare value is taken as a one-element list, because an agent handed one
    // label writes "bug" about as often as ["bug"].
    if (def.type === 'string[]') {
      out[name] = (Array.isArray(value) ? value : [value]).map(oneOf)
      continue
    }

    out[name] = oneOf(value)
  }

  return out
}

function readCursor(
  fail: Fail,
  paging: Pagination | undefined,
  rawArgs: unknown,
): string | number | undefined {
  if (!paging) return undefined
  const raw = ((rawArgs ?? {}) as Record<string, unknown>).cursor
  if (raw === undefined || raw === null || raw === '') return undefined

  // A token minted upstream is not ours to validate: a cursor is opaque, and an
  // id style pages by the id of the last object seen, which is a string like
  // cus_24. Only a page number was minted here, so only that one is checked.
  if (paging.style === 'cursor' || paging.style === 'id') return String(raw)

  const page = Number(raw)
  if (!Number.isInteger(page) || page < 1) {
    throw fail('invalid_arguments', 'cursor is not a cursor this provider issued')
  }
  return page
}

function buildRequest(
  manifest: ProviderManifest,
  tool: ToolManifest,
  args: Record<string, unknown>,
  paging: Pagination | undefined,
  cursor: string | number | undefined,
): { url: string; init: RequestInit; contentType?: string } {
  const space = tool.request.indexOf(' ')
  const method = tool.request.slice(0, space) as Method
  const template = tool.request.slice(space + 1)

  const inPath = new Set<string>()
  const path = template.replace(PLACEHOLDER, (_match, name: string) => {
    inPath.add(name)
    // Every segment escaped, so an owner of "../../orgs" cannot walk out of
    // the endpoint the manifest declared.
    return encodeURIComponent(String(args[name]))
  })

  const query = new URLSearchParams()
  const body: Record<string, unknown> = {}
  const byMethod = method === 'GET' || method === 'DELETE' ? 'query' : 'body'
  const put = (key: string, value: unknown, where: 'query' | 'body' = byMethod) => {
    if (where === 'body') setPath(body, key, value)
    // Comma-joined, the form Drive documents for addParents. A vendor that
    // wants ?k=a&k=b repeated instead will need that choice on the ArgDef.
    else query.set(key, Array.isArray(value) ? value.join(',') : String(value))
  }

  for (const [name, def] of Object.entries(tool.args)) {
    if (inPath.has(name)) continue
    if (name === tool.upload?.content || name === tool.upload?.mimeType) continue
    const value = args[name]
    if (value === undefined) continue
    put(def.param ?? name, value, def.in)
  }

  if (paging?.style === 'page') {
    put(paging.sizeParam, paging.size)
    put(paging.pageParam, cursor ?? 1)
  } else if (paging?.style === 'cursor') {
    if (paging.size !== undefined && paging.sizeParam) put(paging.sizeParam, paging.size)
    if (cursor !== undefined) put(paging.param, cursor)
  } else if (paging?.style === 'id') {
    put(paging.sizeParam, paging.size)
    if (cursor !== undefined) put(paging.param, cursor)
  }

  const search = query.toString()
  const url = `${manifest.baseUrl}${path}${search ? `?${search}` : ''}`

  if (tool.upload) {
    const media = Buffer.from(String(args[tool.upload.content] ?? ''), 'base64')
    const type = String(args[tool.upload.mimeType] ?? 'application/octet-stream')
    // multipart/related is Drive's own upload shape: the metadata first as
    // JSON, the bytes second under their own media type. A vendor that wants
    // something else will need a second mode here.
    const boundary = `selat-${crypto.randomUUID()}`
    const head = Buffer.from(
      `--${boundary}\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(body)}\r\n` +
        `--${boundary}\r\ncontent-type: ${type}\r\n\r\n`,
    )
    return {
      url,
      init: { method, body: Buffer.concat([head, media, Buffer.from(`\r\n--${boundary}--`)]) },
      contentType: `multipart/related; boundary=${boundary}`,
    }
  }

  const hasBody = Object.keys(body).length > 0
  return {
    url,
    init: { method, ...(hasBody ? { body: JSON.stringify(body) } : {}) },
    ...(hasBody ? { contentType: 'application/json' } : {}),
  }
}

/** Not res.json(): a 204 carries no body at all, which json() reads as a
 *  syntax error. Drive answers a delete that way. */
async function readOk(tool: ToolManifest, res: Response): Promise<unknown> {
  if (tool.binary) return undefined
  const text = await res.text()
  return text ? JSON.parse(text) : {}
}

async function binaryResult(fail: Fail, prefix: string, res: Response): Promise<ToolResult> {
  const tooBig = (size: number) =>
    fail(
      'invalid_arguments',
      `${prefix} returned ${size} bytes, over the ${MAX_BINARY_BYTES} this gateway will carry. ` +
        'Export a smaller format, or open the file by its link instead.',
    )

  // Checked before the body is pulled, so a large file is refused without
  // being held in memory first. Not every upstream declares it.
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BINARY_BYTES) throw tooBig(declared)

  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length > MAX_BINARY_BYTES) throw tooBig(bytes.length)

  return {
    content: {
      mime_type: (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0],
      size: bytes.length,
      data: bytes.toString('base64'),
    },
    binary: true,
    nextCursor: null,
    hasMore: false,
  }
}

async function readResponse(
  manifest: ProviderManifest,
  tool: ToolManifest,
  paging: Pagination | undefined,
  cursor: string | number | undefined,
  res: Response,
  fail: Fail,
  callerChoseFields = false,
): Promise<ToolResult> {
  const rules = manifest.errors ?? {}
  const failure = rules.bodyFailure

  // Parsed before the status is looked at, because Slack answers 200 with
  // {ok: false} and the status carries no signal at all.
  // Read once, whatever the outcome. On a failure the text is the only thing
  // that says why, and a Response body cannot be read twice.
  const failureText = res.ok ? undefined : await res.text().catch(() => '')
  const body = res.ok
    ? await readOk(tool, res)
    : ((): unknown => {
        try {
          return JSON.parse(failureText ?? '')
        } catch {
          return undefined
        }
      })()

  if (failure && getPath(body, failure.path) === failure.equals) {
    const raw = getPath(body, failure.codeFrom)
    const code = (typeof raw === 'string' ? failure.codes[raw] : undefined) ?? 'upstream_error'
    throw fail(
      code,
      `${manifest.prefix} returned ${typeof raw === 'string' ? raw : 'a failure'}`,
      code === 'rate_limited' ? retryAfterFrom(res, rules) : undefined,
    )
  }

  const limit = rules.rateLimited
  if (limit && res.status === limit.status && res.headers.get(limit.header) === limit.equals) {
    throw fail('rate_limited', `${manifest.prefix} rate limit reached`, retryAfterFrom(res, rules))
  }
  if (res.status === 401) {
    throw fail('reauth_required', `${manifest.prefix} rejected the credential`)
  }
  if (res.status === 403) {
    const code = rules.forbidden ?? 'reauth_required'
    throw fail(
      code,
      code === 'reauth_required'
        ? `${manifest.prefix} rejected the credential`
        : `${manifest.prefix} refused the request, and reconnecting will not help`,
    )
  }
  // 402 is rare enough that the bare status is a puzzle. It is not specific
  // enough to name a cause though: X answers it both for an unpurchased tier
  // and for an allowance that ran out, and telling someone to upgrade when
  // their quota merely reset is the same wrong turn a 403 read as reauth was.
  if (res.status === 402) {
    throw fail(
      'upstream_error',
      `${manifest.prefix} refused this call over billing or quota, which reconnecting will not fix`,
    )
  }
  if (res.status === 429) {
    throw fail('rate_limited', `${manifest.prefix} asked us to slow down`, retryAfterFrom(res, rules))
  }
  if (!res.ok) {
    // The status alone sends the reader back to the vendor's console to guess.
    // Bounded so an HTML error page cannot flood one log line.
    const reason = (failureText ?? '').trim().slice(0, 400)
    throw fail(
      'upstream_error',
      reason
        ? `${manifest.prefix} returned ${res.status}: ${reason}`
        : `${manifest.prefix} returned ${res.status}`,
    )
  }

  const keep = (value: unknown) => (callerChoseFields ? value : project(value, tool.fields))

  if (tool.binary) return binaryResult(fail, manifest.prefix, res)

  if (!paging || !tool.items) {
    return { content: keep(body), nextCursor: null, hasMore: false }
  }

  const found = tool.items === '$' ? body : getPath(body, tool.items)
  const list = Array.isArray(found) ? found : []
  const items = list.map((item) => keep(item))

  if (paging.style === 'page') {
    const hasMore = list.length === paging.size
    const page = typeof cursor === 'number' ? cursor : 1
    return { content: { items }, nextCursor: hasMore ? String(page + 1) : null, hasMore }
  }

  if (paging.style === 'id') {
    // Read off the raw item, because projection may well have dropped the id
    // this provider pages by.
    const hasMore = paging.hasMorePath
      ? Boolean(getPath(body, paging.hasMorePath))
      : list.length === paging.size
    const last = list[list.length - 1]
    const next = hasMore ? getPath(last, paging.idPath ?? 'id') : undefined
    const token = typeof next === 'string' || typeof next === 'number' ? String(next) : null
    return { content: { items }, nextCursor: token, hasMore: token !== null }
  }

  const next = getPath(body, paging.nextPath)
  const token = typeof next === 'string' && next !== '' ? next : null
  // Notion says so outright; Slack's next_cursor is "" on the last page.
  const hasMore = paging.hasMorePath ? Boolean(getPath(body, paging.hasMorePath)) : token !== null
  return { content: { items }, nextCursor: hasMore ? token : null, hasMore }
}

function retryAfterFrom(res: Response, rules: ErrorRules): number {
  for (const rule of rules.retryAfter ?? []) {
    const raw = Number(res.headers.get(rule.header))
    if (!Number.isFinite(raw) || raw <= 0) continue
    const seconds = rule.as === 'epoch' ? Math.ceil(raw - Date.now() / 1000) : raw
    if (seconds > 0) return seconds
  }
  return DEFAULT_RETRY_AFTER
}

/** Copies only the keys the upstream actually returned. A declared field that
 *  is absent is left out rather than set to null, which is both cheaper for an
 *  agent's context and what the existing GitHub test asserts. */
function project(value: unknown, fields?: string[]): unknown {
  if (!fields || value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const field of fields) {
    const found = getPath(value, field)
    if (found !== undefined) setPath(out, field, found)
  }
  return out
}

function getPath(source: unknown, path: string): unknown {
  if (path === '$') return source
  let node: unknown = source
  for (const part of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return node
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  const last = parts.pop() as string
  let node = target
  for (const part of parts) {
    const existing = node[part]
    if (existing === null || typeof existing !== 'object') node[part] = {}
    node = node[part] as Record<string, unknown>
  }
  node[last] = value
}
