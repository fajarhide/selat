import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
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
    const second = await startTestServer()

    for (const started of [first, second]) {
      expect((started.server.address() as { port: number }).port).toBeLessThan(EPHEMERAL_FLOOR)
    }
    expect(first.base).not.toBe(second.base)
  })

  // The first attempt at #14 changed the helper and left three files binding on
  // their own, so the collision stayed reachable. Grepping is what would have
  // caught that, so the suite greps itself.
  it('leaves no ephemeral bind anywhere in the suite', async () => {
    // Escaped so this file does not match itself.
    const ephemeralBind = /\.listen\(0\)/
    const names = await readdir('test', { recursive: true })
    const offenders: string[] = []
    for (const name of names) {
      if (!name.endsWith('.ts')) continue
      const path = join('test', name)
      if (ephemeralBind.test(await readFile(path, 'utf8'))) offenders.push(path)
    }
    expect(offenders).toEqual([])
  })
})
