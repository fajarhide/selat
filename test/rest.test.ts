import { afterAll, describe, expect, it } from 'vitest'
import { closeTestServers, startTestServer } from './helpers/server.ts'
import { testPool } from './helpers/db.ts'
import { json } from './helpers/http.ts'

afterAll(async () => {
  await closeTestServers()
  await (await testPool()).end()
})

describe('rest tool surface', () => {
  it('lists the namespaced catalog', async () => {
    const { base, token } = await startTestServer()
    const res = await fetch(`${base}/v1/tools`, { headers: { authorization: `Bearer ${token}` } })
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.tools.map((tool: { name: string }) => tool.name)).toContain('fake__echo')
    expect(body.catalog_truncated).toBe(false)
  })

  it('calls a tool and echoes the request id', async () => {
    const { base, token } = await startTestServer()
    const res = await fetch(`${base}/v1/tools/fake__echo/call`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    })
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.content).toEqual({ message: 'hi' })
    expect(body.request_id).toBe(res.headers.get('x-request-id'))
  })

  it('replays a write for a repeated idempotency key', async () => {
    const { base, token, pool, workspaceId } = await startTestServer()
    const send = () =>
      fetch(`${base}/v1/tools/fake__write_note/call`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': 'k1',
        },
        body: JSON.stringify({ text: 'x' }),
      })
    expect((await send()).status).toBe(200)
    expect((await send()).status).toBe(200)
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM idempotency_keys WHERE workspace_id = $1',
      [workspaceId],
    )
    expect(rows[0].n).toBe(1)
  })

  it('rejects an unknown tool with tool_not_found', async () => {
    const { base, token } = await startTestServer()
    const res = await fetch(`${base}/v1/tools/fake__nope/call`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(404)
    const body = await json(res)
    expect(body.error.code).toBe('tool_not_found')
    expect(body.error.request_id).toBeTruthy()
  })

  it('rejects a missing bearer with invalid_credential', async () => {
    const { base } = await startTestServer()
    const res = await fetch(`${base}/v1/tools`)
    expect(res.status).toBe(401)
    expect((await json(res)).error.code).toBe('invalid_credential')
  })

  it('hides a provider outside the credential scope', async () => {
    const { base, token } = await startTestServer({ scope: { providers: ['github'], readOnly: false } })
    const listed = await fetch(`${base}/v1/tools`, { headers: { authorization: `Bearer ${token}` } })
    expect((await json(listed)).tools).toEqual([])

    const called = await fetch(`${base}/v1/tools/fake__echo/call`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'x' }),
    })
    expect(called.status).toBe(403)
    expect((await json(called)).error.code).toBe('credential_scope_denied')
  })

  it('reports the workspace on whoami without leaking a secret', async () => {
    const { base, token, workspaceId } = await startTestServer()
    const res = await fetch(`${base}/v1/whoami`, { headers: { authorization: `Bearer ${token}` } })
    const body = await json(res)
    expect(body.workspace_id).toBe(workspaceId)
    expect(body.providers).toEqual(['fake'])
    expect(JSON.stringify(body)).not.toContain(token)
  })
})
