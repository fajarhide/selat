import express from 'express'
import { afterAll, describe, expect, it } from 'vitest'
import { requireService } from '../src/interface/http/service.ts'
import { errorHandler, withRequestContext } from '../src/interface/http/context.ts'
import { json } from './helpers/http.ts'

const TOKEN = 'slt_svc_0123456789abcdef0123456789abcdef0123456789a'
const servers: import('node:http').Server[] = []

async function start(token: string | undefined): Promise<string> {
  const app = express()
  app.use(withRequestContext())
  app.get('/v1/admin/workspaces/:workspaceId/ping', requireService(token), (req, res) => {
    res.json({ workspace_id: req.params.workspaceId })
  })
  app.use(errorHandler())
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  servers.push(server)
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

afterAll(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
})

describe('service token plane', () => {
  it('accepts the configured token', async () => {
    const base = await start(TOKEN)
    const res = await fetch(`${base}/v1/admin/workspaces/w1/ping`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(res.status).toBe(200)
    expect((await json(res)).workspace_id).toBe('w1')
  })

  it('rejects a wrong token with invalid_credential', async () => {
    const base = await start(TOKEN)
    const res = await fetch(`${base}/v1/admin/workspaces/w1/ping`, {
      headers: { authorization: 'Bearer slt_svc_wrong' },
    })
    expect(res.status).toBe(401)
    expect((await json(res)).error.code).toBe('invalid_credential')
  })

  it('rejects an agent credential, which is a different plane', async () => {
    const base = await start(TOKEN)
    const res = await fetch(`${base}/v1/admin/workspaces/w1/ping`, {
      headers: { authorization: 'Bearer slt_live_something' },
    })
    expect(res.status).toBe(401)
  })

  it('refuses every request when no token is configured', async () => {
    const base = await start(undefined)
    const res = await fetch(`${base}/v1/admin/workspaces/w1/ping`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(res.status).toBe(401)
  })
})
