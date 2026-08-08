import { afterAll, describe, expect, it } from 'vitest'
import { closeTestServers, startTestServer } from './helpers/server.ts'
import { testPool } from './helpers/db.ts'
import { json } from './helpers/http.ts'

afterAll(async () => {
  await closeTestServers()
  await (await testPool()).end()
})

// The raw JSON-RPC contract is driven directly rather than through an SDK
// client, because the contract is what third-party MCP clients depend on.
async function rpc(base: string, token: string, method: string, params: object = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return { status: res.status, text: await res.text() }
}

function payload(text: string): any {
  // Streamable HTTP may answer as SSE, so the JSON lives behind a data: line.
  const line = text.split('\n').find((candidate) => candidate.startsWith('data:'))
  return JSON.parse(line ? line.slice(5).trim() : text)
}

describe('mcp surface', () => {
  it('lists the workspace catalog with its input schemas', async () => {
    const { base, token } = await startTestServer()
    const listed = await rpc(base, token, 'tools/list')
    expect(listed.status).toBe(200)
    const tools = payload(listed.text).result.tools
    expect(tools.map((tool: { name: string }) => tool.name)).toContain('fake__echo')
    expect(tools[0].inputSchema.type).toBe('object')
  })

  it('calls a tool and returns its content', async () => {
    const { base, token } = await startTestServer()
    const called = await rpc(base, token, 'tools/call', {
      name: 'fake__echo',
      arguments: { message: 'hi' },
    })
    const result = payload(called.text).result
    expect(result.isError).toBeFalsy()
    expect(result.content[0].text).toContain('hi')
  })

  it('reports a tool failure as an error result carrying the stable code', async () => {
    const { base, token } = await startTestServer()
    const called = await rpc(base, token, 'tools/call', { name: 'fake__nope', arguments: {} })
    const result = payload(called.text).result
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('tool_not_found')
  })

  it('rejects a request with no valid bearer', async () => {
    const { base } = await startTestServer()
    const res = await rpc(base, 'lyc_live_wrong', 'tools/list')
    expect(res.status).toBe(401)
  })

  it('exposes exactly the tools the REST catalog exposes', async () => {
    const { base, token } = await startTestServer()
    const rest = await json(
      await fetch(`${base}/v1/tools`, { headers: { authorization: `Bearer ${token}` } }),
    )
    const listed = payload((await rpc(base, token, 'tools/list')).text).result.tools
    expect(rest.tools.length).toBeGreaterThan(0)
    expect(listed.map((tool: { name: string }) => tool.name).sort()).toEqual(
      rest.tools.map((tool: { name: string }) => tool.name).sort(),
    )
  })

  it('honours the credential scope on the MCP surface too', async () => {
    const { base, token } = await startTestServer({
      scope: { providers: ['github'], readOnly: false },
    })
    const listed = payload((await rpc(base, token, 'tools/list')).text).result.tools
    expect(listed).toEqual([])
  })
})
