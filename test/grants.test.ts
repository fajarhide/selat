import { describe, expect, it, vi } from 'vitest'
import { createGrantResolver, type GrantDeps, type StoredGrant } from '../src/application/grants.ts'
import type { TokenSet } from '../src/adapters/oauth/client.ts'

const cfg = {
  authorizeUrl: 'https://vendor.example.com/authorize',
  tokenUrl: 'https://vendor.example.com/token',
  clientId: 'cid',
}

const refreshed: TokenSet = {
  accessToken: 'new',
  refreshToken: 'r2',
  expiresAt: new Date(Date.now() + 3_600_000),
  scopes: [],
}

function resolver(overrides: Partial<GrantDeps> = {}, initial?: Partial<StoredGrant>) {
  const grant: StoredGrant = {
    accessToken: 'old',
    refreshToken: 'r1',
    expiresAt: new Date(Date.now() - 1000),
    reauthNeeded: false,
    ...initial,
  }
  const calls = { save: 0, markReauth: 0 }
  const deps: GrantDeps = {
    grants: {
      async load() { return grant },
      async save(_workspaceId, _grantId, tokens) {
        calls.save += 1
        grant.accessToken = tokens.accessToken
      },
      async markReauth() { calls.markReauth += 1 },
      async drop() {},
    },
    oauthConfig: () => cfg,
    refresh: async () => refreshed,
    reauthUrl: (grantId) => `https://app.example.com/connect/${grantId}`,
    ...overrides,
  }
  return { resolver: createGrantResolver(deps), calls }
}

describe('grant resolution', () => {
  it('returns null when the workspace has no grant', async () => {
    const { resolver: r } = resolver({
      grants: {
        async load() { return null },
        async save() {},
        async markReauth() {},
        async drop() {},
      },
    })
    expect(await r.accessTokenFor('ws-1', 'g')).toBeNull()
  })

  it('returns a live access token untouched', async () => {
    const { resolver: r, calls } = resolver({}, { expiresAt: new Date(Date.now() + 600_000) })
    expect(await r.accessTokenFor('ws-1', 'g')).toBe('old')
    expect(calls.save).toBe(0)
  })

  it('treats a token with no expiry as live', async () => {
    const { resolver: r } = resolver({}, { expiresAt: null })
    expect(await r.accessTokenFor('ws-1', 'g')).toBe('old')
  })

  it('refreshes an expired token', async () => {
    const { resolver: r, calls } = resolver()
    expect(await r.accessTokenFor('ws-1', 'g')).toBe('new')
    expect(calls.save).toBe(1)
  })

  it('refreshes a token inside the clock skew window', async () => {
    const { resolver: r } = resolver({}, { expiresAt: new Date(Date.now() + 30_000) })
    expect(await r.accessTokenFor('ws-1', 'g')).toBe('new')
  })

  it('refreshes only once when two calls race', async () => {
    const refresh = vi.fn(async () => refreshed)
    const { resolver: r } = resolver({ refresh })
    await Promise.all([r.accessTokenFor('ws-1', 'g'), r.accessTokenFor('ws-1', 'g')])
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('raises reauth_required with a deep link when the refresh is rejected', async () => {
    const { resolver: r, calls } = resolver({
      refresh: async () => { throw new Error('invalid_grant') },
    })
    const err = await r.accessTokenFor('ws-1', 'g').catch((e) => e)
    expect(err.code).toBe('reauth_required')
    expect(err.details.reauthUrl).toBe('https://app.example.com/connect/g')
    expect(calls.markReauth).toBe(1)
  })

  it('raises reauth_required for an expired grant with no refresh token', async () => {
    const { resolver: r, calls } = resolver({}, { refreshToken: null })
    await expect(r.accessTokenFor('ws-1', 'g')).rejects.toMatchObject({ code: 'reauth_required' })
    expect(calls.markReauth).toBe(1)
  })

  it('raises reauth_required immediately for a grant already flagged', async () => {
    const { resolver: r } = resolver({}, { reauthNeeded: true })
    await expect(r.accessTokenFor('ws-1', 'g')).rejects.toMatchObject({ code: 'reauth_required' })
  })

  it('recovers after a failed refresh rather than jamming the single-flight slot', async () => {
    let attempt = 0
    const { resolver: r } = resolver({
      refresh: async () => {
        attempt += 1
        if (attempt === 1) throw new Error('transient')
        return refreshed
      },
    }, { reauthNeeded: false })
    await expect(r.accessTokenFor('ws-1', 'g')).rejects.toMatchObject({ code: 'reauth_required' })
    // markReauth is recorded on the fake, so a second resolve still proceeds.
    expect(await r.accessTokenFor('ws-1', 'g')).toBe('new')
  })
})
