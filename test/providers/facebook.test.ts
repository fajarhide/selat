import { describe, expect, it } from 'vitest'
import { facebookManifest, facebookProvider } from '../../src/adapters/providers/facebook.ts'
import { buildAuthorizeUrl } from '../../src/adapters/oauth/client.ts'
import { GRANT_ENDPOINTS } from '../../src/adapters/oauth/catalog.ts'
import { fakeUpstream, itemsPage, type FakeUpstream } from '../helpers/fake-upstream.ts'
import { runAdapterConformance } from '../conformance/adapter.ts'

const facebook = facebookProvider()

function ctx(upstream: FakeUpstream) {
  return { workspaceId: 'ws-1', requestId: 'req-1', accessToken: 'EAAG...', fetch: upstream.fetch }
}

function page(count: number, over: object) {
  return { data: itemsPage(count), paging: { cursors: { after: 'QVFIU' }, ...over } }
}

describe('facebook conformance', () => {
  runAdapterConformance(facebook, {
    pagedTool: 'list_my_posts',
    fullPage: {
      args: {},
      upstream: fakeUpstream([
        {
          match: /me\/posts/,
          body: page(25, { next: 'https://graph.facebook.com/me/posts?after=QVFIU' }),
        },
      ]),
    },
    lastPage: {
      args: {},
      // The cursor is still there on the last page, which is the trap.
      upstream: fakeUpstream([{ match: /me\/posts/, body: page(4, {}) }]),
    },
  })
})

describe('facebook', () => {
  it('stops at the last page even though Meta leaves a cursor behind', async () => {
    const more = fakeUpstream([
      { match: /me\/posts/, body: page(25, { next: 'https://graph.facebook.com/next' }) },
    ])
    expect(await facebook.callTool(ctx(more), 'list_my_posts', {})).toMatchObject({
      hasMore: true,
      nextCursor: 'QVFIU',
    })

    const done = fakeUpstream([{ match: /me\/posts/, body: page(25, {}) }])
    expect(await facebook.callTool(ctx(done), 'list_my_posts', {})).toMatchObject({
      hasMore: false,
      nextCursor: null,
    })
  })

  it('names the fields it wants, because Meta returns only an id otherwise', async () => {
    const upstream = fakeUpstream([{ match: /me\/posts/, body: page(1, {}) }])
    await facebook.callTool(ctx(upstream), 'list_my_posts', {})
    const params = new URL(upstream.calls[0]?.url ?? '').searchParams
    expect(params.get('fields')).toContain('permalink_url')
    expect(params.get('limit')).toBe('25')
  })

  it('projects a post down to the declared fields', async () => {
    const upstream = fakeUpstream([
      {
        match: /me\/posts/,
        body: {
          data: [
            {
              id: 'p1',
              message: 'hello',
              permalink_url: 'https://facebook.com/p1',
              created_time: '2026-08-01T00:00:00+0000',
              status_type: 'mobile_status_update',
              // Present in a real payload and deliberately not declared.
              privacy: { value: 'EVERYONE' },
            },
          ],
        },
      },
    ])
    const result = await facebook.callTool(ctx(upstream), 'list_my_posts', {})
    expect(result.content).toEqual({
      items: [
        {
          id: 'p1',
          message: 'hello',
          permalink_url: 'https://facebook.com/p1',
          created_time: '2026-08-01T00:00:00+0000',
          status_type: 'mobile_status_update',
        },
      ],
    })
  })

  it('reads the account and the liked pages through /me', async () => {
    const upstream = fakeUpstream([
      { match: /me\/likes/, body: { data: [{ id: 'g1', name: 'A Page', category: 'Bar' }] } },
      { match: /\/me\?/, body: { id: 'u1', name: 'Someone', link: 'https://facebook.com/u1' } },
    ])
    expect((await facebook.callTool(ctx(upstream), 'get_me', {})).content).toEqual({
      id: 'u1',
      name: 'Someone',
      link: 'https://facebook.com/u1',
    })
    const liked = await facebook.callTool(ctx(upstream), 'list_liked_pages', {})
    expect(liked.content).toEqual({ items: [{ id: 'g1', name: 'A Page', category: 'Bar' }] })
  })

  it('carries no version in any path, so Meta applies the app default', () => {
    for (const tool of facebookManifest.tools) {
      expect(tool.request).not.toMatch(/\/v\d+\.\d+\//)
    }
    expect(facebookManifest.baseUrl).not.toMatch(/\/v\d+\.\d+/)
  })

  it('asks for the user scopes and nothing a Page would need', () => {
    const url = buildAuthorizeUrl(
      { ...GRANT_ENDPOINTS.facebook!, clientId: 'cid' },
      { redirectUri: 'https://example.com/cb', state: 's', challenge: 'c', scopes: facebook.scopes },
    )
    const scope = new URL(url).searchParams.get('scope') ?? ''
    expect(scope).toContain('user_posts')
    expect(scope).not.toContain('pages_')
    expect(scope).not.toContain('instagram_')
    // Meta separates with commas, not spaces.
    expect(scope).toContain(',')
  })
})
