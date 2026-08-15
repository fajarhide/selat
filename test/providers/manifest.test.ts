import { describe, expect, it } from 'vitest'
import { manifestProvider, type ProviderManifest } from '../../src/adapters/providers/manifest.ts'
import { fakeUpstream, itemsPage, type FakeUpstream } from '../helpers/fake-upstream.ts'

function ctx(upstream: FakeUpstream) {
  return {
    workspaceId: 'ws-1',
    requestId: 'req-1',
    accessToken: 'secret-token',
    fetch: upstream.fetch,
  }
}

const base: ProviderManifest = {
  id: 'demo',
  prefix: 'demo',
  maturity: 'experimental',
  baseUrl: 'https://api.demo.test',
  scopes: ['read'],
  auth: { type: 'bearer' },
  headers: { accept: 'application/demo+json' },
  pagination: { style: 'page', size: 2, sizeParam: 'per_page', pageParam: 'page' },
  tools: [
    {
      name: 'list_things',
      description: 'List the things inside one box',
      write: false,
      request: 'GET /boxes/{box}/things',
      args: {
        box: { type: 'string', required: true },
        state: { type: 'string', enum: ['open', 'closed'], default: 'open' },
        term: { type: 'string', param: 'q' },
      },
      items: '$',
      fields: ['id', 'owner.login'],
    },
    {
      name: 'create_thing',
      description: 'Create one thing inside a box',
      write: true,
      request: 'POST /boxes/{box}/things',
      args: {
        box: { type: 'string', required: true },
        title: { type: 'string', required: true },
        count: { type: 'number' },
        pinned: { type: 'boolean' },
      },
      fields: ['id', 'title'],
    },
    {
      name: 'get_raw',
      description: 'Fetch one thing without any projection',
      write: false,
      request: 'GET /things/{id}',
      args: { id: { type: 'number', required: true } },
    },
  ],
}

function withTools(tools: ProviderManifest['tools'], over: Partial<ProviderManifest> = {}) {
  return manifestProvider({ ...base, ...over, tools })
}

const demo = manifestProvider(base)

describe('manifest executor: requests', () => {
  it('fills path placeholders and escapes every segment', async () => {
    const upstream = fakeUpstream([{ match: /boxes/, body: itemsPage(1) }])
    await demo.callTool(ctx(upstream), 'list_things', { box: '../../admin' })
    expect(upstream.calls[0]?.url).not.toContain('/admin/')
    expect(upstream.calls[0]?.url).toContain('%2F')
  })

  it('sends declared arguments as a query string on GET, under their upstream name', async () => {
    const upstream = fakeUpstream([{ match: /boxes/, body: itemsPage(1) }])
    await demo.callTool(ctx(upstream), 'list_things', { box: 'b', term: 'hello' })
    const url = upstream.calls[0]?.url ?? ''
    expect(url).toContain('q=hello')
    expect(url).not.toContain('term=')
    expect(url).toContain('state=open')
  })

  it('sends declared arguments as a JSON body on POST, with no pagination noise', async () => {
    const upstream = fakeUpstream([{ match: /boxes/, body: { id: 1, title: 't' } }])
    await demo.callTool(ctx(upstream), 'create_thing', { box: 'b', title: 't', count: '4' })
    const call = upstream.calls[0]
    expect(call?.url).not.toContain('?')
    expect(JSON.parse(String(call?.init?.body))).toEqual({ title: 't', count: 4 })
    expect((call?.init?.headers as Record<string, string>)['content-type']).toBe('application/json')
  })

  it('merges manifest headers under the ones the executor owns', async () => {
    // A manifest that tries to set authorization must lose to the real
    // credential, or a provider file becomes a way to send someone else's.
    const overreaching = manifestProvider({
      ...base,
      headers: { accept: 'application/demo+json', authorization: 'Bearer manifest-wins' },
    })
    const upstream = fakeUpstream([{ match: /things/, body: {} }])
    await overreaching.callTool(ctx(upstream), 'get_raw', { id: 1 })
    const headers = upstream.calls[0]?.init?.headers as Record<string, string>
    expect(headers.accept).toBe('application/demo+json')
    expect(headers.authorization).toBe('Bearer secret-token')
    expect(headers['x-request-id']).toBe('req-1')
    expect(headers['content-type']).toBeUndefined()
  })

  it('refuses a manifest whose path placeholder has no required argument', () => {
    expect(() =>
      withTools([
        {
          name: 'broken',
          description: 'A tool with a hole in its path',
          write: false,
          request: 'GET /boxes/{box}',
          args: { box: { type: 'string' } },
        },
      ]),
    ).toThrow(/\{box\}/)
  })
})

