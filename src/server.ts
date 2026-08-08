import express from 'express'
import type { Config } from './config.ts'
import type { Pool } from './adapters/db/pool.ts'
import { credentialStore } from './adapters/db/credential-store.ts'
import { enablementStore } from './adapters/db/enablement-store.ts'
import { errorHandler, withRequestContext } from './interface/http/context.ts'
import { requireCredential } from './interface/http/auth.ts'
import { listWorkspaceTools } from './application/catalog.ts'
import { scopeAllowsProvider } from './domain/credential.ts'
import type { Registry } from './adapters/providers/registry.ts'

export type ServerDeps = {
  pool: Pool
  config: Config
  registry: Registry
}

export function createServer(deps: ServerDeps): express.Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(withRequestContext())

  const credentials = credentialStore(deps.pool)
  const enablement = enablementStore(deps.pool)
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

  app.get('/v1/tools', authenticated, async (req, res, next) => {
    try {
      const { tools, truncated } = await listWorkspaceTools(
        { registry: deps.registry, enablement },
        req.auth.workspaceId,
        { provider: typeof req.query.provider === 'string' ? req.query.provider : undefined },
      )
      // The credential scope narrows what this bearer may see, on top of what
      // the workspace has connected.
      const visible = tools.filter((tool) => scopeAllowsProvider(req.auth.scope, tool.provider))
      res.json({ tools: visible, catalog_truncated: truncated, request_id: req.requestId })
    } catch (err) {
      next(err)
    }
  })

  app.use(errorHandler())
  return app
}
