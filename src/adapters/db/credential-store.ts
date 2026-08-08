import type { Pool } from './pool.ts'
import type { CredentialRecord, CredentialStore } from '../../ports/stores.ts'

export function credentialStore(pool: Pool): CredentialStore {
  return {
    async findByHash(hash) {
      const { rows } = await pool.query(
        'SELECT id, workspace_id, scope, revoked_at FROM gateway_credentials WHERE token_hash = $1',
        [hash],
      )
      const row = rows[0]
      if (!row) return null
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        scope: row.scope,
        revokedAt: row.revoked_at,
      } satisfies CredentialRecord
    },

    async touch(id) {
      await pool.query('UPDATE gateway_credentials SET last_used_at = now() WHERE id = $1', [id])
    },
  }
}
