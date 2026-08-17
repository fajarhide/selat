import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeTestServers, startTestServer, testConfig } from './helpers/server.ts'
import { seedWorkspace } from './helpers/db.ts'
import { meterWindow } from '../src/application/usage-report.ts'
import { json } from './helpers/http.ts'
import type { Pool } from '../src/adapters/db/pool.ts'

const TOKEN = 'slt_svc_0123456789abcdef0123456789abcdef0123456789a'
const auth = { authorization: `Bearer ${TOKEN}` }

let base: string
let pool: Pool
let workspaceId: string

beforeAll(async () => {
  const started = await startTestServer({
    overrides: { config: { ...testConfig, serviceToken: TOKEN } },
  })
  base = started.base
  pool = started.pool
  workspaceId = started.workspaceId
})

afterAll(async () => {
  await closeTestServers()
})

/** Milliseconds, because a cursor that round trips through JSON has no more. */
async function dbNow(): Promise<Date> {
  const { rows } = await pool.query(`SELECT date_trunc('milliseconds', now()) AS t`)
  return rows[0].t as Date
}

async function seedEvent(
  target: string,
  input: { provider?: string; tool?: string; outcome?: string; createdAt: Date },
): Promise<Date> {
  const { rows } = await pool.query(
    `INSERT INTO usage_events
       (workspace_id, provider, tool, outcome, latency_ms, request_id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING created_at`,
    [
      target,
      input.provider ?? 'github',
      input.tool ?? 'issues_list',
      input.outcome ?? 'ok',
      12,
      'seed',
      input.createdAt,
    ],
  )
  return rows[0].created_at as Date
}

function meterUrl(target: string, since: string): string {
  return `${base}/v1/admin/workspaces/${target}/usage/meter?since=${encodeURIComponent(since)}`
}

