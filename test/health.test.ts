import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createServer } from '../src/server.ts'
import type { Config } from '../src/config.ts'
import type { Pool } from '../src/adapters/db/pool.ts'
import { bootRegistry } from '../src/adapters/providers/boot.ts'

const config: Config = {
  port: 0,
  databaseUrl: 'postgres://unused',
  vaultKey: Buffer.alloc(32, 1),
  publicUrl: 'http://localhost:8080',
}

let running: Server | undefined
afterEach(() => running?.close())

async function listen(pool: Pool): Promise<string> {
  const server = createServer({ pool, config, registry: bootRegistry() }).listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  running = server
  const address = server.address() as { port: number }
  return `http://127.0.0.1:${address.port}`
}

describe('health endpoints', () => {
  it('reports liveness without touching the database', async () => {
    const base = await listen({ query: () => Promise.reject(new Error('down')) } as unknown as Pool)
    const res = await fetch(`${base}/v1/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('reports readiness when the database answers', async () => {
    const base = await listen({ query: () => Promise.resolve({ rows: [] }) } as unknown as Pool)
    const res = await fetch(`${base}/v1/ready`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ready' })
  })

  it('fails readiness when the database is unreachable', async () => {
    const base = await listen({ query: () => Promise.reject(new Error('down')) } as unknown as Pool)
    const res = await fetch(`${base}/v1/ready`)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ status: 'not_ready', reason: 'database' })
  })
})
