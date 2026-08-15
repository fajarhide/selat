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
  type: 'string' | 'number' | 'boolean'
  description?: string
  required?: boolean
  enum?: string[]
  default?: string | number | boolean
  /** Upstream parameter name, when it differs from the one the agent sees. */
  param?: string
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
  | { style: 'id'; size: number; sizeParam: string; param: string; idPath?: string }

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
      const paging = pagingFor(manifest, tool)
      const cursor = readCursor(fail, paging, rawArgs)
      const request = buildRequest(manifest, tool, args, paging, cursor)

      const secret = ctx.accessToken ?? ''
      const res = await ctx.fetch(withKeyInQuery(request.url, manifest.auth, secret), {
        ...request.init,
        headers: {
          ...manifest.headers,
          ...authHeader(manifest.auth, secret),
          'x-request-id': ctx.requestId,
          ...(request.init.body ? { 'content-type': 'application/json' } : {}),
        },
      })

      return readResponse(manifest, tool, paging, cursor, res, fail)
    },

    mapError(err: unknown): GatewayError {
      if (err instanceof GatewayError) return err
      return fail('upstream_error', `${manifest.prefix} request failed`)
    },
  }
}

type Fail = (code: ErrorCode, message: string, retryAfter?: number) => GatewayError

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
    properties[name] = {
      type: def.type,
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

    const text = String(value)
    if (def.enum && !def.enum.includes(text)) {
      throw fail('invalid_arguments', `${name} must be one of ${def.enum.join(', ')}`)
    }
    out[name] = text
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

  // A cursor-style token was minted upstream, so this gateway has nothing to
  // check it against. A page number it did mint, so that one is checked.
  if (paging.style === 'cursor') return String(raw)

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
): { url: string; init: RequestInit } {
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
  const toQuery = method === 'GET' || method === 'DELETE'
  const put = (key: string, value: unknown) => {
    if (toQuery) query.set(key, String(value))
    else body[key] = value
  }

  for (const [name, def] of Object.entries(tool.args)) {
    if (inPath.has(name)) continue
    const value = args[name]
    if (value === undefined) continue
    put(def.param ?? name, value)
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
  const hasBody = !toQuery && Object.keys(body).length > 0

  return {
    url: `${manifest.baseUrl}${path}${search ? `?${search}` : ''}`,
    init: { method, ...(hasBody ? { body: JSON.stringify(body) } : {}) },
  }
}

async function readResponse(
  manifest: ProviderManifest,
  tool: ToolManifest,
  paging: Pagination | undefined,
  cursor: string | number | undefined,
  res: Response,
  fail: Fail,
): Promise<ToolResult> {
  const rules = manifest.errors ?? {}
  const failure = rules.bodyFailure

  // Parsed before the status is looked at, because Slack answers 200 with
  // {ok: false} and the status carries no signal at all.
  const body = res.ok ? await res.json() : failure ? await res.json().catch(() => undefined) : undefined

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
  // 402 is rare enough that the bare status is a puzzle, and specific enough
  // that it always means the same thing: the account is not paying for this
  // endpoint. Saying so saves the reader a search.
  if (res.status === 402) {
    throw fail('upstream_error', `${manifest.prefix} requires a paid plan for this endpoint`)
  }
  if (res.status === 429) {
    throw fail('rate_limited', `${manifest.prefix} asked us to slow down`, retryAfterFrom(res, rules))
  }
  if (!res.ok) throw fail('upstream_error', `${manifest.prefix} returned ${res.status}`)

  if (!paging || !tool.items) {
    return { content: project(body, tool.fields), nextCursor: null, hasMore: false }
  }

  const found = tool.items === '$' ? body : getPath(body, tool.items)
  const list = Array.isArray(found) ? found : []
  const items = list.map((item) => project(item, tool.fields))

  if (paging.style === 'page') {
    const hasMore = list.length === paging.size
    const page = typeof cursor === 'number' ? cursor : 1
    return { content: { items }, nextCursor: hasMore ? String(page + 1) : null, hasMore }
  }

  if (paging.style === 'id') {
    // Read off the raw item, because projection may well have dropped the id
    // this provider pages by.
    const hasMore = list.length === paging.size
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
