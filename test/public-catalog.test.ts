import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createServer } from '../src/server.ts'
import type { Config } from '../src/config.ts'
import type { Pool } from '../src/adapters/db/pool.ts'
import { createRegistry } from '../src/adapters/providers/registry.ts'
import { fakeProvider } from '../src/adapters/providers/fake.ts'
import { githubProvider } from '../src/adapters/providers/github.ts'
import { listenBelowEphemeral } from './helpers/server.ts'

const config: Config = {
  port: 0,
  databaseUrl: 'postgres://unused',
  vaultKey: Buffer.alloc(32, 1),
  publicUrl: 'http://localhost:8080',
  poolMax: 10,
}

let running: Server | undefined
afterEach(() => running?.close())

async function listen(): Promise<string> {
  const pool = { query: () => Promise.resolve({ rows: [] }) } as unknown as Pool
  const registry = createRegistry([fakeProvider(), githubProvider()])
  running = await listenBelowEphemeral(createServer({ pool, config, registry }))
  const address = running.address() as { port: number }
  return `http://127.0.0.1:${address.port}`
}

type Catalog = {
  providers: { prefix: string; maturity: string; credential: string; tool_count: number; tools: string[] }[]
  provider_count: number
  tool_count: number
}

describe('the public catalog', () => {
  it('answers with no credential at all', async () => {
    const res = await fetch(`${await listen()}/v1/catalog`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=300')
  })

  it('names the tools, because a tool name is the claim a site gets wrong', async () => {
    const body = (await (await fetch(`${await listen()}/v1/catalog`)).json()) as Catalog
    const github = body.providers.find((provider) => provider.prefix === 'github')
    expect(github?.tools).toContain('github__list_issues')
    // Namespaced as a caller would write it, so nothing has to be assembled.
    expect(github?.tools.every((name) => name.startsWith('github__'))).toBe(true)
    expect(github?.tool_count).toBe(github?.tools.length)
    expect(body.tool_count).toBe(
      body.providers.reduce((total, provider) => total + provider.tool_count, 0),
    )
  })

  it('carries nothing about a workspace or a connection', async () => {
    const text = await (await fetch(`${await listen()}/v1/catalog`)).text()
    for (const leak of ['workspace', 'token', 'scope', 'connected', 'client_id']) {
      expect(text.toLowerCase()).not.toContain(leak)
    }
  })
})
