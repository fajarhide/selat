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
    // Contains rather than equals: the assertion is about the flag on fake,
    // and pinning the whole registry breaks on every provider added since.
    expect(body.connections).toContainEqual(
      expect.objectContaining({ provider: 'fake', connected: true, maturity: 'experimental' }),
    )
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

describe('connecting with an api key instead of a consent', () => {
  const KEY = 'MTIzNDU2Nzg5.Gabcde.a-real-looking-bot-token'

  it('stores the key encrypted and turns the provider on', async () => {
    const { base, token, pool, workspaceId } = await startTestServer()
    const put = await fetch(`${base}/v1/connections/discord/key`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: KEY }),
    })
    expect(put.status).toBe(200)
    const body = await json(put)
    // The key must never come back out, not even a tail of it.
    expect(JSON.stringify(body)).not.toContain(KEY.slice(0, 12))

    const stored = await pool.query(
      'SELECT access_token FROM grants WHERE workspace_id = $1 AND grant_id = $2',
      [workspaceId, 'discord'],
    )
    expect(stored.rowCount).toBe(1)
    expect(JSON.stringify(stored.rows[0].access_token)).not.toContain(KEY)

    const listed = await json(
      await fetch(`${base}/v1/connections`, { headers: { authorization: `Bearer ${token}` } }),
    )
    expect(listed.connections).toContainEqual(
      expect.objectContaining({ provider: 'discord', credential: 'api_key', connected: true }),
    )
  })

  it('refuses an empty key and a key for a provider that uses consent', async () => {
    const { base, token } = await startTestServer()
    const send = (prefix: string, api_key: unknown) =>
      fetch(`${base}/v1/connections/${prefix}/key`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ api_key }),
      })

    expect((await send('discord', '   ')).status).toBe(400)
    expect((await send('discord', 42)).status).toBe(400)
    // fake connects through neither, so it must not accept a key either.
    expect((await send('fake', 'anything')).status).toBe(400)
  })

  it('refuses to start a consent for a provider that takes a key', async () => {
    const { base, token } = await startTestServer()
    const started = await fetch(`${base}/v1/connections/discord/authorize`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(started.status).toBe(400)
    expect((await json(started)).error.message).toContain('/key')
  })

  it('needs the workspace credential, like every other connection route', async () => {
    const { base } = await startTestServer()
    const anonymous = await fetch(`${base}/v1/connections/discord/key`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: KEY }),
    })
    expect(anonymous.status).toBe(401)
  })
})
