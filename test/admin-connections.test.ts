import { afterAll, describe, expect, it } from 'vitest'
import { closeTestServers, startTestServer, testConfig } from './helpers/server.ts'
import { bootRegistry } from '../src/adapters/providers/boot.ts'
import { testPool } from './helpers/db.ts'
import { json } from './helpers/http.ts'

const TOKEN = 'slt_svc_0123456789abcdef0123456789abcdef0123456789a'
const DASHBOARD = 'https://dash.example.com'
const svc = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }

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

function start(enable: string[]) {
  return startTestServer({
    enable,
    overrides: {
      ...fakeVendor,
      config: { ...testConfig, serviceToken: TOKEN, dashboardUrl: DASHBOARD },
    },
  })
}

// Walks the whole portal driven flow: the portal asks for an authorize url with
// a return_to, the vendor sends the browser to the callback with no bearer.
async function connect(base: string, workspaceId: string, returnTo: string) {
  const started = await json(
    await fetch(`${base}/v1/admin/workspaces/${workspaceId}/connections/fake/authorize`, {
      method: 'POST',
      headers: svc,
      body: JSON.stringify({ return_to: returnTo }),
    }),
  )
  const state = new URL(started.authorize_url).searchParams.get('state')!
  const callback = await fetch(
    `${base}/v1/connections/fake/callback?state=${encodeURIComponent(state)}&code=abc`,
    { redirect: 'manual' },
  )
  return { started, callback }
}

describe('admin connections', () => {
  it('returns an authorize url and sends the callback back to the dashboard', async () => {
    const { base, workspaceId } = await start([])
    const { started, callback } = await connect(
      base,
      workspaceId,
      `${DASHBOARD}/app/connections?ok=fake`,
    )
    expect(started.authorize_url).toContain('https://vendor.example.com/authorize')
    expect(new URL(started.authorize_url).searchParams.get('code_challenge_method')).toBe('S256')
    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toBe(`${DASHBOARD}/app/connections?ok=fake`)

    const listed = await json(
      await fetch(`${base}/v1/admin/workspaces/${workspaceId}/connections`, { headers: svc }),
    )
    expect(listed.connections).toContainEqual(
      expect.objectContaining({ provider: 'fake', grant: 'fake', connected: true }),
    )
  })

  it('keeps the html page when return_to is not the dashboard', async () => {
    const { base, workspaceId } = await start([])
    for (const foreign of ['https://evil.example.com/app', `${DASHBOARD}.evil.com/app`]) {
      const { callback } = await connect(base, workspaceId, foreign)
      expect(callback.status).toBe(200)
      expect(await callback.text()).toContain('fake connected')
    }
  })

  it('disconnects, drops the grant and writes the audit trail', async () => {
    const { base, pool, workspaceId } = await start([])
    await connect(base, workspaceId, `${DASHBOARD}/app`)
    const before = await pool.query(
      'SELECT 1 FROM grants WHERE workspace_id = $1 AND grant_id = $2',
      [workspaceId, 'fake'],
    )
    expect(before.rowCount).toBe(1)

    const res = await fetch(`${base}/v1/admin/workspaces/${workspaceId}/connections/fake`, {
      method: 'DELETE',
      headers: svc,
    })
    expect(res.status).toBe(200)
    expect((await json(res)).disconnected).toBe('fake')

    const after = await pool.query(
      'SELECT 1 FROM grants WHERE workspace_id = $1 AND grant_id = $2',
      [workspaceId, 'fake'],
    )
    expect(after.rowCount).toBe(0)

    const audit = await pool.query(
      'SELECT actor, action FROM audit_log WHERE workspace_id = $1 ORDER BY id',
      [workspaceId],
    )
    expect(audit.rows).toEqual([
      { actor: 'service', action: 'connection.authorized' },
      { actor: 'service', action: 'connection.disconnected' },
    ])
  })

  it('hides a disabled tool from the agent but keeps it in the admin list', async () => {
    const { base, token, workspaceId } = await start(['fake'])
    const off = await fetch(`${base}/v1/admin/workspaces/${workspaceId}/tools/fake__echo`, {
      method: 'PUT',
      headers: svc,
      body: JSON.stringify({ enabled: false }),
    })
    expect(off.status).toBe(200)
    expect(await json(off)).toMatchObject({ tool: 'fake__echo', enabled: false })

    const agent = await json(
      await fetch(`${base}/v1/tools`, { headers: { authorization: `Bearer ${token}` } }),
    )
    expect(agent.tools.map((tool: { name: string }) => tool.name)).not.toContain('fake__echo')

    const admin = await json(
      await fetch(`${base}/v1/admin/workspaces/${workspaceId}/tools`, { headers: svc }),
    )
    expect(admin.tools).toContainEqual(
      expect.objectContaining({ name: 'fake__echo', provider: 'fake', enabled: false }),
    )
    expect(admin.tools).toContainEqual(
      expect.objectContaining({ name: 'fake__write_note', write: true, enabled: true }),
    )
    expect(admin.catalog_truncated).toBe(false)

    const on = await fetch(`${base}/v1/admin/workspaces/${workspaceId}/tools/fake__echo`, {
      method: 'PUT',
      headers: svc,
      body: JSON.stringify({ enabled: true }),
    })
    expect(on.status).toBe(200)
    const again = await json(
      await fetch(`${base}/v1/tools`, { headers: { authorization: `Bearer ${token}` } }),
    )
    expect(again.tools.map((tool: { name: string }) => tool.name)).toContain('fake__echo')
  })

  it('refuses a toggle for a tool no adapter serves', async () => {
    const { base, workspaceId } = await start(['fake'])
    const res = await fetch(`${base}/v1/admin/workspaces/${workspaceId}/tools/fake__nope`, {
      method: 'PUT',
      headers: svc,
      body: JSON.stringify({ enabled: false }),
    })
    expect(res.status).toBe(404)
    expect((await json(res)).error.code).toBe('tool_not_found')
  })
})

