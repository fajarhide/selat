import { GatewayError } from '../domain/errors.ts'
import type { Pool } from '../adapters/db/pool.ts'

export type UsageReport = {
  period: string
  calls: number
  quota: number
  byProvider: { provider: string; calls: number }[]
  daily: { day: string; calls: number }[]
  recent: { tool: string; outcome: string; latencyMs: number; createdAt: Date }[]
}

export type MeterWindow = {
  since: Date
  until: Date
  calls: number
}

/**
 * Four small reads rather than one join: the recent rows would otherwise fan
 * out across every group and the counts would have to be rebuilt in JavaScript.
 * Each one carries the workspace predicate, which is what the isolation guard
 * checks and what stops a report crossing tenants.
 */
export async function usageReport(pool: Pool, workspaceId: string): Promise<UsageReport> {
  const [head, byProvider, daily, recent] = await Promise.all([
    pool.query(
      `SELECT to_char(date_trunc('month', now()), 'YYYY-MM') AS period,
              w.call_quota AS quota,
              COALESCE(c.calls, 0)::int AS calls
       FROM workspaces w
       LEFT JOIN usage_counters c
         ON c.workspace_id = w.id AND c.period = date_trunc('month', now())::date
       WHERE w.id = $1`,
      [workspaceId],
    ),
    pool.query(
      `SELECT provider, count(*)::int AS calls
       FROM usage_events
       WHERE workspace_id = $1 AND created_at >= date_trunc('month', now())
       GROUP BY provider
       ORDER BY calls DESC, provider ASC`,
      [workspaceId],
    ),
    pool.query(
      `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
              count(*)::int AS calls
       FROM usage_events
       WHERE workspace_id = $1
         AND created_at >= date_trunc('day', now()) - interval '29 days'
       GROUP BY 1
       ORDER BY 1`,
      [workspaceId],
    ),
    pool.query(
      `SELECT tool, outcome, latency_ms, created_at
       FROM usage_events
       WHERE workspace_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 20`,
      [workspaceId],
    ),
  ])

  const summary = head.rows[0]
  if (!summary) throw new GatewayError('tool_not_found', 'workspace not found')

  return {
    period: summary.period,
    calls: summary.calls,
    quota: summary.quota,
    byProvider: byProvider.rows.map((row) => ({ provider: row.provider, calls: row.calls })),
    // A quiet day is absent, not zero. The chart draws the gap; filling it here
    // would hand the caller rows the database never held.
    daily: daily.rows.map((row) => ({ day: row.day, calls: row.calls })),
    recent: recent.rows.map((row) => ({
      tool: row.tool,
      outcome: row.outcome,
      latencyMs: row.latency_ms,
      createdAt: row.created_at,
    })),
  }
}

/**
 * The caller feeds `until` back as the next `since`, so the window is exclusive
 * below and inclusive above and every event is billed exactly once. `now()` is
 * evaluated once per statement, which is why the bound that is counted is the
 * same instant that is handed back.
 *
 * It is truncated to milliseconds because the cursor round trips through JSON,
 * and a microsecond lost there would replay that sliver on the next run.
 * GREATEST keeps a cursor from walking backwards when a caller sends a `since`
 * ahead of the database clock: that window counts nothing and returns itself.
 */
export async function meterWindow(
  pool: Pool,
  workspaceId: string,
  since: string | undefined,
): Promise<MeterWindow> {
  if (typeof since !== 'string' || Number.isNaN(Date.parse(since))) {
    throw new GatewayError('invalid_arguments', 'since must be an ISO 8601 timestamp')
  }
  const { rows } = await pool.query(
    `SELECT GREATEST($2::timestamptz, date_trunc('milliseconds', now())) AS until,
            count(*)::int AS calls
     FROM usage_events
     WHERE workspace_id = $1
       AND created_at > $2::timestamptz
       AND created_at <= date_trunc('milliseconds', now())`,
    [workspaceId, since],
  )
  return { since: new Date(since), until: rows[0].until, calls: rows[0].calls }
}
