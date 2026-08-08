import { readFile } from 'node:fs/promises'
import { afterAll, describe, expect, it } from 'vitest'
import { closeTestServers, startTestServer } from './helpers/server.ts'
import { testPool } from './helpers/db.ts'
import { json } from './helpers/http.ts'

afterAll(async () => {
  await closeTestServers()
  await (await testPool()).end()
})

describe('quickstart', () => {
  it('documents the exact steps to a first tool call', async () => {
    const readme = await readFile('README.md', 'utf8')
    expect(readme).toContain('docker compose up')
    expect(readme).toContain('/v1/tools')
    // The property is that a reader can see how to authenticate and what a
    // credential looks like. Asserting one concatenation of the two pinned a
    // formatting choice, and rewording the README broke a passing build.
    expect(readme).toContain('Authorization: Bearer')
    expect(readme).toContain('slt_live_')
    expect(readme).toContain('"mcpServers"')
  })

  it('keeps the documented error codes in step with the code', async () => {
    const readme = await readFile('README.md', 'utf8')
    const errors = await readFile('src/domain/errors.ts', 'utf8')
    const declared = [...errors.matchAll(/^\s{2}\| '([a-z_]+)'$/gm)].map((match) => match[1])
    expect(declared.length).toBeGreaterThan(5)
    for (const code of declared) expect(readme).toContain(code)
  })

  it('reaches a first tool call over both surfaces', async () => {
    const started = Date.now()
    const { base, token } = await startTestServer()

    const rest = await fetch(`${base}/v1/tools/fake__echo/call`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    })
    expect(rest.status).toBe(200)
    expect((await json(rest)).content).toEqual({ message: 'hello' })

    const mcp = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'fake__echo', arguments: { message: 'hello' } },
      }),
    })
    expect(mcp.status).toBe(200)
    expect(await mcp.text()).toContain('hello')

    expect(Date.now() - started).toBeLessThan(60_000)
  })
})
