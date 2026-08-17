import { beforeAll, describe, expect, it } from 'vitest'
import { idempotencyStore } from '../src/adapters/db/idempotency-store.ts'
import { seedWorkspace, testPool } from './helpers/db.ts'
import type { Pool } from '../src/adapters/db/pool.ts'

let pool: Pool

beforeAll(async () => {
  pool = await testPool()
})

const result = { content: { body: 'the upstream response' }, hasMore: false, nextCursor: null }

async function age(workspaceId: string, key: string, hours: number): Promise<void> {
  await pool.query(
    `UPDATE idempotency_keys SET created_at = now() - ($3 || ' hours')::interval
     WHERE workspace_id = $1 AND key = $2`,
    [workspaceId, key, String(hours)],
  )
}

describe('idempotency retention', () => {
  it('drops rows past the replay window on the next write', async () => {
    const store = idempotencyStore(pool)
    const workspaceId = await seedWorkspace(pool, 'retention')

    await store.put(workspaceId, 'old', result)
    await age(workspaceId, 'old', 25)
    // The row already reads as absent, which is what made it easy to leave
    // behind: nothing in the request path ever notices it again.
    expect(await store.get(workspaceId, 'old')).toBeNull()

    await store.put(workspaceId, 'new', result)

    const { rows } = await pool.query<{ key: string }>(
      'SELECT key FROM idempotency_keys WHERE workspace_id = $1 ORDER BY key',
      [workspaceId],
    )
    expect(rows.map((r) => r.key)).toEqual(['new'])
  })

  it('leaves a row inside the window alone', async () => {
    const store = idempotencyStore(pool)
    const workspaceId = await seedWorkspace(pool, 'retention-live')

    await store.put(workspaceId, 'recent', result)
    await age(workspaceId, 'recent', 23)
    await store.put(workspaceId, 'another', result)

    expect(await store.get(workspaceId, 'recent')).toEqual(result)
  })

  it('expires only the workspace doing the writing', async () => {
    const store = idempotencyStore(pool)
    const mine = await seedWorkspace(pool, 'retention-mine')
    const theirs = await seedWorkspace(pool, 'retention-theirs')

    await store.put(theirs, 'old', result)
    await age(theirs, 'old', 25)
    await store.put(mine, 'fresh', result)

    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM idempotency_keys WHERE workspace_id = $1',
      [theirs],
    )
    expect(rows[0]?.n).toBe(1)
  })
})