describe('manifest executor: arguments', () => {
  it('rejects a missing required argument', async () => {
    const upstream = fakeUpstream([{ match: /boxes/, body: itemsPage(1) }])
    await expect(demo.callTool(ctx(upstream), 'list_things', {})).rejects.toMatchObject({
      code: 'invalid_arguments',
    })
  })

  it('rejects a value outside a declared enum', async () => {
    const upstream = fakeUpstream([{ match: /boxes/, body: itemsPage(1) }])
    await expect(
      demo.callTool(ctx(upstream), 'list_things', { box: 'b', state: 'sideways' }),
    ).rejects.toMatchObject({ code: 'invalid_arguments' })
  })

  it('rejects a number argument that is not a number', async () => {
    const upstream = fakeUpstream([{ match: /things/, body: {} }])
    await expect(demo.callTool(ctx(upstream), 'get_raw', { id: 'seven' })).rejects.toMatchObject({
      code: 'invalid_arguments',
    })
  })

  it('derives the tool schema from args, adding cursor only to paginated tools', () => {
    const tools = demo.listTools()
    const list = tools.find((tool) => tool.name === 'list_things')?.inputSchema as {
      properties: Record<string, { type: string; enum?: string[]; default?: string }>
      required: string[]
    }
    expect(list.required).toEqual(['box'])
    expect(list.properties.state?.enum).toEqual(['open', 'closed'])
    expect(list.properties.state?.default).toBe('open')
    expect(list.properties.cursor?.type).toBe('string')

    const raw = tools.find((tool) => tool.name === 'get_raw')?.inputSchema as {
      properties: Record<string, object>
    }
    expect(raw.properties.cursor).toBeUndefined()
  })
})

describe('manifest executor: projection', () => {
  it('keeps declared fields, including dotted ones, and drops everything else', async () => {
    const upstream = fakeUpstream([
      {
        match: /boxes/,
        body: [{ id: 1, secret: 'secret-token', owner: { login: 'ada', email: 'a@b.test' } }],
      },
    ])
    const result = await demo.callTool(ctx(upstream), 'list_things', { box: 'b' })
    expect(result.content).toEqual({ items: [{ id: 1, owner: { login: 'ada' } }] })
    expect(JSON.stringify(result)).not.toContain('secret-token')
  })

  it('omits a declared field the upstream did not return rather than writing null', async () => {
    const upstream = fakeUpstream([{ match: /boxes/, body: { id: 9 } }])
    const result = await demo.callTool(ctx(upstream), 'create_thing', { box: 'b', title: 't' })
    expect(result.content).toEqual({ id: 9 })
  })

  it('returns the upstream response whole when a tool declares no fields', async () => {
    const upstream = fakeUpstream([{ match: /things/, body: { id: 1, anything: { deep: true } } }])
    const result = await demo.callTool(ctx(upstream), 'get_raw', { id: 1 })
    expect(result.content).toEqual({ id: 1, anything: { deep: true } })
  })
})

