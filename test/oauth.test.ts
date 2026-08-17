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

  it('carries vendor authorize params without letting them overwrite the fixed ones', () => {
    const url = new URL(
      buildAuthorizeUrl(
        { ...cfg, authorizeParams: { access_type: 'offline', response_type: 'token' } },
        { redirectUri: 'https://app.example.com/cb', state: 'st', challenge: 'ch', scopes: ['a'] },
      ),
    )
    expect(url.searchParams.get('access_type')).toBe('offline')
    // A vendor param must never downgrade the flow to an implicit grant.
    expect(url.searchParams.get('response_type')).toBe('code')
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

  it('rejects a token endpoint failure and carries the vendor reason', async () => {
    // The status alone costs another consent round trip to diagnose, because
    // the code is single use and the state row is gone by then.
    await expect(
      exchangeCode(
        cfg,
        { code: 'c', verifier: 'v', redirectUri: 'https://app.example.com/cb' },
        tokenResponder({ error: { message: 'Invalid verification code format.' } }, 400),
      ),
    ).rejects.toMatchObject({
      code: 'upstream_error',
      message: expect.stringContaining('Invalid verification code format.'),
    })
  })

  it('bounds the reason, so an HTML error page cannot flood the log line', async () => {
    const flood = `<html>${'x'.repeat(5000)}</html>`
    const thrown = await exchangeCode(
      cfg,
      { code: 'c', verifier: 'v', redirectUri: 'https://app.example.com/cb' },
      () => Promise.resolve(new Response(flood, { status: 502 })),
    ).catch((err: GatewayError) => err)
    expect(thrown).toBeInstanceOf(GatewayError)
    expect((thrown as GatewayError).message.length).toBeLessThan(500)
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

describe('a vendor that hands back a short lived token', () => {
  // Meta's shape: the code exchange yields an hour-long token with no
  // expires_in and no refresh_token, and a second GET trades it for a long one.
  const meta = {
    ...cfg,
    clientSecret: 'app-secret',
    longLived: {
      url: 'https://graph.example.test/access_token',
      tokenParam: 'access_token',
      params: { grant_type: 'th_exchange_token' },
      withClientSecret: true,
    },
    longLivedRefresh: {
      url: 'https://graph.example.test/refresh_access_token',
      tokenParam: 'access_token',
      params: { grant_type: 'th_refresh_token' },
    },
  }

  function twoStep() {
    const calls: string[] = []
    const doFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input)
      calls.push(url)
      const body = url.includes('/access_token') && init?.method === 'GET'
        ? { access_token: 'long-lived', token_type: 'bearer', expires_in: 5_183_944 }
        : url.includes('refresh_access_token')
          ? { access_token: 'rolled', token_type: 'bearer', expires_in: 5_183_944 }
          : { access_token: 'one-hour' }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    return { doFetch, calls }
  }

  it('trades the short token for the long one before returning', async () => {
    const { doFetch, calls } = twoStep()
    const tokens = await exchangeCode(
      meta,
      { code: 'c', verifier: 'v', redirectUri: 'https://app.example.com/cb' },
      doFetch,
    )
    expect(tokens.accessToken).toBe('long-lived')
    expect(calls).toHaveLength(2)

    const traded = new URL(calls[1] as string)
    expect(traded.searchParams.get('grant_type')).toBe('th_exchange_token')
    expect(traded.searchParams.get('access_token')).toBe('one-hour')
    expect(traded.searchParams.get('client_secret')).toBe('app-secret')
    // Threads takes the secret alone, so the app id must stay off this call.
    expect(traded.searchParams.get('client_id')).toBeNull()
  })

  it('sends the app id on a trade that asks for it, which Facebook does', async () => {
    const { doFetch, calls } = twoStep()
    await exchangeCode(
      { ...meta, longLived: { ...meta.longLived, withClientId: true } },
      { code: 'c', verifier: 'v', redirectUri: 'https://app.example.com/cb' },
      doFetch,
    )
    // Without it Facebook answers "Missing client_id parameter", after the code
    // has already been spent, so every retry costs another consent.
    expect(new URL(calls[1] as string).searchParams.get('client_id')).toBe(meta.clientId)
  })

  it('keeps the long token as its own refresh credential', async () => {
    const { doFetch } = twoStep()
    const tokens = await exchangeCode(
      meta,
      { code: 'c', verifier: 'v', redirectUri: 'https://app.example.com/cb' },
      doFetch,
    )
    // The vendor sends no refresh_token. Left null, the grant would read as
    // unrefreshable and die at its first expiry instead of rolling.
    expect(tokens.refreshToken).toBe('long-lived')
    expect(tokens.expiresAt?.getTime()).toBeGreaterThan(Date.now())
  })

  it('rolls it through the refresh endpoint, without the secret', async () => {
    const { doFetch, calls } = twoStep()
    const rolled = await refreshGrant(meta, 'long-lived', doFetch)
    expect(rolled.accessToken).toBe('rolled')

    const url = new URL(calls[0] as string)
    expect(url.pathname).toBe('/refresh_access_token')
    expect(url.searchParams.get('access_token')).toBe('long-lived')
    // Meta rejects the call outright when the secret is present.
    expect(url.searchParams.get('client_secret')).toBeNull()
  })

  it('leaves an ordinary vendor on the single form post it always used', async () => {
    const { doFetch, calls } = twoStep()
    await exchangeCode(cfg, { code: 'c', verifier: 'v', redirectUri: 'https://app.example.com/cb' }, doFetch)
    expect(calls).toHaveLength(1)
  })
})

describe('a token endpoint that demands http basic', () => {
  function capture() {
    const seen: { headers: Record<string, string>; body: string }[] = []
    const doFetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push({
        headers: init?.headers as Record<string, string>,
        body: String(init?.body),
      })
      return new Response(JSON.stringify({ access_token: 'a', expires_in: 7200 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    return { doFetch, seen }
  }

  const exchange = { code: 'c', verifier: 'v', redirectUri: 'https://app.example.com/cb' }

  it('sends the secret as basic and keeps it out of the body', async () => {
    const { doFetch, seen } = capture()
    await exchangeCode({ ...cfg, clientSecret: 's3cret', tokenAuth: 'basic' }, exchange, doFetch)
    const sent = seen[0]!
    expect(sent.headers.authorization).toBe(`Basic ${Buffer.from('cid:s3cret').toString('base64')}`)
    // Sending it in both places is what some servers reject outright.
    expect(sent.body).not.toContain('client_secret')
  })

  it('falls back to the body for a public client, which has no secret to send', async () => {
    const { doFetch, seen } = capture()
    await exchangeCode({ ...cfg, tokenAuth: 'basic' }, exchange, doFetch)
    expect(seen[0]!.headers.authorization).toBeUndefined()
    expect(seen[0]!.body).toContain('client_id=cid')
  })

  it('leaves an ordinary vendor sending the secret in the body', async () => {
    const { doFetch, seen } = capture()
    await exchangeCode({ ...cfg, clientSecret: 's3cret' }, exchange, doFetch)
    expect(seen[0]!.headers.authorization).toBeUndefined()
    expect(seen[0]!.body).toContain('client_secret=s3cret')
  })
})
