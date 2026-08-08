import type { Server } from 'node:http'
import { bootRegistry } from '../../src/adapters/providers/boot.ts'
import { mintCredential, type CredentialScope } from '../../src/domain/credential.ts'
import { createServer, type ServerDeps } from '../../src/server.ts'
import type { Config } from '../../src/config.ts'
import type { Pool } from '../../src/adapters/db/pool.ts'
import { resetDb, seedWorkspace, testPool } from './db.ts'

export const testConfig: Config = {
  port: 0,
  databaseUrl: 'postgres://unused',
  vaultKey: Buffer.alloc(32, 7),
  publicUrl: 'http://localhost:8080',
}

const open: Server[] = []

export async function closeTestServers(): Promise<void> {
  await Promise.all(open.splice(0).map((server) => new Promise((r) => server.close(r))))
}

export async function startTestServer(
  opts: {
    scope?: CredentialScope
    enable?: string[]
    reset?: boolean
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
  if (opts.reset !== false) await resetDb(pool)

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

  const server = createServer({
    pool,
    config: testConfig,
    registry: bootRegistry(),
    ...opts.overrides,
  }).listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  open.push(server)

  const address = server.address() as { port: number }
  return { base: `http://127.0.0.1:${address.port}`, token, pool, workspaceId, server }
}
