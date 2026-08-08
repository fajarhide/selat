import { createPool, runMigrations, type Pool } from '../../src/adapters/db/pool.ts'

let shared: Pool | undefined

export async function testPool(): Promise<Pool> {
  if (shared) return shared
  const url = process.env.TEST_DATABASE_URL
  if (!url) throw new Error('TEST_DATABASE_URL is required for integration tests')
  const pool = createPool(url)
  await runMigrations(pool)
  shared = pool
  return pool
}

export async function resetDb(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE workspaces CASCADE')
}

export async function seedWorkspace(pool: Pool, name = 'acme'): Promise<string> {
  const { rows } = await pool.query('INSERT INTO workspaces (name) VALUES ($1) RETURNING id', [name])
  return rows[0].id as string
}