describe('admin usage report', () => {
  it('reports the period, the provider grouping and a daily series with no gap filling', async () => {
    const now = new Date()
    const threeDaysAgo = new Date(now.getTime() - 3 * 86_400_000)
    const lastMonth = new Date(now.getTime() - 45 * 86_400_000)
    for (let i = 0; i < 3; i += 1) {
      await seedEvent(workspaceId, { provider: 'github', createdAt: now })
    }
    for (let i = 0; i < 2; i += 1) {
      await seedEvent(workspaceId, {
        provider: 'slack',
        tool: 'post_message',
        createdAt: now,
      })
    }
    await seedEvent(workspaceId, {
      provider: 'stripe',
      tool: 'charges_list',
      createdAt: threeDaysAgo,
    })
    await seedEvent(workspaceId, { provider: 'legacy', tool: 'ping', createdAt: lastMonth })
    await pool.query(
      `INSERT INTO usage_counters (workspace_id, period, calls)
       VALUES ($1, date_trunc('month', now())::date, 6)
       ON CONFLICT (workspace_id, period) DO UPDATE SET calls = 6`,
      [workspaceId],
    )

    const res = await fetch(`${base}/v1/admin/workspaces/${workspaceId}/usage`, { headers: auth })
    const body = await json(res)
    expect(res.status).toBe(200)

    expect(body.period).toMatch(/^\d{4}-\d{2}$/)
    expect(body.calls).toBe(6)
    expect(body.quota).toBe(5000)

    expect(body.by_provider[0]).toEqual({ provider: 'github', calls: 3 })
    expect(body.by_provider[1]).toEqual({ provider: 'slack', calls: 2 })
    expect(body.by_provider.map((p: { provider: string }) => p.provider)).not.toContain('legacy')

    // Two seeded days inside the window, so exactly two rows. Gap filling would
    // hand back thirty.
    expect(body.daily).toHaveLength(2)
    expect(body.daily[0].calls).toBe(1)
    expect(body.daily[1].calls).toBe(5)
    expect(body.daily[0].day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(body.daily[0].day < body.daily[1].day).toBe(true)

    expect(body.recent).toHaveLength(7)
    expect(body.recent[0].tool).toBe('post_message')
    expect(body.recent[0].outcome).toBe('ok')
    expect(body.recent[0].latency_ms).toBe(12)
  })

  it('caps recent at twenty and never reads another workspace', async () => {
    const other = await seedWorkspace(pool, 'other')
    const at = new Date()
    for (let i = 0; i < 25; i += 1) {
      await seedEvent(other, {
        provider: 'notion',
        tool: `t${i}`,
        createdAt: new Date(at.getTime() - i * 1000),
      })
    }

    const theirs = await json(
      await fetch(`${base}/v1/admin/workspaces/${other}/usage`, { headers: auth }),
    )
    expect(theirs.recent).toHaveLength(20)
    expect(theirs.recent[0].tool).toBe('t0')
    expect(theirs.by_provider).toEqual([{ provider: 'notion', calls: 25 }])

    const mine = await json(
      await fetch(`${base}/v1/admin/workspaces/${workspaceId}/usage`, { headers: auth }),
    )
    expect(mine.by_provider.map((p: { provider: string }) => p.provider)).not.toContain('notion')
  })

  it('404s an unknown workspace', async () => {
    const res = await fetch(
      `${base}/v1/admin/workspaces/00000000-0000-4000-8000-000000000000/usage`,
      { headers: auth },
    )
    expect(res.status).toBe(404)
    expect((await json(res)).error.code).toBe('tool_not_found')
  })
})

describe('admin meter window', () => {
  it('is exclusive at the lower bound', async () => {
    const ws = await seedWorkspace(pool, 'meter-lower')
    const boundary = await seedEvent(ws, {
      createdAt: new Date((await dbNow()).getTime() - 5000),
    })

    const onBoundary = await json(
      await fetch(meterUrl(ws, boundary.toISOString()), { headers: auth }),
    )
    expect(onBoundary.calls).toBe(0)

    await seedEvent(ws, { createdAt: new Date(boundary.getTime() + 1) })
    const oneMsLater = await json(
      await fetch(meterUrl(ws, boundary.toISOString()), { headers: auth }),
    )
    expect(oneMsLater.calls).toBe(1)
  })

  it('is inclusive at the upper bound', async () => {
    const ws = await seedWorkspace(pool, 'meter-upper')
    const client = await pool.connect()
    try {
      // now() is the transaction timestamp, so the row and the window boundary
      // are the same instant. Outside a transaction that equality is
      // unreachable. meterWindow only calls query, so a client stands in for
      // the pool here.
      await client.query('BEGIN')
      const inserted = await client.query(
        `INSERT INTO usage_events
           (workspace_id, provider, tool, outcome, latency_ms, request_id, created_at)
         VALUES ($1,'github','issues_list','ok',9,'seed', date_trunc('milliseconds', now()))
         RETURNING created_at`,
        [ws],
      )
      const counted = await meterWindow(
        client as unknown as Pool,
        ws,
        '2000-01-01T00:00:00.000Z',
      )
      expect(counted.calls).toBe(1)
      expect(counted.until.getTime()).toBe((inserted.rows[0].created_at as Date).getTime())
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('chains two windows on until without double counting or skipping', async () => {
    const ws = await seedWorkspace(pool, 'meter-chain')
    const start = new Date((await dbNow()).getTime() - 10_000)
    for (const offset of [1000, 2000, 3000]) {
      await seedEvent(ws, { createdAt: new Date(start.getTime() + offset) })
    }

    const first = await json(await fetch(meterUrl(ws, start.toISOString()), { headers: auth }))
    expect(first.calls).toBe(3)

    const cursor = new Date(first.until)
    const newest = new Date(cursor.getTime() + 2)
    await seedEvent(ws, { createdAt: new Date(cursor.getTime() + 1) })
    await seedEvent(ws, { createdAt: newest })
    // The window closes at the database clock, so an event stamped ahead of it
    // is not billable yet. These two sit 1ms and 2ms past the cursor, and two
    // inserts do not always take that long, which returned 1 about once in ten
    // full-suite runs.
    while ((await dbNow()) < newest) continue

    const second = await json(await fetch(meterUrl(ws, first.until), { headers: auth }))
    expect(second.calls).toBe(2)

    const whole = await json(await fetch(meterUrl(ws, start.toISOString()), { headers: auth }))
    expect(whole.calls).toBe(5)
    expect(first.calls + second.calls).toBe(whole.calls)
  })

  it('refuses a missing or malformed since', async () => {
    for (const query of ['', '?since=', '?since=yesterday', '?since=2026-13-45']) {
      const res = await fetch(
        `${base}/v1/admin/workspaces/${workspaceId}/usage/meter${query}`,
        { headers: auth },
      )
      expect(res.status).toBe(400)
      expect((await json(res)).error.code).toBe('invalid_arguments')
    }
  })

  it('counts nothing for a since in the future and leaves the cursor where it was', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString()
    const res = await fetch(meterUrl(workspaceId, future), { headers: auth })
    const body = await json(res)
    expect(res.status).toBe(200)
    expect(body.calls).toBe(0)
    expect(new Date(body.until).getTime()).toBe(new Date(future).getTime())
  })
})
