import { GatewayError } from '../domain/errors.ts'
import { parseToolName } from '../domain/tool-names.ts'
import { callTool, type CallDeps, type CallInput } from './call-tool.ts'
import type { ToolResult } from '../adapters/providers/registry.ts'
import type { Pool } from '../adapters/db/pool.ts'

export type UsageEntry = {
  workspaceId: string
  credentialId: string | null
  provider: string
  tool: string
  outcome: string
  latencyMs: number
  requestId: string
}

export async function recordCall(pool: Pool, entry: UsageEntry): Promise<void> {
  const client = await pool.connect()
  try {
    // The event and the counter move together, so a served call can never go
    // uncounted and a counted call can never lack its event.
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO usage_events
         (workspace_id, credential_id, provider, tool, outcome, latency_ms, request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        entry.workspaceId,
        entry.credentialId,
        entry.provider,
        entry.tool,
        entry.outcome,
        entry.latencyMs,
        entry.requestId,
      ],
    )
    await client.query(
      `INSERT INTO usage_counters (workspace_id, period, calls)
       VALUES ($1, date_trunc('month', now())::date, 1)
       ON CONFLICT (workspace_id, period) DO UPDATE SET calls = usage_counters.calls + 1`,
      [entry.workspaceId],
    )
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

export async function assertQuota(pool: Pool, workspaceId: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT w.call_quota, COALESCE(c.calls, 0) AS calls
     FROM workspaces w
     LEFT JOIN usage_counters c
       ON c.workspace_id = w.id AND c.period = date_trunc('month', now())::date
     WHERE w.id = $1`,
    [workspaceId],
  )
  const row = rows[0]
  if (!row) throw new GatewayError('invalid_credential', 'workspace not found')
  if (row.calls >= row.call_quota) {
    throw new GatewayError('quota_exceeded', 'monthly call quota is spent', { retryAfter: 3600 })
  }
}

export async function recordAudit(
  pool: Pool,
  entry: { workspaceId: string; actor: string; action: string; target?: string; requestId?: string },
): Promise<void> {
  await pool.query(
    'INSERT INTO audit_log (workspace_id, actor, action, target, request_id) VALUES ($1,$2,$3,$4,$5)',
    [entry.workspaceId, entry.actor, entry.action, entry.target ?? null, entry.requestId ?? null],
  )
}

/**
 * The surfaces call this rather than `callTool` directly, so metering lives
 * outside the pipeline and the pipeline stays testable with no database.
 */
export async function meteredCall(
  pool: Pool,
  deps: CallDeps,
  input: CallInput & { credentialId: string },
): Promise<ToolResult> {
  await assertQuota(pool, input.workspaceId)
  const started = Date.now()
  let outcome = 'ok'
  try {
    return await callTool(deps, input)
  } catch (err) {
    outcome = err instanceof GatewayError ? err.code : 'internal_error'
    throw err
  } finally {
    const { prefix, tool } = safeParse(input.name)
    // A failed call still consumed upstream capacity, so it is counted. The
    // record is best effort: a metering failure must not mask the tool result.
    await recordCall(pool, {
      workspaceId: input.workspaceId,
      credentialId: input.credentialId,
      provider: prefix,
      tool,
      outcome,
      latencyMs: Date.now() - started,
      requestId: input.requestId,
    }).catch((err) =>
      console.error(
        JSON.stringify({ msg: 'metering failed', request_id: input.requestId, error: String(err) }),
      ),
    )
  }
}

function safeParse(name: string): { prefix: string; tool: string } {
  try {
    return parseToolName(name)
  } catch {
    return { prefix: 'unknown', tool: name.slice(0, 64) }
  }
}
