import { GatewayError } from '../domain/errors.ts'
import type { Pool } from '../adapters/db/pool.ts'

export type WorkspaceSummary = {
  workspaceId: string
  name: string
  plan: string
  callQuota: number
  callsThisPeriod: number
  createdAt: Date
}

export async function createWorkspace(pool: Pool, name: string): Promise<WorkspaceSummary> {
  const trimmed = name.trim()
  if (!trimmed || trimmed.length > 120) {
    throw new GatewayError('invalid_arguments', 'name must be 1 to 120 characters')
  }
  const { rows } = await pool.query(
    'INSERT INTO workspaces (name) VALUES ($1) RETURNING id, name, plan, call_quota, created_at',
    [trimmed],
  )
  return { ...toSummary(rows[0]), callsThisPeriod: 0 }
}

export async function readWorkspace(pool: Pool, workspaceId: string): Promise<WorkspaceSummary> {
  const { rows } = await pool.query(
    `SELECT w.id, w.name, w.plan, w.call_quota, w.created_at,
            COALESCE(c.calls, 0)::int AS calls
     FROM workspaces w
     LEFT JOIN usage_counters c
       ON c.workspace_id = w.id AND c.period = date_trunc('month', now())::date
     WHERE w.id = $1`,
    [workspaceId],
  )
  const row = rows[0]
  if (!row) throw new GatewayError('tool_not_found', 'workspace not found')
  return { ...toSummary(row), callsThisPeriod: row.calls }
}

export async function applyPlan(
  pool: Pool,
  workspaceId: string,
  input: { plan?: string; callQuota?: number },
): Promise<WorkspaceSummary> {
  if (input.callQuota !== undefined && (!Number.isInteger(input.callQuota) || input.callQuota < 0)) {
    throw new GatewayError('invalid_arguments', 'call_quota must be a non negative integer')
  }
  // COALESCE keeps a partial patch partial: sending only a plan must not reset
  // the quota a webhook set a moment earlier.
  const { rowCount } = await pool.query(
    `UPDATE workspaces
     SET plan = COALESCE($2, plan), call_quota = COALESCE($3, call_quota)
     WHERE id = $1`,
    [workspaceId, input.plan ?? null, input.callQuota ?? null],
  )
  if (!rowCount) throw new GatewayError('tool_not_found', 'workspace not found')
  return readWorkspace(pool, workspaceId)
}

function toSummary(row: {
  id: string
  name: string
  plan: string
  call_quota: number
  created_at: Date
}): Omit<WorkspaceSummary, 'callsThisPeriod'> {
  return {
    workspaceId: row.id,
    name: row.name,
    plan: row.plan,
    callQuota: row.call_quota,
    createdAt: row.created_at,
  }
}
