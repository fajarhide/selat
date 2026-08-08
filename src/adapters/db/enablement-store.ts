import type { Pool } from './pool.ts'
import type { EnablementStore } from '../../ports/stores.ts'

export function enablementStore(pool: Pool): EnablementStore {
  return {
    async enabledPrefixes(workspaceId) {
      const { rows } = await pool.query(
        'SELECT prefix FROM provider_enablements WHERE workspace_id = $1',
        [workspaceId],
      )
      return rows.map((row) => row.prefix as string)
    },

    async disabledTools(workspaceId) {
      const { rows } = await pool.query(
        'SELECT tool_name FROM tool_overrides WHERE workspace_id = $1 AND enabled = false',
        [workspaceId],
      )
      return new Set(rows.map((row) => row.tool_name as string))
    },

    async enable(workspaceId, prefix) {
      await pool.query(
        `INSERT INTO provider_enablements (workspace_id, prefix) VALUES ($1, $2)
         ON CONFLICT (workspace_id, prefix) DO NOTHING`,
        [workspaceId, prefix],
      )
    },

    async disable(workspaceId, prefix) {
      await pool.query('DELETE FROM provider_enablements WHERE workspace_id = $1 AND prefix = $2', [
        workspaceId,
        prefix,
      ])
    },

    async setToolOverride(workspaceId, toolName, enabled) {
      await pool.query(
        `INSERT INTO tool_overrides (workspace_id, tool_name, enabled) VALUES ($1,$2,$3)
         ON CONFLICT (workspace_id, tool_name) DO UPDATE SET enabled = EXCLUDED.enabled`,
        [workspaceId, toolName, enabled],
      )
    },
  }
}
