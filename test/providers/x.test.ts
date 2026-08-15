import { describe, expect, it } from 'vitest'
import { xProvider } from '../../src/adapters/providers/x.ts'
import { GRANT_ENDPOINTS } from '../../src/adapters/oauth/catalog.ts'
import { fakeUpstream, type FakeUpstream } from '../helpers/fake-upstream.ts'
import { runAdapterConformance } from '../conformance/adapter.ts'

const x = xProvider()

function ctx(upstream: FakeUpstream) {
  return { workspaceId: 'ws-1', requestId: 'req-1', accessToken: 'x-token', fetch: upstream.fetch }
}

function posts(count: number, over: object = {}) {
  return {
    data: Array.from({ length: count }, (_u, i) => ({
      id: String(100 + i),
      text: `post ${100 + i}`,
      edit_history_tweet_ids: ['noise'],
    })),
    meta: { result_count: count, ...over },
  }
}

describe('x conformance', () => {
  runAdapterConformance(x, {
    pagedTool: 'search_recent_posts',
    fullPage: {
      args: { query: 'mcp' },
      upstream: fakeUpstream([{ match: /search/, body: posts(25, { next_token: 'b26v89' }) }]),
    },
    lastPage: {
      args: { query: 'mcp' },
      upstream: fakeUpstream([{ match: /search/, body: posts(4) }]),
    },
  })
})

describe('the x grant', () => {
  it('names the tools x and the application twitter', () => {
    expect(x.prefix).toBe('x')
    expect(x.grantId).toBe('twitter')
    expect(x.listTools()[0]?.name.startsWith('get_')).toBe(true)
  })

  it('asks for offline access, without which the grant cannot be rolled', () => {
    expect(x.scopes).toContain('offline.access')
  })

  it('authorizes on x.com and exchanges on api.x.com', () => {
    expect(GRANT_ENDPOINTS.twitter?.authorizeUrl).toContain('//x.com/i/oauth2/authorize')
    expect(GRANT_ENDPOINTS.twitter?.tokenUrl).toContain('//api.x.com/2/oauth2/token')
  })
})

describe('x requests', () => {
  it('names the fields it wants, because X returns id and text otherwise', async () => {
    const upstream = fakeUpstream([{ match: /search/, body: posts(1) }])
    await x.callTool(ctx(upstream), 'search_recent_posts', { query: 'mcp -is:retweet' })
    const params = new URL(upstream.calls[0]?.url ?? '').searchParams
    expect(params.get('tweet.fields')).toContain('public_metrics')
    expect(params.get('query')).toBe('mcp -is:retweet')
    expect(params.get('max_results')).toBe('25')
  })

  it('sends no paging parameters to a tool that does not page', async () => {
    const upstream = fakeUpstream([{ match: /users\/me/, body: { data: { id: '1' } } }])
    await x.callTool(ctx(upstream), 'get_me', {})
    const params = new URL(upstream.calls[0]?.url ?? '').searchParams
    // max_results on /2/users/me is rejected by X outright.
    expect(params.get('max_results')).toBeNull()
    expect(params.get('user.fields')).toContain('public_metrics')
  })

  it('escapes a handle so it cannot walk out of the endpoint', async () => {
    const upstream = fakeUpstream([{ match: /users/, body: { data: {} } }])
    await x.callTool(ctx(upstream), 'get_user', { username: '../../tweets' })
    expect(upstream.calls[0]?.url).not.toContain('/tweets')
    expect(upstream.calls[0]?.url).toContain('%2F')
  })
})

describe('x responses', () => {
  it('pages on next_token and stops when X omits it', async () => {
    const more = fakeUpstream([{ match: /search/, body: posts(25, { next_token: 'b26v89' }) }])
    expect(await x.callTool(ctx(more), 'search_recent_posts', { query: 'a' })).toMatchObject({
      hasMore: true,
      nextCursor: 'b26v89',
    })

    // A full page with no next_token is genuinely the end, which counting
    // items would get wrong.
    const done = fakeUpstream([{ match: /search/, body: posts(25) }])
    expect(await x.callTool(ctx(done), 'search_recent_posts', { query: 'a' })).toMatchObject({
      hasMore: false,
      nextCursor: null,
    })
  })

  it('keeps the data wrapper on a single object, because projection keeps paths', async () => {
    const upstream = fakeUpstream([
      {
        match: /users\/me/,
        body: {
          data: {
            id: '9',
            name: 'Someone',
            username: 'someone',
            description: 'bio',
            public_metrics: { followers_count: 3 },
            withheld: 'noise',
          },
        },
      },
    ])
    const result = await x.callTool(ctx(upstream), 'get_me', {})
    expect(result.content).toEqual({
      data: {
        id: '9',
        name: 'Someone',
        username: 'someone',
        description: 'bio',
        public_metrics: { followers_count: 3 },
      },
    })
    expect(JSON.stringify(result)).not.toContain('noise')
  })

  it('maps a 403 to upstream_error, because an access level is not a credential', async () => {
    const denied = fakeUpstream([{ match: /search/, status: 403, body: {} }])
    const err = await x
      .callTool(ctx(denied), 'search_recent_posts', { query: 'a' })
      .catch((e) => e)
    expect(err.code).toBe('upstream_error')

    const stale = fakeUpstream([{ match: /search/, status: 401, body: {} }])
    const reauth = await x
      .callTool(ctx(stale), 'search_recent_posts', { query: 'a' })
      .catch((e) => e)
    expect(reauth.code).toBe('reauth_required')
  })

  it('reads the rate limit reset as an epoch second', async () => {
    const reset = Math.ceil(Date.now() / 1000) + 300
    const limited = fakeUpstream([
      { match: /search/, status: 429, body: {}, headers: { 'x-rate-limit-reset': String(reset) } },
    ])
    const err = await x
      .callTool(ctx(limited), 'search_recent_posts', { query: 'a' })
      .catch((e) => e)
    expect(err.code).toBe('rate_limited')
    expect(err.details.retryAfter).toBeGreaterThan(60)
  })
})

describe('a paywalled endpoint', () => {
  it('says the plan is the problem rather than printing 402', async () => {
    const gated = fakeUpstream([{ match: /search/, status: 402, body: {} }])
    const err = await x.callTool(ctx(gated), 'search_recent_posts', { query: 'a' }).catch((e) => e)
    expect(err.code).toBe('upstream_error')
    expect(err.message).toContain('paid plan')
  })
})
