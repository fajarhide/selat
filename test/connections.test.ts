import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  beginConnection,
  completeConnection,
  disconnect,
  type ConnectionDeps,
} from '../src/application/connections.ts'
import { createRegistry, type ProviderAdapter } from '../src/adapters/providers/registry.ts'
import { fakeProvider } from '../src/adapters/providers/fake.ts'
import { stateStore } from '../src/adapters/db/state-store.ts'
import { grantStore } from '../src/adapters/db/grant-store.ts'
import { enablementStore } from '../src/adapters/db/enablement-store.ts'
import { resetDb, seedWorkspace, testPool } from './helpers/db.ts'

const pool = await testPool()
afterAll(() => pool.end())

let workspaceId = ''
beforeEach(async () => {
  await resetDb(pool)
  workspaceId = await seedWorkspace(pool)
})

// A second provider on the same grant, to prove a disconnect does not strand
// the sibling that still needs the tokens.
function siblingProvider(): ProviderAdapter {
  const base = fakeProvider()
  return { ...base, id: 'fake2', prefix: 'fakb', grantId: 'fake' }
}

function deps(overrides: Partial<ConnectionDeps> = {}): ConnectionDeps {
  return {
    registry: createRegistry([fakeProvider(), siblingProvider()]),
    publicUrl: 'https://app.example.com',
    oauthConfig: () => ({
      authorizeUrl: 'https://vendor.example.com/authorize',
      tokenUrl: 'https://vendor.example.com/token',
      clientId: 'cid',
    }),
    states: stateStore(pool),
    grants: grantStore(pool, Buffer.alloc(32, 3)),
    enablement: enablementStore(pool),
    exchange: async () => ({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: [],
    }),
    ...overrides,
  }
}

describe('connections', () => {
  it('returns an S256 authorize url and stores the verifier', async () => {
    const { url, state } = await beginConnection(deps(), { workspaceId, prefix: 'fake' })
    const parsed = new URL(url)
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256')
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      'https://app.example.com/v1/connections/fake/callback',
    )
    const { rows } = await pool.query('SELECT workspace_id, prefix FROM oauth_states WHERE state = $1', [state])
    expect(rows[0].workspace_id).toBe(workspaceId)
    expect(rows[0].prefix).toBe('fake')
  })

  it('rejects an unknown state', async () => {
    await expect(completeConnection(deps(), { state: 'nope', code: 'c' })).rejects.toMatchObject({
      code: 'invalid_arguments',
    })
  })

  it('stores an encrypted grant and enables the prefix on a valid callback', async () => {
    const shared = deps()
    const { state } = await beginConnection(shared, { workspaceId, prefix: 'fake' })
    const done = await completeConnection(shared, { state, code: 'code-1' })
    expect(done.prefix).toBe('fake')

    const stored = await pool.query(
      'SELECT access_token, refresh_token FROM grants WHERE workspace_id = $1 AND grant_id = $2',
      [workspaceId, 'fake'],
    )
    expect(JSON.stringify(stored.rows[0].access_token)).not.toContain('access-1')
    expect(await shared.grants.load(workspaceId, 'fake')).toMatchObject({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      reauthNeeded: false,
    })
    expect(await shared.enablement.enabledPrefixes(workspaceId)).toContain('fake')
  })

  it('refuses a replayed state', async () => {
    const shared = deps()
    const { state } = await beginConnection(shared, { workspaceId, prefix: 'fake' })
    await completeConnection(shared, { state, code: 'code-1' })
    await expect(completeConnection(shared, { state, code: 'code-1' })).rejects.toMatchObject({
      code: 'invalid_arguments',
    })
  })

  it('refuses a state older than its ten minute window', async () => {
    const shared = deps()
    const { state } = await beginConnection(shared, { workspaceId, prefix: 'fake' })
    await pool.query(
      "UPDATE oauth_states SET created_at = now() - interval '11 minutes' WHERE state = $1",
      [state],
    )
    await expect(completeConnection(shared, { state, code: 'c' })).rejects.toMatchObject({
      code: 'invalid_arguments',
    })
    const left = await pool.query('SELECT count(*)::int AS n FROM oauth_states')
    expect(left.rows[0].n).toBe(0)
  })

  it('drops the grant on disconnect when no other prefix shares it', async () => {
    const shared = deps()
    const { state } = await beginConnection(shared, { workspaceId, prefix: 'fake' })
    await completeConnection(shared, { state, code: 'c' })

    await disconnect(shared, { workspaceId, prefix: 'fake' })
    expect(await shared.enablement.enabledPrefixes(workspaceId)).not.toContain('fake')
    expect(await shared.grants.load(workspaceId, 'fake')).toBeNull()
  })

  it('keeps the grant when a sibling prefix still uses it', async () => {
    const shared = deps()
    const first = await beginConnection(shared, { workspaceId, prefix: 'fake' })
    await completeConnection(shared, { state: first.state, code: 'c' })
    const second = await beginConnection(shared, { workspaceId, prefix: 'fakb' })
    await completeConnection(shared, { state: second.state, code: 'c' })

    await disconnect(shared, { workspaceId, prefix: 'fake' })
    expect(await shared.enablement.enabledPrefixes(workspaceId)).toEqual(['fakb'])
    expect(await shared.grants.load(workspaceId, 'fake')).not.toBeNull()
  })
})
