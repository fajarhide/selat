import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'

export type Pool = pg.Pool

export function createPool(databaseUrl: string): Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 })
}

// ponytail: numbered SQL files applied in order, tracked in one table. Swap for
// a migration framework only if branching migrations become a real problem.
export async function runMigrations(pool: Pool, dir = 'migrations'): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name       text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  )
  const files = (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort()
  for (const file of files) {
    const { rowCount } = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file])
    if (rowCount) continue
    const sql = await readFile(join(dir, file), 'utf8')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw new Error(`migration ${file} failed: ${(err as Error).message}`)
    } finally {
      client.release()
    }
  }
}
