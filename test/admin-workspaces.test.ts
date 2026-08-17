import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from '../src/server.ts'
import { bootRegistry } from '../src/adapters/providers/boot.ts'
import { listenBelowEphemeral, testConfig } from './helpers/server.ts'
import { testPool } from './helpers/db.ts'
import { json } from './helpers/http.ts'
import type { Server } from 'node:http'

const TOKEN = 'slt_svc_0123456789abcdef0123456789abcdef0123456789a'
let base: string
let server: Server

const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }

beforeAll(async () => {
  const pool = await testPool()
  server = await listenBelowEphemeral(
    createServer({
      pool,
      config: { ...testConfig, serviceToken: TOKEN },
      registry: bootRegistry(),
    }),
  )
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

async function newWorkspace(): Promise<string> {
  const res = await fetch(`${base}/v1/admin/workspaces`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'acme' }),
  })
  expect(res.status).toBe(201)
  return (await json(res)).workspace_id
}

describe('admin workspaces', () => {
  it('creates a workspace on the free plan', async () => {
    const res = await fetch(`${base}/v1/admin/workspaces`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'acme' }),
    })
    const body = await json(res)
    expect(res.status).toBe(201)
    expect(body.plan).toBe('free')
    expect(body.call_quota).toBe(5000)
    expect(body.workspace_id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('rejects a non uuid workspace id before touching the database', async () => {
    const res = await fetch(`${base}/v1/admin/workspaces/not-a-uuid`, { headers: auth })
    expect(res.status).toBe(400)
    expect((await json(res)).error.code).toBe('invalid_arguments')
  })

  it('applies a plan change and reports it back', async () => {
    const id = await newWorkspace()
    const res = await fetch(`${base}/v1/admin/workspaces/${id}`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ plan: 'pro', call_quota: 50000 }),
    })
    expect(res.status).toBe(200)
    expect((await json(res)).call_quota).toBe(50000)

    const read = await json(await fetch(`${base}/v1/admin/workspaces/${id}`, { headers: auth }))
    expect(read.plan).toBe('pro')
    expect(read.calls_this_period).toBe(0)
  })

  it('mints a credential, shows the token once and then only the last four', async () => {
    const id = await newWorkspace()
    const minted = await json(
      await fetch(`${base}/v1/admin/workspaces/${id}/credentials`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ name: 'ci', scope: { providers: ['github'], readOnly: true } }),
      }),
    )
    expect(minted.token).toMatch(/^slt_live_/)
    expect(minted.last4).toBe(minted.token.slice(-4))

    const listed = await json(
      await fetch(`${base}/v1/admin/workspaces/${id}/credentials`, { headers: auth }),
    )
    expect(listed.credentials).toHaveLength(1)
    expect(listed.credentials[0].name).toBe('ci')
    expect(listed.credentials[0].scope.readOnly).toBe(true)
    expect(JSON.stringify(listed)).not.toContain(minted.token)
  })

  it('revokes a credential and the bearer stops working', async () => {
    const id = await newWorkspace()
    const minted = await json(
      await fetch(`${base}/v1/admin/workspaces/${id}/credentials`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({}),
      }),
    )
    const before = await fetch(`${base}/v1/whoami`, {
      headers: { authorization: `Bearer ${minted.token}` },
    })
    expect(before.status).toBe(200)

    const revoked = await fetch(`${base}/v1/admin/workspaces/${id}/credentials/${minted.id}`, {
      method: 'DELETE',
      headers: auth,
    })
    expect(revoked.status).toBe(200)

    const after = await fetch(`${base}/v1/whoami`, {
      headers: { authorization: `Bearer ${minted.token}` },
    })
    expect(after.status).toBe(401)
  })

  it('will not revoke a credential belonging to another workspace', async () => {
    const a = await newWorkspace()
    const b = await newWorkspace()
    const minted = await json(
      await fetch(`${base}/v1/admin/workspaces/${a}/credentials`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({}),
      }),
    )
    const res = await fetch(`${base}/v1/admin/workspaces/${b}/credentials/${minted.id}`, {
      method: 'DELETE',
      headers: auth,
    })
    expect(res.status).toBe(404)
  })
})
