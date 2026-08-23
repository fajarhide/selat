import { describe, expect, it } from 'vitest'
import { createEmbeddedPool } from '../src/adapters/db/embedded.ts'
import { runMigrations } from '../src/adapters/db/pool.ts'

describe('embedded database', () => {
  it('runs the real migrations and answers a parameterised query', async () => {
    const pool = createEmbeddedPool()
    await runMigrations(pool)

    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1`,
      ['grants'],
    )
    expect(tables.rows[0]?.table_name).toBe('grants')

    // The types a SQLite rewrite would have had to give up, all in one row.
    const created = await pool.query<{ id: string; name: string }>(
      'INSERT INTO workspaces (name) VALUES ($1) RETURNING id, name',
      ['acme'],
    )
    expect(created.rows[0]?.name).toBe('acme')
    expect(created.rows[0]?.id).toMatch(/^[0-9a-f-]{36}$/)

    const ws = created.rows[0]!.id
    await pool.query(
      `INSERT INTO grants (workspace_id, grant_id, access_token, scopes)
       VALUES ($1, 'google', $2, $3)`,
      [ws, JSON.stringify({ ciphertext: 'x' }), ['a', 'b']],
    )
    const grant = await pool.query<{ scopes: string[]; access_token: { ciphertext: string } }>(
      'SELECT scopes, access_token FROM grants WHERE workspace_id = $1',
      [ws],
    )
    expect(grant.rows[0]?.scopes).toEqual(['a', 'b'])
    expect(grant.rows[0]?.access_token.ciphertext).toBe('x')

    await pool.end()
  })

  it('applies each migration once, so a second start is not a crash', async () => {
    // PGlite answers affectedRows: 0 for a select. Reported as the row count it
    // makes runMigrations think nothing has been applied, and the second start
    // dies on "relation workspaces already exists".
    const pool = createEmbeddedPool()
    await runMigrations(pool)
    const first = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM schema_migrations')

    await expect(runMigrations(pool)).resolves.toBeUndefined()

    const second = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM schema_migrations',
    )
    expect(second.rows[0]?.n).toBe(first.rows[0]?.n)
    await pool.end()
  })

  it('counts rows the way pg does, returned for a select and affected for a write', async () => {
    const pool = createEmbeddedPool()
    await runMigrations(pool)
    await pool.query('INSERT INTO workspaces (name) VALUES ($1), ($2)', ['a', 'b'])

    const selected = await pool.query('SELECT id FROM workspaces')
    expect(selected.rowCount).toBe(2)

    const updated = await pool.query('UPDATE workspaces SET plan = $1', ['pro'])
    expect(updated.rowCount).toBe(2)

    const none = await pool.query('SELECT id FROM workspaces WHERE name = $1', ['missing'])
    expect(none.rowCount).toBe(0)
    await pool.end()
  })

  it('serialises clients, so two transactions cannot commit each other', async () => {
    // PGlite is one connection. Without the queue both BEGIN blocks land in the
    // same transaction and the rollback below would take the other row with it.
    const pool = createEmbeddedPool()
    await runMigrations(pool)

    const first = await pool.connect()
    const second = pool.connect()
    let secondReady = false
    void second.then(() => {
      secondReady = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(secondReady).toBe(false)

    await first.query('BEGIN')
    await first.query("INSERT INTO workspaces (name) VALUES ('kept')")
    await first.query('COMMIT')
    first.release()

    const client = await second
    await client.query('BEGIN')
    await client.query("INSERT INTO workspaces (name) VALUES ('rolled back')")
    await client.query('ROLLBACK')
    client.release()

    const names = await pool.query<{ name: string }>('SELECT name FROM workspaces ORDER BY name')
    expect(names.rows.map((row) => row.name)).toEqual(['kept'])

    await pool.end()
  })
})
