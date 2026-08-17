import { randomBytes } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { grantStore } from '../src/adapters/db/grant-store.ts'
import { seedWorkspace, testPool } from './helpers/db.ts'
import type { Pool } from '../src/adapters/db/pool.ts'

let pool: Pool

beforeAll(async () => {
  pool = await testPool()
})

describe('refresh lock', () => {
  it('runs one holder at a time for the same grant', async () => {
    const store = grantStore(pool, randomBytes(32))
    const workspaceId = await seedWorkspace(pool, 'lock-same')
    const order: string[] = []

    const hold = (tag: string, ms: number) =>
      store.withRefreshLock(workspaceId, 'github', async () => {
        order.push(`${tag}:in`)
        await new Promise((resolve) => setTimeout(resolve, ms))
        order.push(`${tag}:out`)
      })

    await Promise.all([hold('a', 60), hold('b', 0)])

    // Interleaving would read a:in, b:in, ..., which is exactly the double
    // refresh this lock exists to stop.
    expect(order.join(' ')).toMatch(/^(a:in a:out b:in b:out|b:in b:out a:in a:out)$/)
  })

  it('does not serialise two different grants', async () => {
    const store = grantStore(pool, randomBytes(32))
    const workspaceId = await seedWorkspace(pool, 'lock-different')
    let inside = 0
    let peak = 0

    const hold = (grantId: string) =>
      store.withRefreshLock(workspaceId, grantId, async () => {
        inside += 1
        peak = Math.max(peak, inside)
        await new Promise((resolve) => setTimeout(resolve, 40))
        inside -= 1
      })

    await Promise.all([hold('github'), hold('google')])
    expect(peak).toBe(2)
  })

  it('releases the lock when the holder throws', async () => {
    const store = grantStore(pool, randomBytes(32))
    const workspaceId = await seedWorkspace(pool, 'lock-throw')

    await expect(
      store.withRefreshLock(workspaceId, 'github', async () => {
        throw new Error('refresh rejected')
      }),
    ).rejects.toThrow('refresh rejected')

    // A leaked lock would hang here until the timeout instead of returning.
    await expect(
      store.withRefreshLock(workspaceId, 'github', async () => 'second'),
    ).resolves.toBe('second')
  })
})