describe('manifest executor: pagination', () => {
  it('advances a page cursor only when a full page came back', async () => {
    const full = fakeUpstream([{ match: /boxes/, body: itemsPage(2) }])
    const first = await demo.callTool(ctx(full), 'list_things', { box: 'b' })
    expect(first).toMatchObject({ hasMore: true, nextCursor: '2' })

    const short = fakeUpstream([{ match: /boxes/, body: itemsPage(1) }])
    const last = await demo.callTool(ctx(short), 'list_things', { box: 'b' })
    expect(last).toMatchObject({ hasMore: false, nextCursor: null })
  })

  it('sends a page cursor back as the page number and refuses one it never issued', async () => {
    const upstream = fakeUpstream([{ match: /boxes/, body: itemsPage(1) }])
    await demo.callTool(ctx(upstream), 'list_things', { box: 'b', cursor: '3' })
    expect(upstream.calls[0]?.url).toContain('page=3')

    await expect(
      demo.callTool(ctx(upstream), 'list_things', { box: 'b', cursor: 'nonsense' }),
    ).rejects.toMatchObject({ code: 'invalid_arguments' })
  })

  it('reads a cursor style page from nextPath, trusting hasMorePath when declared', async () => {
    const cursored = withTools(
      [
        {
          name: 'list_things',
          description: 'List the things by opaque cursor',
          write: false,
          request: 'GET /things',
          args: {},
          items: 'results',
        },
      ],
      {
        pagination: {
          style: 'cursor',
          size: 25,
          sizeParam: 'page_size',
          param: 'start_cursor',
          nextPath: 'next_cursor',
          hasMorePath: 'has_more',
        },
      },
    )

    const more = fakeUpstream([
      { match: /things/, body: { results: itemsPage(2), next_cursor: 'abc', has_more: true } },
    ])
    const first = await cursored.callTool(ctx(more), 'list_things', {})
    expect(first).toMatchObject({ hasMore: true, nextCursor: 'abc' })
    expect(more.calls[0]?.url).toContain('page_size=25')

    // has_more false outranks a token the upstream left behind.
    const done = fakeUpstream([
      { match: /things/, body: { results: itemsPage(1), next_cursor: 'abc', has_more: false } },
    ])
    const last = await cursored.callTool(ctx(done), 'list_things', {})
    expect(last).toMatchObject({ hasMore: false, nextCursor: null })

    await cursored.callTool(ctx(more), 'list_things', { cursor: 'abc' })
    expect(more.calls[1]?.url).toContain('start_cursor=abc')
  })

  it('falls back to an empty next token when no hasMorePath is declared', async () => {
    const cursored = withTools(
      [
        {
          name: 'list_things',
          description: 'List the things by opaque cursor',
          write: false,
          request: 'GET /things',
          args: {},
          items: 'channels',
        },
      ],
      {
        pagination: {
          style: 'cursor',
          param: 'cursor',
          nextPath: 'response_metadata.next_cursor',
        },
      },
    )

    const more = fakeUpstream([
      {
        match: /things/,
        body: { channels: itemsPage(2), response_metadata: { next_cursor: 'ZZZ' } },
      },
    ])
    expect(await cursored.callTool(ctx(more), 'list_things', {})).toMatchObject({
      hasMore: true,
      nextCursor: 'ZZZ',
    })

    const done = fakeUpstream([
      { match: /things/, body: { channels: itemsPage(1), response_metadata: { next_cursor: '' } } },
    ])
    expect(await cursored.callTool(ctx(done), 'list_things', {})).toMatchObject({
      hasMore: false,
      nextCursor: null,
    })
  })

  it('lets a tool override the provider pagination style', async () => {
    const mixed = withTools([
      {
        name: 'list_files',
        description: 'An older method that still pages by number',
        write: false,
        request: 'GET /files',
        args: {},
        pagination: { style: 'page', size: 2, sizeParam: 'count', pageParam: 'page' },
        items: 'files',
      },
    ])
    const upstream = fakeUpstream([{ match: /files/, body: { files: itemsPage(2) } }])
    const result = await mixed.callTool(ctx(upstream), 'list_files', {})
    expect(upstream.calls[0]?.url).toContain('count=2')
    expect(result.nextCursor).toBe('2')
  })
})

