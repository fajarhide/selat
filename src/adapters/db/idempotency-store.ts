import type { Pool } from './pool.ts'
import type { IdempotencyStore } from '../../application/call-tool.ts'
import type { ToolResult } from '../providers/registry.ts'

export function idempotencyStore(pool: Pool): IdempotencyStore {
  return {
    async get(workspaceId, key) {
      const { rows } = await pool.query(
        `SELECT result FROM idempotency_keys
         WHERE workspace_id = $1 AND key = $2 AND created_at > now() - interval '24 hours'`,
        [workspaceId, key],
      )
      return (rows[0]?.result as ToolResult) ?? null
    },

    async put(workspaceId, key, result) {
      await pool.query(
        `INSERT INTO idempotency_keys (workspace_id, key, result) VALUES ($1,$2,$3)
         ON CONFLICT (workspace_id, key) DO NOTHING`,
        [workspaceId, key, JSON.stringify(result)],
      )
    },
  }
}
