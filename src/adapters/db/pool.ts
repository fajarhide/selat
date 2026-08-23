import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

/**
 * The five methods the codebase actually uses, rather than pg.Pool whole. Both
 * a real Postgres and the embedded one satisfy this, and nothing above the
 * store layer can tell them apart.
 */
export type QueryResult<R = any> = { rows: R[]; rowCount: number | null }

export type PoolClient = {
  query<R = any>(text: string, params?: unknown[]): Promise<QueryResult<R>>
  release(): void
}

export type Pool = {
  query<R = any>(text: string, params?: unknown[]): Promise<QueryResult<R>>
  connect(): Promise<PoolClient>
  end(): Promise<void>
}

// The default suits a server that owns its database. A small host, or a pooler
// in front doing the sharing, wants fewer, and neither is worth a rebuild.
export function createPool(databaseUrl: string, max = 10): Pool {
  return new pg.Pool({ connectionString: databaseUrl, max }) as unknown as Pool
}

/** Found by walking up rather than by counting directories, because the
 *  compiled tree adds a level and a package started from somebody else's
 *  working directory cannot use a relative path at all. */
function packagedMigrations(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let up = 0; up < 6; up += 1) {
    const candidate = join(dir, 'migrations')
    if (existsSync(candidate)) return candidate
    dir = dirname(dir)
  }
  throw new Error('migrations directory not found above ' + fileURLToPath(import.meta.url))
}

// ponytail: numbered SQL files applied in order, tracked in one table. Swap for
// a migration framework only if branching migrations become a real problem.
export async function runMigrations(pool: Pool, dir = packagedMigrations()): Promise<void> {
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
