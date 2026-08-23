import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mintCredential } from './domain/credential.ts'
import type { Pool } from './adapters/db/pool.ts'

/**
 * Local mode has no service token, so the admin plane is not mounted and there
 * is no way to ask for a credential. Without one, `npx selat` is a gateway that
 * answers 401 to everything worth calling, so the first run provisions one.
 *
 * The token is written beside the vault key, at the same trust level: both are
 * already on this machine, and a credential nobody can read again is the same
 * as no credential at all. A deployment sets DATABASE_URL and never comes here.
 */
export async function provisionLocal(pool: Pool, root: string): Promise<string> {
  const file = join(root, 'credential')

  const existing = await pool.query<{ id: string }>('SELECT id FROM workspaces LIMIT 1')
  if (existing.rows[0]) {
    try {
      return readFileSync(file, 'utf8').trim()
    } catch {
      // The workspace outlived the file. Minting a second credential is right:
      // the first one is a hash nobody can turn back into a token.
      return mintInto(pool, existing.rows[0].id, file)
    }
  }

  const { rows } = await pool.query<{ id: string }>(
    "INSERT INTO workspaces (name) VALUES ('local') RETURNING id",
  )
  const workspaceId = rows[0]!.id
  // fake needs no vendor application, so a fresh install reaches a real tool
  // call before opening anybody's developer console.
  await pool.query('INSERT INTO provider_enablements (workspace_id, prefix) VALUES ($1, $2)', [
    workspaceId,
    'fake',
  ])
  return mintInto(pool, workspaceId, file)
}

async function mintInto(pool: Pool, workspaceId: string, file: string): Promise<string> {
  const { token, hash, last4 } = mintCredential('live')
  await pool.query(
    'INSERT INTO gateway_credentials (workspace_id, token_hash, last4) VALUES ($1, $2, $3)',
    [workspaceId, hash, last4],
  )
  writeFileSync(file, `${token}\n`, { mode: 0o600 })
  return token
}
