import type { Server } from 'node:http'
import { bootRegistry } from '../../src/adapters/providers/boot.ts'
import { mintCredential, type CredentialScope } from '../../src/domain/credential.ts'
import { createServer, type ServerDeps } from '../../src/server.ts'
import type { Config } from '../../src/config.ts'
import type { Pool } from '../../src/adapters/db/pool.ts'
import { seedWorkspace, testPool } from './db.ts'

export const testConfig: Config = {
  port: 0,
  databaseUrl: 'postgres://unused',
  vaultKey: Buffer.alloc(32, 7),
  publicUrl: 'http://localhost:8080',
  poolMax: 10,
}

const open: Server[] = []

/** macOS hands ephemeral ports out from here up, and so does `listen(0)`. */
export const EPHEMERAL_FLOOR = 49152

let nextPort = 34000

/**
 * `listen(0)` draws from the same ephemeral range every other process on the
 * machine binds at random, so a suite that uses it occasionally addresses a
 * port some unrelated local server holds. That is how a GET here came back as
 * a bare 405 from a browser agent process rather than from any route in this
 * repo (#14). Binding below the floor keeps the suite talking to its own
 * server. EADDRINUSE is expected: forks overlap while the previous one tears
 * down, so walk to the next port rather than failing the test.
 */
export async function listenBelowEphemeral(app: {
  listen(port: number, host: string): Server
}): Promise<Server> {
  while (nextPort < EPHEMERAL_FLOOR) {
    const port = nextPort
    nextPort += 1
    const server = app.listen(port, '127.0.0.1')
    const bound = await new Promise<boolean>((resolve) => {
      server.once('listening', () => resolve(true))
      server.once('error', () => resolve(false))
    })
    if (bound) return server
  }
  throw new Error('no free port below the ephemeral range')
}

export async function closeTestServers(): Promise<void> {
  await Promise.all(open.splice(0).map((server) => new Promise((r) => server.close(r))))
}

export async function startTestServer(
  opts: {
    scope?: CredentialScope
    enable?: string[]
    overrides?: Partial<ServerDeps>
  } = {},
): Promise<{
  base: string
  token: string
  pool: Pool
  workspaceId: string
  server: Server
}> {
  const pool = await testPool()

  const workspaceId = await seedWorkspace(pool)
  const { token, hash, last4 } = mintCredential('live')
  await pool.query(
    'INSERT INTO gateway_credentials (workspace_id, token_hash, last4, scope) VALUES ($1,$2,$3,$4)',
    [
      workspaceId,
      hash,
      last4,
      JSON.stringify(opts.scope ?? { providers: null, readOnly: false }),
    ],
  )
  for (const prefix of opts.enable ?? ['fake']) {
    await pool.query('INSERT INTO provider_enablements (workspace_id, prefix) VALUES ($1,$2)', [
      workspaceId,
      prefix,
    ])
  }

  const app = createServer({
    pool,
    config: testConfig,
    registry: bootRegistry(),
    ...opts.overrides,
  })
  const server = await listenBelowEphemeral(app)
  open.push(server)

  const address = server.address() as { port: number }
  return { base: `http://127.0.0.1:${address.port}`, token, pool, workspaceId, server }
}
