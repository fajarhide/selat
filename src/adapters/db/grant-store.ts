import type { Pool } from './pool.ts'
import { createVault, grantAad, type Sealed } from '../crypto/vault.ts'
import type { GrantStore, StoredGrant } from '../../application/grants.ts'
import type { TokenSet } from '../oauth/client.ts'

export function grantStore(pool: Pool, key: Buffer): GrantStore {
  const vault = createVault(key)

  return {
    async load(workspaceId, grantId): Promise<StoredGrant | null> {
      const { rows } = await pool.query(
        `SELECT access_token, refresh_token, expires_at, reauth_needed
         FROM grants WHERE workspace_id = $1 AND grant_id = $2`,
        [workspaceId, grantId],
      )
      const row = rows[0]
      if (!row) return null
      const aad = grantAad(workspaceId, grantId)
      return {
        accessToken: vault.open(row.access_token as Sealed, aad),
        refreshToken: row.refresh_token ? vault.open(row.refresh_token as Sealed, aad) : null,
        expiresAt: row.expires_at,
        reauthNeeded: row.reauth_needed,
      }
    },

    async save(workspaceId, grantId, tokens: TokenSet) {
      const aad = grantAad(workspaceId, grantId)
      const access = vault.seal(tokens.accessToken, aad)
      // A refresh response may omit the refresh token, which means keep the old
      // one. Overwriting it with null there would lose the grant silently.
      const refresh = tokens.refreshToken ? vault.seal(tokens.refreshToken, aad) : null
      await pool.query(
        `INSERT INTO grants
           (workspace_id, grant_id, access_token, refresh_token, expires_at, scopes, key_version, reauth_needed)
         VALUES ($1,$2,$3,$4,$5,$6,$7,false)
         ON CONFLICT (workspace_id, grant_id) DO UPDATE SET
           access_token  = EXCLUDED.access_token,
           refresh_token = COALESCE(EXCLUDED.refresh_token, grants.refresh_token),
           expires_at    = EXCLUDED.expires_at,
           scopes        = EXCLUDED.scopes,
           key_version   = EXCLUDED.key_version,
           reauth_needed = false,
           updated_at    = now()`,
        [
          workspaceId,
          grantId,
          JSON.stringify(access),
          refresh ? JSON.stringify(refresh) : null,
          tokens.expiresAt,
          tokens.scopes,
          access.keyVersion,
        ],
      )
    },

    async markReauth(workspaceId, grantId) {
      await pool.query(
        'UPDATE grants SET reauth_needed = true, updated_at = now() WHERE workspace_id = $1 AND grant_id = $2',
        [workspaceId, grantId],
      )
    },

    async drop(workspaceId, grantId) {
      await pool.query('DELETE FROM grants WHERE workspace_id = $1 AND grant_id = $2', [
        workspaceId,
        grantId,
      ])
    },
  }
}
