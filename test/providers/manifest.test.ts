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
  it('validates an api key without storing or exposing it', async () => {
    const validator = withTools([], { validate: { request: 'GET /users/@me' }, auth: { type: 'api_key', in: 'header', name: 'authorization', prefix: 'Bot ' } })
    const upstream = fakeUpstream([{ match: /users\/@me/, body: { id: 'bot-1' } }])

    await validator.validateKey?.({ ...ctx(upstream), accessToken: 'secret-token' })

    expect(upstream.calls[0]?.url).toBe('https://api.demo.test/users/@me')
    expect((upstream.calls[0]?.init?.headers as Record<string, string>).authorization).toBe('Bot secret-token')
  })

  it('rejects an api key when its validation request fails', async () => {
    const validator = withTools([], { validate: { request: 'GET /users/@me' } })
    const upstream = fakeUpstream([{ match: /users\/@me/, status: 401, body: { message: 'bad token' } }])

    await expect(validator.validateKey?.({ ...ctx(upstream), accessToken: 'wrong' })).rejects.toMatchObject({
      code: 'invalid_arguments',
    })
  })

  it('reports a rate limited key check as rate_limited with the retry hint', async () => {
    // The validator used to answer 502 here, so a client retried immediately
    // and made it worse. It shares the executor's mapping now.
    const validator = withTools([], {
      validate: { request: 'GET /users/@me' },
      errors: { retryAfter: [{ header: 'retry-after', as: 'seconds' }] },
    })
    const upstream = fakeUpstream([
      { match: /users\/@me/, status: 429, body: {}, headers: { 'retry-after': '30' } },
    ])

    const err = await validator
      .validateKey?.({ ...ctx(upstream), accessToken: 'k' })
      .catch((e) => e)
    expect(err.code).toBe('rate_limited')
    expect(err.details.retryAfter).toBe(30)
  })

  it('carries the vendor reason out of a failed key check', async () => {
    const validator = withTools([], { validate: { request: 'GET /users/@me' } })
    const upstream = fakeUpstream([
      { match: /users\/@me/, status: 500, raw: 'upstream exploded' },
    ])

    const err = await validator
      .validateKey?.({ ...ctx(upstream), accessToken: 'k' })
      .catch((e) => e)
    expect(err.code).toBe('upstream_error')
    expect(err.message).toContain('upstream exploded')
  })

  it('gives the key check a deadline and cancels it rather than only waiting', async () => {
    const validator = withTools([], { validate: { request: 'GET /users/@me' } })
    let seen: AbortSignal | undefined
    const fetching = (async (_url: string, init?: RequestInit) => {
      seen = init?.signal ?? undefined
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    await validator.validateKey?.({
      workspaceId: 'ws-1',
      requestId: 'req-1',
      accessToken: 'k',
      fetch: fetching,
    })
    // An AbortSignal aborts the request. A raced promise would leave the socket
    // held, which is what this is here to stop happening again.
    expect(seen).toBeInstanceOf(AbortSignal)
  })

  it('maps an aborted key check to upstream_timeout, not a generic failure', async () => {
    const validator = withTools([], { validate: { request: 'GET /users/@me' } })
    const timingOut = (async () => {
      const err = new Error('The operation was aborted due to timeout')
      err.name = 'TimeoutError'
      throw err
    }) as typeof fetch

    const err = await validator
      .validateKey?.({ workspaceId: 'ws-1', requestId: 'req-1', accessToken: 'k', fetch: timingOut })
      .catch((e) => e)
    expect(err.code).toBe('upstream_timeout')
  })

  it('puts query API keys on the validation request', async () => {
    const validator = withTools([], {
      validate: { request: 'GET /users/@me' },
      auth: { type: 'api_key', in: 'query', name: 'api_key' },
    })
    const upstream = fakeUpstream([{ match: /users\/@me\?api_key=secret-token/, body: { id: 'bot-1' } }])

    await validator.validateKey?.({ ...ctx(upstream), accessToken: 'secret-token' })

    expect(upstream.calls[0]?.url).toContain('api_key=secret-token')
  })

  it('reports validation service failures as upstream errors', async () => {
    const validator = withTools([], { validate: { request: 'GET /users/@me' } })
    const upstream = fakeUpstream([{ match: /users\/@me/, status: 503, body: { message: 'busy' } }])

    await expect(validator.validateKey?.({ ...ctx(upstream), accessToken: 'secret-token' })).rejects.toMatchObject({
      code: 'upstream_error',
    })
  })

  it('reports validation network failures as upstream errors', async () => {
    const validator = withTools([], { validate: { request: 'GET /users/@me' } })
    const unreachable = { ...ctx(fakeUpstream([])), fetch: (async () => { throw new Error('offline') }) as typeof fetch }

    await expect(validator.validateKey?.({ ...unreachable, accessToken: 'secret-token' })).rejects.toMatchObject({
      code: 'upstream_error',
    })
  })

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

  it('puts an argument in the query string on a PATCH when the manifest asks for it', async () => {
    // Drive moves a file with addParents in the query of a PATCH, so the
    // method alone cannot decide where an argument goes.
    const mover = withTools([
      {
        name: 'move_thing',
        description: 'Move one thing',
        write: true,
        request: 'PATCH /things/{id}',
        args: {
          id: { type: 'string', required: true },
          to: { type: 'string', in: 'query', param: 'addParents' },
          name: { type: 'string' },
        },
      },
    ])
    const upstream = fakeUpstream([{ match: /things/, body: { id: 't1' } }])
    await mover.callTool(ctx(upstream), 'move_thing', { id: 't1', to: 'box-b', name: 'renamed' })
    const call = upstream.calls[0]
    expect(call?.url).toContain('addParents=box-b')
    expect(JSON.parse(String(call?.init?.body))).toEqual({ name: 'renamed' })
  })

  it('sends a string[] whole in a body, joined in a query, and accepts a bare value', async () => {
    const tagger = withTools([
      {
        name: 'tag_thing',
        description: 'Tag one thing',
        write: true,
        request: 'POST /things/{id}/tags',
        args: {
          id: { type: 'string', required: true },
          tags: { type: 'string[]' },
          parents: { type: 'string[]', in: 'query' },
        },
      },
    ])
    const upstream = fakeUpstream([{ match: /things/, body: { id: 't1' } }])
    await tagger.callTool(ctx(upstream), 'tag_thing', {
      id: 't1',
      tags: ['bug', 'urgent'],
      parents: ['box-a', 'box-b'],
    })
    expect(JSON.parse(String(upstream.calls[0]?.init?.body))).toEqual({ tags: ['bug', 'urgent'] })
    expect(upstream.calls[0]?.url).toContain('parents=box-a%2Cbox-b')

    await tagger.callTool(ctx(upstream), 'tag_thing', { id: 't1', tags: 'bug' })
    expect(JSON.parse(String(upstream.calls[1]?.init?.body))).toEqual({ tags: ['bug'] })
  })

  it('declares a string[] as an array of strings in the input schema', () => {
    const tagger = withTools([
      {
        name: 'tag_thing',
        description: 'Tag one thing',
        write: true,
        request: 'POST /things',
        args: { tags: { type: 'string[]', description: 'Tag names' } },
      },
    ])
    const schema = tagger.listTools()[0]?.inputSchema as { properties: Record<string, unknown> }
    expect(schema.properties).toEqual({
      tags: { type: 'array', items: { type: 'string' }, description: 'Tag names' },
    })
  })

  it('hands back base64 with its media type when the tool is declared binary', async () => {
    const files = withTools([
      {
        name: 'download_thing',
        description: 'Download one thing',
        write: false,
        request: 'GET /things/{id}',
        binary: true,
        args: { id: { type: 'string', required: true } },
      },
    ])
    const upstream = fakeUpstream([
      { match: /things/, raw: 'hello bytes', headers: { 'content-type': 'application/pdf' } },
    ])
    const result = await files.callTool(ctx(upstream), 'download_thing', { id: 't1' })
    expect(result.binary).toBe(true)
    expect(result.content).toEqual({
      mime_type: 'application/pdf',
      size: 11,
      data: Buffer.from('hello bytes').toString('base64'),
    })
  })

  it('refuses a binary response too large to hold, on the declared length', async () => {
    const files = withTools([
      {
        name: 'download_thing',
        description: 'Download one thing',
        write: false,
        request: 'GET /things/{id}',
        binary: true,
        args: { id: { type: 'string', required: true } },
      },
    ])
    // Refused on content-length, before the body is pulled, which is the point:
    // the ceiling exists so one response cannot be held whole in memory. Past
    // the inline limit the application stores it and answers with an id, so
    // this is no longer about what a context window can take.
    const upstream = fakeUpstream([
      {
        match: /things/,
        raw: 'small',
        headers: { 'content-type': 'application/pdf', 'content-length': String(26 * 1024 * 1024) },
      },
    ])
    await expect(files.callTool(ctx(upstream), 'download_thing', { id: 't1' })).rejects.toMatchObject(
      { code: 'invalid_arguments' },
    )
  })

  it('takes an empty 204 as an empty result, not a parse failure', async () => {
    // A delete answers 204 with no body at all, which res.json() reads as a
    // syntax error and reports as an upstream failure.
    const remover = withTools([
      {
        name: 'delete_thing',
        description: 'Delete one thing',
        write: true,
        request: 'DELETE /things/{id}',
        args: { id: { type: 'string', required: true } },
      },
    ])
    const upstream = fakeUpstream([{ match: /things/, status: 204 }])
    const result = await remover.callTool(ctx(upstream), 'delete_thing', { id: 't1' })
    expect(result.content).toEqual({})
  })

  it('sends an upload as multipart, with the metadata as JSON and the bytes decoded', async () => {
    const uploader = withTools([
      {
        name: 'upload_thing',
        description: 'Upload one thing',
        write: true,
        request: 'POST /upload/things',
        upload: { content: 'content', mimeType: 'mime_type' },
        args: {
          name: { type: 'string', required: true },
          content: { type: 'base64', required: true },
          mime_type: { type: 'string', required: true },
        },
      },
    ])
    const upstream = fakeUpstream([{ match: /things/, body: { id: 't1' } }])
    await uploader.callTool(ctx(upstream), 'upload_thing', {
      name: 'notes.txt',
      content: Buffer.from('hello bytes').toString('base64'),
      mime_type: 'text/plain',
    })
    const call = upstream.calls[0]
    const type = (call?.init?.headers as Record<string, string>)['content-type'] ?? ''
    expect(type).toMatch(/^multipart\/related; boundary=selat-/)

    const sent = Buffer.from(call?.init?.body as Uint8Array).toString()
    expect(sent).toContain('{"name":"notes.txt"}')
    expect(sent).toContain('content-type: text/plain')
    // The bytes go on the wire decoded, not as the base64 the agent sent.
    expect(sent).toContain('hello bytes')
    expect(sent).not.toContain(Buffer.from('hello bytes').toString('base64'))
  })

  it('refuses an argument that is not base64, rather than uploading the garbage', async () => {
    const uploader = withTools([
      {
        name: 'upload_thing',
        description: 'Upload one thing',
        write: true,
        request: 'POST /upload/things',
        upload: { content: 'content', mimeType: 'mime_type' },
        args: {
          content: { type: 'base64', required: true },
          mime_type: { type: 'string', required: true },
        },
      },
    ])
    const upstream = fakeUpstream([{ match: /things/, body: { id: 't1' } }])
    await expect(
      uploader.callTool(ctx(upstream), 'upload_thing', {
        content: 'not base64!',
        mime_type: 'text/plain',
      }),
    ).rejects.toMatchObject({ code: 'invalid_arguments' })
    expect(upstream.calls).toHaveLength(0)
  })

  it('lets a caller-supplied selector win over the manifest projection', async () => {
    // The projection trims noise the caller did not ask about. A caller who
    // names the fields has already done that job, upstream, and projecting
    // again can only remove a field they asked for on purpose.
    const picky = withTools([
      {
        name: 'get_thing',
        description: 'Fetch one thing',
        write: false,
        request: 'GET /things/{id}',
        selector: 'response_fields',
        args: {
          id: { type: 'string', required: true },
          response_fields: { type: 'string', default: 'id,name', param: 'fields' },
        },
        fields: ['id', 'name'],
      },
    ])
    const body = { id: 't1', name: 'thing', parents: ['box-a'], kind: 'noise' }

    const untouched = fakeUpstream([{ match: /things/, body }])
    const projected = await picky.callTool(ctx(untouched), 'get_thing', { id: 't1' })
    expect(projected.content).toEqual({ id: 't1', name: 'thing' })

    const widened = fakeUpstream([{ match: /things/, body }])
    const whole = await picky.callTool(ctx(widened), 'get_thing', {
      id: 't1',
      response_fields: 'id,name,parents',
    })
    expect(whole.content).toEqual(body)
    expect(new URL(widened.calls[0]?.url ?? '').searchParams.get('fields')).toBe('id,name,parents')
  })

  it('still projects paginated items when the caller named no fields', async () => {
    const listing = withTools([
      {
        name: 'list_things',
        description: 'List things',
        write: false,
        request: 'GET /things',
        selector: 'response_fields',
        args: { response_fields: { type: 'string', default: 'items(id)', param: 'fields' } },
        items: 'items',
        fields: ['id'],
      },
    ])
    const body = { items: [{ id: 1, kind: 'noise' }] }
    const plain = fakeUpstream([{ match: /things/, body }])
    expect((await listing.callTool(ctx(plain), 'list_things', {})).content).toEqual({
      items: [{ id: 1 }],
    })

    const asked = fakeUpstream([{ match: /things/, body }])
    const wide = await listing.callTool(ctx(asked), 'list_things', {
      response_fields: 'items(id,kind)',
    })
    expect(wide.content).toEqual({ items: [{ id: 1, kind: 'noise' }] })
  })

  it('carries the credential through a same-origin redirect', async () => {
    const upstream = fakeUpstream([
      {
        match: /\/things\/moved/,
        status: 302,
        body: {},
        headers: { location: 'https://api.demo.test/things/here' },
      },
      { match: /\/things\/here/, body: { id: 1 } },
    ])
    const demoTools = withTools([
      {
        name: 'get_moved',
        description: 'Fetch a thing that moved',
        write: false,
        request: 'GET /things/moved',
        args: {},
      },
    ])
    const result = await demoTools.callTool(ctx(upstream), 'get_moved', {})
    expect(result.content).toEqual({ id: 1 })
    const second = upstream.calls[1]?.init?.headers as Record<string, string>
    expect(second['authorization']).toBe('Bearer secret-token')
  })

  it('drops the credential when a redirect crosses to another origin', async () => {
    // A Drive download answers with exactly this, to googleusercontent.com, and
    // the target carries its own signature. Left to fetch's default the bearer
    // would travel to whatever address the upstream chose.
    const upstream = fakeUpstream([
      {
        match: /api\.demo\.test\/things\/moved/,
        status: 302,
        body: {},
        headers: { location: 'https://files.elsewhere.test/blob' },
      },
      { match: /elsewhere/, body: { id: 1 } },
    ])
    const demoTools = withTools([
      {
        name: 'get_moved',
        description: 'Fetch a thing that moved',
        write: false,
        request: 'GET /things/moved',
        args: {},
      },
    ])
    const result = await demoTools.callTool(ctx(upstream), 'get_moved', {})
    expect(result.content).toEqual({ id: 1 })

    const second = upstream.calls[1]
    expect(second?.url).toContain('elsewhere.test')
    const headers = second?.init?.headers as Record<string, string>
    expect(headers['authorization']).toBeUndefined()
    // The manifest's own headers are not credentials and travel on.
    expect(headers['accept']).toBe('application/demo+json')
  })

  it('drops an api key header across origins too, not only the bearer', async () => {
    const keyed = withTools(
      [
        {
          name: 'get_moved',
          description: 'Fetch a thing that moved',
          write: false,
          request: 'GET /things/moved',
          args: {},
        },
      ],
      { auth: { type: 'api_key', in: 'header', name: 'x-api-key' } },
    )
    const upstream = fakeUpstream([
      {
        match: /api\.demo\.test/,
        status: 302,
        body: {},
        headers: { location: 'https://files.elsewhere.test/blob' },
      },
      { match: /elsewhere/, body: { id: 1 } },
    ])
    await keyed.callTool(ctx(upstream), 'get_moved', {})
    const headers = upstream.calls[1]?.init?.headers as Record<string, string>
    expect(headers['x-api-key']).toBeUndefined()
  })

  it('does not follow a redirect on a write, so a body is never replayed elsewhere', async () => {
    const upstream = fakeUpstream([
      {
        match: /things/,
        status: 302,
        body: {},
        headers: { location: 'https://files.elsewhere.test/blob' },
      },
    ])
    const writer = withTools([
      {
        name: 'make_thing',
        description: 'Make one thing',
        write: true,
        request: 'POST /things',
        args: { title: { type: 'string', required: true } },
      },
    ])
    await expect(writer.callTool(ctx(upstream), 'make_thing', { title: 't' })).rejects.toMatchObject(
      { code: 'upstream_error' },
    )
    expect(upstream.calls).toHaveLength(1)
  })

  it('believes the vendor about a last page rather than inferring from fullness', async () => {
    // Stripe pages by object id and also says has_more. Without reading it, a
    // last page that happens to be exactly full is reported as having a next
    // one, and the caller spends a request to find nothing.
    const ided = withTools(
      [
        {
          name: 'list_things',
          description: 'List things',
          write: false,
          request: 'GET /things',
          args: {},
          items: 'data',
        },
      ],
      { pagination: { style: 'id', size: 2, sizeParam: 'limit', param: 'starting_after', hasMorePath: 'has_more' } },
    )
    const exactlyFullAndDone = fakeUpstream([
      { match: /things/, body: { has_more: false, data: [{ id: 'a' }, { id: 'b' }] } },
    ])
    const done = await ided.callTool(ctx(exactlyFullAndDone), 'list_things', {})
    expect(done.hasMore).toBe(false)
    expect(done.nextCursor).toBeNull()

    const more = fakeUpstream([
      { match: /things/, body: { has_more: true, data: [{ id: 'a' }, { id: 'b' }] } },
    ])
    const next = await ided.callTool(ctx(more), 'list_things', {})
    expect(next.hasMore).toBe(true)
    expect(next.nextCursor).toBe('b')
  })

  it('still infers from fullness when the vendor says nothing', async () => {
    const ided = withTools(
      [
        {
          name: 'list_things',
          description: 'List things',
          write: false,
          request: 'GET /things',
          args: {},
          items: '$',
        },
      ],
      { pagination: { style: 'id', size: 2, sizeParam: 'limit', param: 'after' } },
    )
    const full = fakeUpstream([{ match: /things/, body: [{ id: 'a' }, { id: 'b' }] }])
    expect((await ided.callTool(ctx(full), 'list_things', {})).hasMore).toBe(true)

    const short = fakeUpstream([{ match: /things/, body: [{ id: 'a' }] }])
    expect((await ided.callTool(ctx(short), 'list_things', {})).hasMore).toBe(false)
  })

  it('accepts back the id cursor it just issued, even when it is not a number', async () => {
    // The executor minted cus_24 as nextCursor and then rejected it, because
    // only the cursor style was treated as upstream-minted. Discord survived
    // only because a snowflake happens to parse as an integer.
    const ided = withTools(
      [
        {
          name: 'list_things',
          description: 'List things',
          write: false,
          request: 'GET /things',
          args: {},
          items: 'data',
        },
      ],
      { pagination: { style: 'id', size: 2, sizeParam: 'limit', param: 'starting_after' } },
    )
    const first = fakeUpstream([
      { match: /things/, body: { data: [{ id: 'cus_a' }, { id: 'cus_b' }] } },
    ])
    const page = await ided.callTool(ctx(first), 'list_things', {})
    expect(page.nextCursor).toBe('cus_b')

    const second = fakeUpstream([{ match: /things/, body: { data: [] } }])
    await expect(
      ided.callTool(ctx(second), 'list_things', { cursor: page.nextCursor }),
    ).resolves.toBeDefined()
    expect(new URL(second.calls[0]?.url ?? '').searchParams.get('starting_after')).toBe('cus_b')
  })

  it('still refuses a page number it never issued', async () => {
    const upstream = fakeUpstream([{ match: /boxes/, body: itemsPage(1) }])
    await expect(
      demo.callTool(ctx(upstream), 'list_things', { box: 'b', cursor: 'not-a-page' }),
    ).rejects.toMatchObject({ code: 'invalid_arguments' })
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
