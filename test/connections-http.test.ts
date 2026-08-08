import { afterAll, describe, expect, it } from 'vitest'
import { closeTestServers, startTestServer } from './helpers/server.ts'
import { testPool } from './helpers/db.ts'
import { json } from './helpers/http.ts'

afterAll(async () => {
  await closeTestServers()
  await (await testPool()).end()
})

const fakeVendor = {
  oauthConfig: () => ({
    authorizeUrl: 'https://vendor.example.com/authorize',
    tokenUrl: 'https://vendor.example.com/token',
    clientId: 'cid',
  }),
  connectionOverrides: {
    exchange: async () => ({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: [],
    }),
  },
}

describe('connection routes', () => {
  it('lists the catalog with a connected flag', async () => {
    const { base, token } = await startTestServer({ overrides: fakeVendor })
    const body = await json(
      await fetch(`${base}/v1/connections`, { headers: { authorization: `Bearer ${token}` } }),
    )
    expect(body.connections).toEqual([
      expect.objectContaining({ provider: 'fake', connected: true, maturity: 'experimental' }),
    ])
  })

  it('walks authorize then callback and lands the tokens in the vault', async () => {
    const { base, token, pool, workspaceId } = await startTestServer({
      enable: [],
      overrides: fakeVendor,
    })

    const started = await json(
      await fetch(`${base}/v1/connections/fake/authorize`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }),
    )
    const state = new URL(started.authorize_url).searchParams.get('state')!
    expect(new URL(started.authorize_url).searchParams.get('code_challenge_method')).toBe('S256')

    const callback = await fetch(
      `${base}/v1/connections/fake/callback?state=${encodeURIComponent(state)}&code=abc`,
    )
    expect(callback.status).toBe(200)
    expect(await callback.text()).toContain('fake connected')

    const stored = await pool.query(
      'SELECT access_token FROM grants WHERE workspace_id = $1 AND grant_id = $2',
      [workspaceId, 'fake'],
    )
    expect(JSON.stringify(stored.rows[0].access_token)).not.toContain('access-1')

    const tools = await json(
      await fetch(`${base}/v1/tools`, { headers: { authorization: `Bearer ${token}` } }),
    )
    expect(tools.tools.map((tool: { name: string }) => tool.name)).toContain('fake__echo')
  })

  it('refuses a callback with no state', async () => {
    const { base } = await startTestServer({ overrides: fakeVendor })
    const res = await fetch(`${base}/v1/connections/fake/callback?code=abc`)
    expect(res.status).toBe(400)
    expect((await json(res)).error.code).toBe('invalid_arguments')
  })

  it('disconnects and hides the tools again without touching the credential', async () => {
    const { base, token } = await startTestServer({ overrides: fakeVendor })
    const before = await json(
      await fetch(`${base}/v1/tools`, { headers: { authorization: `Bearer ${token}` } }),
    )
    expect(before.tools.length).toBeGreaterThan(0)

    const removed = await fetch(`${base}/v1/connections/fake`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(removed.status).toBe(200)

    const after = await fetch(`${base}/v1/tools`, { headers: { authorization: `Bearer ${token}` } })
    expect(after.status).toBe(200)
    expect((await json(after)).tools).toEqual([])
  })

  it('reports a provider with no configured OAuth application', async () => {
    const { base, token } = await startTestServer({
      overrides: {
        oauthConfig: undefined,
        connectionOverrides: fakeVendor.connectionOverrides,
      },
    })
    const res = await fetch(`${base}/v1/connections/fake/authorize`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(403)
    expect((await json(res)).error.code).toBe('provider_not_connected')
  })
})