describe('manifest executor: errors', () => {
  const rules = {
    rateLimited: { status: 403, header: 'x-ratelimit-remaining', equals: '0' },
    retryAfter: [
      { header: 'retry-after', as: 'seconds' as const },
      { header: 'x-ratelimit-reset', as: 'epoch' as const },
    ],
  }
  const guarded = manifestProvider({ ...base, errors: rules })

  async function callWith(upstream: FakeUpstream, adapter = guarded) {
    return adapter.callTool(ctx(upstream), 'list_things', { box: 'b' }).catch((err) => err)
  }

  it('separates a rate limit from a permission problem on the same status', async () => {
    const limited = await callWith(
      fakeUpstream([
        {
          match: /boxes/,
          status: 403,
          body: {},
          headers: { 'x-ratelimit-remaining': '0', 'retry-after': '42' },
        },
      ]),
    )
    expect(limited.code).toBe('rate_limited')
    expect(limited.details.retryAfter).toBe(42)

    const denied = await callWith(
      fakeUpstream([
        { match: /boxes/, status: 403, body: {}, headers: { 'x-ratelimit-remaining': '9' } },
      ]),
    )
    expect(denied.code).toBe('reauth_required')
  })

  it('resolves retryAfter in the declared order, falling back to 60 seconds', async () => {
    const reset = Math.ceil(Date.now() / 1000) + 90
    const epoch = await callWith(
      fakeUpstream([
        {
          match: /boxes/,
          status: 403,
          body: {},
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
        },
      ]),
    )
    expect(epoch.details.retryAfter).toBeGreaterThan(60)

    const neither = await callWith(
      fakeUpstream([
        { match: /boxes/, status: 403, body: {}, headers: { 'x-ratelimit-remaining': '0' } },
      ]),
    )
    expect(neither.details.retryAfter).toBe(60)
  })

  it('lets a provider say a bare 403 is not about the credential', async () => {
    const google = manifestProvider({ ...base, errors: { forbidden: 'upstream_error' } })
    const refused = await callWith(
      fakeUpstream([{ match: /boxes/, status: 403, body: {} }]),
      google,
    )
    expect(refused.code).toBe('upstream_error')

    // A 401 still means the credential, whatever the 403 was declared to mean.
    const stale = await callWith(fakeUpstream([{ match: /boxes/, status: 401, body: {} }]), google)
    expect(stale.code).toBe('reauth_required')
  })

  it('maps 401 to reauth, 429 to rate limited and anything else to upstream_error', async () => {
    expect((await callWith(fakeUpstream([{ match: /boxes/, status: 401, body: {} }]))).code).toBe(
      'reauth_required',
    )
    expect((await callWith(fakeUpstream([{ match: /boxes/, status: 429, body: {} }]))).code).toBe(
      'rate_limited',
    )
    const broken = await callWith(fakeUpstream([{ match: /boxes/, status: 500, body: {} }]))
    expect(broken.code).toBe('upstream_error')
    expect(broken.details.provider).toBe('demo')
  })

  it('maps a body failure on a 200, before any status check', async () => {
    const slackish = manifestProvider({
      ...base,
      errors: {
        bodyFailure: {
          path: 'ok',
          equals: false,
          codeFrom: 'error',
          codes: { ratelimited: 'rate_limited', invalid_auth: 'reauth_required' },
        },
      },
    })
    const limited = await callWith(
      fakeUpstream([{ match: /boxes/, body: { ok: false, error: 'ratelimited' } }]),
      slackish,
    )
    expect(limited.code).toBe('rate_limited')

    const unmapped = await callWith(
      fakeUpstream([{ match: /boxes/, body: { ok: false, error: 'something_new' } }]),
      slackish,
    )
    expect(unmapped.code).toBe('upstream_error')

    const fine = await slackish.callTool(
      ctx(fakeUpstream([{ match: /boxes/, body: [{ id: 1 }] }])),
      'list_things',
      { box: 'b' },
    )
    expect(fine.content).toEqual({ items: [{ id: 1 }] })
  })
})
