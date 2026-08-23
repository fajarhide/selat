import { PGlite } from '@electric-sql/pglite'
import type { Pool, PoolClient, QueryResult } from './pool.ts'

/**
 * Postgres itself, compiled to WASM and running in this process, so trying
 * Selat costs no database to install. The SQL is the same SQL: the migrations
 * and every query run unchanged, which is the whole reason this is an adapter
 * rather than a second dialect to maintain.
 *
 * Not for production. One process holds one database file, so there is no
 * second reader and no failover. Setting DATABASE_URL takes this path out of
 * the picture entirely.
 */
/**
 * pg reports rows returned for a select and rows affected for a write, in one
 * number. PGlite keeps them apart and answers affectedRows: 0 for a select, not
 * undefined, so falling back with ?? reports every select as empty. That is not
 * cosmetic: runMigrations skips an applied migration on a truthy rowCount, so a
 * zero there re-runs every migration on the second start.
 */
function countOf(returned: number, affected: number | undefined): number {
  return returned > 0 ? returned : (affected ?? 0)
}

export function createEmbeddedPool(dataDir?: string): Pool {
  const db = new PGlite(dataDir)

  const run = async <R>(text: string, params?: unknown[]): Promise<QueryResult<R>> => {
    // pg takes a whole migration file through the same call as a one-line
    // select. PGlite splits them: query() is one parameterised statement,
    // exec() is a script. Parameters are the only thing that tells them apart,
    // and a script never has any.
    if (params !== undefined) {
      const result = await db.query<R>(text, params)
      return { rows: result.rows, rowCount: countOf(result.rows.length, result.affectedRows) }
    }
    const results = await db.exec(text)
    const last = results[results.length - 1]
    const rows = (last?.rows ?? []) as R[]
    return { rows, rowCount: countOf(rows.length, last?.affectedRows) }
  }

  // PGlite is a single connection. Two callers inside BEGIN blocks would
  // interleave into one transaction and commit each other's half-done work, so
  // a client is handed out one at a time and the next caller waits.
  // ponytail: a queue, not a pool. Anything that needs real concurrency needs a
  // real Postgres, which is what DATABASE_URL is for.
  let tail: Promise<void> = Promise.resolve()

  return {
    query: run,
    async connect(): Promise<PoolClient> {
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const ahead = tail
      tail = ahead.then(() => held)
      await ahead
      return { query: run, release }
    },
    async end(): Promise<void> {
      await db.close()
    },
  }
}
