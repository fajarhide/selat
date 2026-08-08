import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  buildAuthorizeUrl,
  createPkce,
  exchangeCode,
  refreshGrant,
} from '../src/adapters/oauth/client.ts'
import { envOauthConfig } from '../src/adapters/oauth/catalog.ts'
import { GatewayError } from '../src/domain/errors.ts'

const cfg = {
  authorizeUrl: 'https://vendor.example.com/authorize',
  tokenUrl: 'https://vendor.example.com/token',
  clientId: 'cid',
}

function tokenResponder(body: object, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
}

describe('pkce', () => {
  it('derives an S256 challenge from the verifier', () => {
    const { verifier, challenge } = createPkce()
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
  })

  it('builds an authorize url with S256 and the exact scopes', () => {
    const url = new URL(
      buildAuthorizeUrl(cfg, {
        redirectUri: 'https://app.example.com/cb',
        state: 'st',
        challenge: 'ch',
        scopes: ['a', 'b'],
      }),
    )
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBe('ch')
    expect(url.searchParams.get('state')).toBe('st')
    expect(url.searchParams.get('scope')).toBe('a b')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example.com/cb')
  })
})

describe('token exchange', () => {
  it('parses an expiry into an absolute time', async () => {
    const tokens = await exchangeCode(
      cfg,
      { code: 'c', verifier: 'v', redirectUri: 'https://app.example.com/cb' },
      tokenResponder({ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'x y' }),
    )
    expect(tokens.accessToken).toBe('a')
    expect(tokens.refreshToken).toBe('r')
    expect(tokens.scopes).toEqual(['x', 'y'])
    expect(tokens.expiresAt!.getTime()).toBeGreaterThan(Date.now())
  })

  it('treats a missing expiry as a token that does not expire on a clock', async () => {
    const tokens = await exchangeCode(
      cfg,
      { code: 'c', verifier: 'v', redirectUri: 'https://app.example.com/cb' },
      tokenResponder({ access_token: 'a' }),
    )
    expect(tokens.expiresAt).toBeNull()
    expect(tokens.refreshToken).toBeNull()
  })

  it('rejects a token endpoint failure', async () => {
    await expect(
      exchangeCode(
        cfg,
        { code: 'c', verifier: 'v', redirectUri: 'https://app.example.com/cb' },
        tokenResponder({ error: 'invalid_grant' }, 400),
      ),
    ).rejects.toBeInstanceOf(GatewayError)
  })

  it('rejects a response with no access token', async () => {
    await expect(refreshGrant(cfg, 'r', tokenResponder({ ok: true }))).rejects.toMatchObject({
      code: 'upstream_error',
    })
  })
})

describe('oauth config from the environment', () => {
  it('builds a config from the grant endpoints and the client id', () => {
    const resolve = envOauthConfig({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' })
    expect(resolve('github')).toEqual({
      authorizeUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      clientId: 'id',
      clientSecret: 'secret',
    })
  })

  it('refuses a grant with no configured application', () => {
    try {
      envOauthConfig({})('github')
      throw new Error('should have thrown')
    } catch (err) {
      expect((err as GatewayError).code).toBe('provider_not_connected')
    }
  })
})
