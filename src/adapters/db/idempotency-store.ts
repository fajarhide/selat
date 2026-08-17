import type { Pool } from './pool.ts'
import type { IdempotencyStore } from '../../application/call-tool.ts'
import type { ToolResult } from '../providers/registry.ts'

/** A replay is only useful while the caller is still retrying. */
const TTL = '24 hours'

export function idempotencyStore(pool: Pool): IdempotencyStore {
  return {
    async get(workspaceId, key) {
      const { rows } = await pool.query(
        `SELECT result FROM idempotency_keys
         WHERE workspace_id = $1 AND key = $2 AND created_at > now() - interval '${TTL}'`,
        [workspaceId, key],
      )
      return (rows[0]?.result as ToolResult) ?? null
    },

    async put(workspaceId, key, result) {
      // This row holds the upstream response body, which for a mail or a file
      // provider is the customer's content. Reading it already stops at the
      // TTL, so anything older is unreachable by design and kept for nothing.
      // Deleting here rather than on a schedule keeps it to one round trip and
      // needs no cron: the workspace that writes is the workspace that expires.
      await pool.query(
        `DELETE FROM idempotency_keys
         WHERE workspace_id = $1 AND created_at <= now() - interval '${TTL}'`,
        [workspaceId],
      )
      await pool.query(
        `INSERT INTO idempotency_keys (workspace_id, key, result) VALUES ($1,$2,$3)
         ON CONFLICT (workspace_id, key) DO NOTHING`,
        [workspaceId, key, JSON.stringify(result)],
      )
    },
  }
}
