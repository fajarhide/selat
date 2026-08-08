import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mintCredential } from '../src/domain/credential.ts'
import { credentialStore } from '../src/adapters/db/credential-store.ts'
import { resetDb, seedWorkspace, testPool } from './helpers/db.ts'

const pool = await testPool()
afterAll(() => pool.end())
beforeEach(() => resetDb(pool))

describe('credential store', () => {
  it('resolves the workspace behind a valid token', async () => {
    const workspaceId = await seedWorkspace(pool)
    const { token, hash, last4 } = mintCredential('live')
    await pool.query(
      'INSERT INTO gateway_credentials (workspace_id, token_hash, last4) VALUES ($1,$2,$3)',
      [workspaceId, hash, last4],
    )
    const found = await credentialStore(pool).findByHash(hash)
    expect(found?.workspaceId).toBe(workspaceId)
    expect(found?.scope).toEqual({ providers: null, readOnly: false })
    expect(token).toContain('slt_live_')
  })

  it('returns null for an unknown token', async () => {
    expect(await credentialStore(pool).findByHash('deadbeef')).toBeNull()
  })

  it('surfaces a revoked credential so the middleware can reject it', async () => {
    const workspaceId = await seedWorkspace(pool)
    const { hash, last4 } = mintCredential('live')
    await pool.query(
      'INSERT INTO gateway_credentials (workspace_id, token_hash, last4, revoked_at) VALUES ($1,$2,$3, now())',
      [workspaceId, hash, last4],
    )
    const found = await credentialStore(pool).findByHash(hash)
    expect(found?.revokedAt).toBeInstanceOf(Date)
  })

  it('reads a restricted scope back exactly as stored', async () => {
    const workspaceId = await seedWorkspace(pool)
    const { hash, last4 } = mintCredential('live')
    await pool.query(
      'INSERT INTO gateway_credentials (workspace_id, token_hash, last4, scope) VALUES ($1,$2,$3,$4)',
      [workspaceId, hash, last4, JSON.stringify({ providers: ['github'], readOnly: true })],
    )
    const found = await credentialStore(pool).findByHash(hash)
    expect(found?.scope).toEqual({ providers: ['github'], readOnly: true })
  })

  it('records last use', async () => {
    const workspaceId = await seedWorkspace(pool)
    const { hash, last4 } = mintCredential('live')
    const { rows } = await pool.query(
      'INSERT INTO gateway_credentials (workspace_id, token_hash, last4) VALUES ($1,$2,$3) RETURNING id',
      [workspaceId, hash, last4],
    )
    await credentialStore(pool).touch(workspaceId, rows[0].id)
    const after = await pool.query(
      'SELECT last_used_at FROM gateway_credentials WHERE id = $1 AND workspace_id = $2',
      [rows[0].id, workspaceId],
    )
    expect(after.rows[0].last_used_at).toBeInstanceOf(Date)
  })

  it('will not stamp a credential belonging to another workspace', async () => {
    const mine = await seedWorkspace(pool, 'mine')
    const theirs = await seedWorkspace(pool, 'theirs')
    const { hash, last4 } = mintCredential('live')
    const { rows } = await pool.query(
      'INSERT INTO gateway_credentials (workspace_id, token_hash, last4) VALUES ($1,$2,$3) RETURNING id',
      [theirs, hash, last4],
    )
    await credentialStore(pool).touch(mine, rows[0].id)
    const after = await pool.query(
      'SELECT last_used_at FROM gateway_credentials WHERE id = $1 AND workspace_id = $2',
      [rows[0].id, theirs],
    )
    expect(after.rows[0].last_used_at).toBeNull()
  })
})
