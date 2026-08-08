import { GatewayError } from '../domain/errors.ts'
import { DEFAULT_SCOPE, mintCredential, type CredentialScope } from '../domain/credential.ts'
import type { Pool } from '../adapters/db/pool.ts'

export type CredentialSummary = {
  id: string
  name: string
  last4: string
  scope: CredentialScope
  lastUsedAt: Date | null
  revokedAt: Date | null
  createdAt: Date
}

export async function mintForWorkspace(
  pool: Pool,
  workspaceId: string,
  input: { name?: string; scope?: CredentialScope; env?: 'live' | 'test' } = {},
): Promise<{ id: string; token: string; last4: string }> {
  const scope = normaliseScope(input.scope)
  const { token, hash, last4 } = mintCredential(input.env ?? 'live')
  const { rows } = await pool.query(
    `INSERT INTO gateway_credentials (workspace_id, token_hash, last4, name, scope)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [workspaceId, hash, last4, (input.name ?? 'default').slice(0, 60), JSON.stringify(scope)],
  )
  // The plaintext is returned exactly once and stored nowhere. Losing it costs
  // a mint; keeping it costs an incident.
  return { id: rows[0].id, token, last4 }
}

export async function listCredentials(
  pool: Pool,
  workspaceId: string,
): Promise<CredentialSummary[]> {
  const { rows } = await pool.query(
    `SELECT id, name, last4, scope, last_used_at, revoked_at, created_at
     FROM gateway_credentials WHERE workspace_id = $1 ORDER BY created_at DESC`,
    [workspaceId],
  )
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    last4: row.last4,
    scope: row.scope,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  }))
}

export async function revokeCredential(
  pool: Pool,
  workspaceId: string,
  credentialId: string,
): Promise<void> {
  // The workspace predicate is what stops one tenant revoking another's bearer
  // by guessing an id.
  const { rowCount } = await pool.query(
    `UPDATE gateway_credentials SET revoked_at = now()
     WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL`,
    [credentialId, workspaceId],
  )
  if (!rowCount) throw new GatewayError('tool_not_found', 'credential not found')
}

function normaliseScope(scope: CredentialScope | undefined): CredentialScope {
  if (!scope) return DEFAULT_SCOPE
  const providers = scope.providers
  if (providers !== null && providers !== undefined && !Array.isArray(providers)) {
    throw new GatewayError('invalid_arguments', 'scope.providers must be an array or null')
  }
  return { providers: providers ?? null, readOnly: Boolean(scope.readOnly) }
}
