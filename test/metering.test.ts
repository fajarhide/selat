import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { assertQuota, recordAudit, recordCall } from '../src/application/metering.ts'
import { resetDb, seedWorkspace, testPool } from './helpers/db.ts'

const pool = await testPool()
afterAll(() => pool.end())

let workspaceId = ''
beforeEach(async () => {
  await resetDb(pool)
  workspaceId = await seedWorkspace(pool)
})

const entry = (over: Partial<Parameters<typeof recordCall>[1]> = {}) => ({
  workspaceId,
  credentialId: null,
  provider: 'fake',
  tool: 'echo',
  outcome: 'ok',
  latencyMs: 3,
  requestId: 'r1',
  ...over,
})

describe('metering', () => {
  it('counts a successful call', async () => {
    await recordCall(pool, entry())
    const { rows } = await pool.query('SELECT calls FROM usage_counters WHERE workspace_id = $1', [
      workspaceId,
    ])
    expect(rows[0].calls).toBe(1)
  })

  it('counts a failed call too, since it consumed upstream capacity', async () => {
    await recordCall(pool, entry({ outcome: 'upstream_error', requestId: 'r2' }))
    const { rows } = await pool.query('SELECT calls FROM usage_counters WHERE workspace_id = $1', [
      workspaceId,
    ])
    expect(rows[0].calls).toBe(1)
  })

  it('accumulates across calls in the same period', async () => {
    await recordCall(pool, entry())
    await recordCall(pool, entry({ requestId: 'r2' }))
    const { rows } = await pool.query('SELECT calls FROM usage_counters WHERE workspace_id = $1', [
      workspaceId,
    ])
    expect(rows[0].calls).toBe(2)
  })

  it('writes one event per call, carrying the request id', async () => {
    await recordCall(pool, entry({ requestId: 'r4' }))
    const { rows } = await pool.query('SELECT request_id FROM usage_events WHERE workspace_id = $1', [
      workspaceId,
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].request_id).toBe('r4')
  })

  it('never records tool arguments', async () => {
    await recordCall(pool, entry())
    const { rows } = await pool.query('SELECT * FROM usage_events WHERE workspace_id = $1', [
      workspaceId,
    ])
    expect(Object.keys(rows[0])).not.toContain('args')
    expect(Object.keys(rows[0])).not.toContain('arguments')
  })

  it('passes quota while there is headroom', async () => {
    await expect(assertQuota(pool, workspaceId)).resolves.toBeUndefined()
  })

  it('throws quota_exceeded once the workspace quota is spent', async () => {
    await pool.query('UPDATE workspaces SET call_quota = 1 WHERE id = $1', [workspaceId])
    await recordCall(pool, entry())
    await expect(assertQuota(pool, workspaceId)).rejects.toMatchObject({ code: 'quota_exceeded' })
  })

  it('rejects an unknown workspace rather than serving it', async () => {
    await expect(
      assertQuota(pool, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toMatchObject({ code: 'invalid_credential' })
  })

  it('records an audit entry', async () => {
    await recordAudit(pool, {
      workspaceId,
      actor: 'credential:abc',
      action: 'connection.connected',
      target: 'github',
      requestId: 'r9',
    })
    const { rows } = await pool.query('SELECT action, target FROM audit_log WHERE workspace_id = $1', [
      workspaceId,
    ])
    expect(rows[0]).toMatchObject({ action: 'connection.connected', target: 'github' })
  })
})
