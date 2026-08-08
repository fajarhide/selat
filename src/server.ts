import express from 'express'
import type { Config } from './config.ts'
import type { Pool } from './adapters/db/pool.ts'

export type ServerDeps = {
  pool: Pool
  config: Config
}

export function createServer(deps: ServerDeps): express.Express {
  const app = express()
  app.disable('x-powered-by')

  app.get('/v1/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  // Readiness fails the deploy rather than every call when the database is
  // unreachable or the vault key never loaded.
  app.get('/v1/ready', async (_req, res) => {
    try {
      await deps.pool.query('SELECT 1')
      res.json({ status: 'ready' })
    } catch {
      res.status(503).json({ status: 'not_ready', reason: 'database' })
    }
  })

  return app
}
