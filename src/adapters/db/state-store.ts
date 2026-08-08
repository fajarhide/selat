import type { Pool } from './pool.ts'

export type OauthStateRow = { workspaceId: string; prefix: string; verifier: string }

export interface StateStore {
  put(row: OauthStateRow & { state: string }): Promise<void>
  consume(state: string): Promise<OauthStateRow | null>
}

const TTL_MINUTES = 10

export function stateStore(pool: Pool): StateStore {
  return {
    async put(row) {
      await pool.query(
        'INSERT INTO oauth_states (state, workspace_id, prefix, verifier) VALUES ($1,$2,$3,$4)',
        [row.state, row.workspaceId, row.prefix, row.verifier],
      )
    },

    // Delete and return in one statement, so a replayed state can never be
    // consumed twice even under concurrent callbacks.
    async consume(state) {
      const { rows } = await pool.query(
        `DELETE FROM oauth_states
         WHERE state = $1 AND created_at > now() - interval '${TTL_MINUTES} minutes'
         RETURNING workspace_id, prefix, verifier`,
        [state],
      )
      const row = rows[0]
      if (!row) {
        // Drop an expired row too, so the table cannot grow without bound.
        // isolation-exempt: consume is what discovers the workspace, so it has
        // none to filter on. The state is a 24 byte random primary key and the
        // statement reads nothing, so it can only delete the row the caller
        // already presented.
        await pool.query('DELETE FROM oauth_states WHERE state = $1', [state])
        return null
      }
      return { workspaceId: row.workspace_id, prefix: row.prefix, verifier: row.verifier }
    },
  }
}