// The portal drove every provider through authorize, so discord answered 400
// and the portal turned it into a 500. It needs to read the credential kind off
// the list, and it needs somewhere to put the key once it asks for one.
describe('admin connections for a provider that takes a key', () => {
  const KEY = 'MTIzNDU2Nzg5.Gabcde.a-real-looking-bot-token'

  const putKey = (base: string, workspaceId: string, prefix: string, api_key: unknown) =>
    fetch(`${base}/v1/admin/workspaces/${workspaceId}/connections/${prefix}/key`, {
      method: 'PUT',
      headers: svc,
      body: JSON.stringify({ api_key }),
    })

  it('names the credential kind so consent and key providers can be told apart', async () => {
    // bootRegistry leaves out a provider with no client id, so github is only
    // in the list when one is configured.
    const { base, workspaceId } = await startTestServer({
      enable: [],
      overrides: {
        ...fakeVendor,
        config: { ...testConfig, serviceToken: TOKEN, dashboardUrl: DASHBOARD },
        registry: bootRegistry({ ...process.env, GITHUB_CLIENT_ID: 'cid' }),
      },
    })
    const listed = await json(
      await fetch(`${base}/v1/admin/workspaces/${workspaceId}/connections`, { headers: svc }),
    )
    expect(listed.connections).toContainEqual(
      expect.objectContaining({ provider: 'discord', credential: 'api_key', connected: false }),
    )
    expect(listed.connections).toContainEqual(
      expect.objectContaining({ provider: 'github', credential: 'oauth' }),
    )
  })

  it('stores the key encrypted, turns the provider on and never echoes it back', async () => {
    const { base, pool, workspaceId } = await start([])
    const res = await putKey(base, workspaceId, 'discord', KEY)
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body).toMatchObject({ connected: 'discord' })
    expect(JSON.stringify(body)).not.toContain(KEY.slice(0, 12))

    const stored = await pool.query(
      'SELECT access_token FROM grants WHERE workspace_id = $1 AND grant_id = $2',
      [workspaceId, 'discord'],
    )
    expect(stored.rowCount).toBe(1)
    expect(JSON.stringify(stored.rows[0].access_token)).not.toContain(KEY)

    const listed = await json(
      await fetch(`${base}/v1/admin/workspaces/${workspaceId}/connections`, { headers: svc }),
    )
    expect(listed.connections).toContainEqual(
      expect.objectContaining({ provider: 'discord', connected: true }),
    )

    const audit = await pool.query(
      'SELECT actor, action, target FROM audit_log WHERE workspace_id = $1 ORDER BY id',
      [workspaceId],
    )
    expect(audit.rows).toEqual([
      { actor: 'service', action: 'connection.key_set', target: 'discord' },
    ])
  })

  it('refuses a key for a provider that does not take one, a non string, a blank one and an unknown workspace', async () => {
    const { base, workspaceId } = await start([])
    expect((await putKey(base, workspaceId, 'fake', KEY)).status).toBe(400)
    expect((await putKey(base, workspaceId, 'discord', 42)).status).toBe(400)
    expect((await putKey(base, workspaceId, 'discord', '   ')).status).toBe(400)
    expect(
      (await putKey(base, '00000000-0000-0000-0000-000000000000', 'discord', KEY)).status,
    ).toBe(404)
  })
})
