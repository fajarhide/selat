import { afterAll, describe, expect, it } from 'vitest'
import { closeTestServers, startTestServer, EPHEMERAL_FLOOR } from './helpers/server.ts'
import { testPool } from './helpers/db.ts'

afterAll(async () => {
  await closeTestServers()
  await (await testPool()).end()
})

describe('test server ports', () => {
  // Guards #14: with listen(0) these land in the ephemeral range, where an
  // unrelated local process can already hold the port the suite then addresses.
  it('binds below the ephemeral range, and each server gets its own port', async () => {
    const first = await startTestServer()
    const second = await startTestServer({ reset: false })

    for (const started of [first, second]) {
      expect((started.server.address() as { port: number }).port).toBeLessThan(EPHEMERAL_FLOOR)
    }
    expect(first.base).not.toBe(second.base)
  })
})
