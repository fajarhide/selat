import { describe, expect, it } from 'vitest'
import { threadsProvider } from '../../src/adapters/providers/threads.ts'
import { buildAuthorizeUrl } from '../../src/adapters/oauth/client.ts'
import { GRANT_ENDPOINTS } from '../../src/adapters/oauth/catalog.ts'
import { fakeUpstream, itemsPage, type FakeUpstream } from '../helpers/fake-upstream.ts'
import { runAdapterConformance } from '../conformance/adapter.ts'

const threads = threadsProvider()

function ctx(upstream: FakeUpstream) {
  return { workspaceId: 'ws-1', requestId: 'req-1', accessToken: 'THQVJ...', fetch: upstream.fetch }
}

function page(count: number, over: object) {
  return { data: itemsPage(count), paging: { cursors: { after: 'QVFIU' }, ...over } }
}

describe('threads conformance', () => {
  runAdapterConformance(threads, {
    pagedTool: 'list_posts',
    fullPage: {
      args: {},
      upstream: fakeUpstream([
        { match: /me\/threads/, body: page(25, { next: 'https://graph.threads.net/v1.0/me/threads?after=QVFIU' }) },
      ]),
    },
    lastPage: {
      args: {},
      // The cursor is still there on the last page, which is the trap.
      upstream: fakeUpstream([{ match: /me\/threads/, body: page(4, {}) }]),
    },
  })
})

describe('threads', () => {
  it('stops at the last page even though Meta leaves a cursor behind', async () => {
    const more = fakeUpstream([
      { match: /threads/, body: page(25, { next: 'https://graph.threads.net/next' }) },
    ])
    expect(await threads.callTool(ctx(more), 'list_posts', {})).toMatchObject({
      hasMore: true,
      nextCursor: 'QVFIU',
    })

    // Same cursor present, no paging.next. Reading the cursor alone would page
    // forever over the same last page.
    const done = fakeUpstream([{ match: /threads/, body: page(25, {}) }])
    expect(await threads.callTool(ctx(done), 'list_posts', {})).toMatchObject({
      hasMore: false,
      nextCursor: null,
    })
  })

  it('names the fields it wants, because Meta returns only an id otherwise', async () => {
    const upstream = fakeUpstream([{ match: /threads/, body: page(1, {}) }])
    await threads.callTool(ctx(upstream), 'list_posts', {})
    const params = new URL(upstream.calls[0]?.url ?? '').searchParams
    expect(params.get('fields')).toContain('permalink')
    expect(params.get('limit')).toBe('25')
  })

  it('reads one post and its replies by id', async () => {
    const upstream = fakeUpstream([
      { match: /replies/, body: { data: [{ id: 'r1', text: 'agreed', username: 'someone', hide_status: 'NOT_HUSHED', noise: 'x' }] } },
    ])
    const result = await threads.callTool(ctx(upstream), 'list_replies', { post_id: 'p1' })
    expect(upstream.calls[0]?.url).toContain('/v1.0/p1/replies')
    expect(result.content).toEqual({
      items: [{ id: 'r1', text: 'agreed', username: 'someone', hide_status: 'NOT_HUSHED' }],
    })
  })

  it('escapes a post id so it cannot walk out of the endpoint', async () => {
    const upstream = fakeUpstream([{ match: /v1\.0/, body: {} }])
    await threads.callTool(ctx(upstream), 'get_post', { post_id: '../me/threads' })
    expect(upstream.calls[0]?.url).not.toContain('/me/threads')
    expect(upstream.calls[0]?.url).toContain('%2F')
  })
})

describe('the threads grant', () => {
  it('separates scopes with commas, which is what Meta reads', () => {
    const endpoints = GRANT_ENDPOINTS.threads
    expect(endpoints).toBeDefined()
    const url = buildAuthorizeUrl(
      { ...endpoints!, clientId: 'cid' },
      { redirectUri: 'https://app.example.com/cb', state: 's', challenge: 'c', scopes: threads.scopes },
    )
    // Given spaces, Meta grants nothing and the failure only shows at call time.
    expect(new URL(url).searchParams.get('scope')).toBe('threads_basic,threads_read_replies')
  })

  it('authorizes on threads.net and exchanges on graph.threads.net', () => {
    expect(GRANT_ENDPOINTS.threads?.authorizeUrl).toContain('//threads.net/')
    expect(GRANT_ENDPOINTS.threads?.tokenUrl).toContain('//graph.threads.net/')
  })
})
