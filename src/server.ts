import express from 'express'
import type { Config } from './config.ts'
import type { Pool } from './adapters/db/pool.ts'
import { credentialStore } from './adapters/db/credential-store.ts'
import { errorHandler, withRequestContext } from './interface/http/context.ts'
import { requireCredential } from './interface/http/auth.ts'

export type ServerDeps = {
  pool: Pool
  config: Config
}

export function createServer(deps: ServerDeps): express.Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(withRequestContext())

  const credentials = credentialStore(deps.pool)
  const authenticated = requireCredential(credentials)

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

  app.get('/v1/whoami', authenticated, async (req, res, next) => {
    try {
      const { rows } = await deps.pool.query(
        'SELECT plan, call_quota FROM workspaces WHERE id = $1',
        [req.auth.workspaceId],
      )
      res.json({
        workspace_id: req.auth.workspaceId,
        plan: rows[0]?.plan ?? 'free',
        call_quota: rows[0]?.call_quota ?? 0,
        credential_scope: req.auth.scope,
        request_id: req.requestId,
      })
    } catch (err) {
      next(err)
    }
  })

  app.use(errorHandler())
  return app
}
