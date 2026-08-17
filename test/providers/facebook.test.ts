import { describe, expect, it } from 'vitest'
import { facebookManifest, facebookProvider } from '../../src/adapters/providers/facebook.ts'
import { buildAuthorizeUrl } from '../../src/adapters/oauth/client.ts'
import { GRANT_ENDPOINTS } from '../../src/adapters/oauth/catalog.ts'
import { fakeUpstream, type FakeUpstream } from '../helpers/fake-upstream.ts'

const facebook = facebookProvider()

function ctx(upstream: FakeUpstream) {
  return { workspaceId: 'ws-1', requestId: 'req-1', accessToken: 'EAAG...', fetch: upstream.fetch }
}

describe('facebook', () => {
  it('reads the account through /me and projects it down', async () => {
    const upstream = fakeUpstream([
      {
        match: /\/me\?/,
        body: {
          id: 'u1',
          name: 'Someone',
          link: 'https://facebook.com/u1',
          // Present in a real payload and deliberately not declared.
          middle_name: 'unwanted',
        },
      },
    ])
    const result = await facebook.callTool(ctx(upstream), 'get_me', {})
    expect(result.content).toEqual({ id: 'u1', name: 'Someone', link: 'https://facebook.com/u1' })
  })

  it('names the fields it wants, because Meta returns only an id otherwise', async () => {
    const upstream = fakeUpstream([{ match: /\/me\?/, body: { id: 'u1' } }])
    await facebook.callTool(ctx(upstream), 'get_me', {})
    expect(new URL(upstream.calls[0]?.url ?? '').searchParams.get('fields')).toBe('id,name,link')
  })

  it('carries no version in any path, so Meta applies the app default', () => {
    for (const tool of facebookManifest.tools) {
      expect(tool.request).not.toMatch(/\/v\d+\.\d+\//)
    }
    expect(facebookManifest.baseUrl).not.toMatch(/\/v\d+\.\d+/)
  })

  // Meta refuses /me/posts and /me/likes with error_subcode 2069030 on a live
  // connection where get_me works (#28). Both passed fixtures written from the
  // documentation, so only this list stands between that and shipping them again.
  it('offers nothing the live API refuses', () => {
    expect(facebookManifest.tools.map((tool) => tool.name)).toEqual(['get_me'])
  })

  it('asks only for the scopes the surviving tool needs', () => {
    const url = buildAuthorizeUrl(
      { ...GRANT_ENDPOINTS.facebook!, clientId: 'cid' },
      {
        redirectUri: 'https://example.com/cb',
        state: 's',
        challenge: 'c',
        scopes: facebook.scopes,
      },
    )
    const scope = new URL(url).searchParams.get('scope') ?? ''
    expect(scope).toBe('public_profile,user_link')
    // Meta separates with commas, not spaces.
    expect(scope).not.toContain(' ')
  })

  it('sends the app id on the long lived trade, which Facebook refuses without', () => {
    expect(GRANT_ENDPOINTS.facebook?.longLived).toMatchObject({
      withClientId: true,
      withClientSecret: true,
      params: { grant_type: 'fb_exchange_token' },
    })
    // Facebook has no refresh for a user token, so a grant dies at sixty days
    // and reconnecting is the only path. Its absence is the accurate model.
    expect(GRANT_ENDPOINTS.facebook?.longLivedRefresh).toBeUndefined()
  })
})
