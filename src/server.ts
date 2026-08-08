import express from 'express'
import type { Config } from './config.ts'
import type { Pool } from './adapters/db/pool.ts'
import { credentialStore } from './adapters/db/credential-store.ts'
import { enablementStore } from './adapters/db/enablement-store.ts'
import { idempotencyStore } from './adapters/db/idempotency-store.ts'
import { errorHandler, withRequestContext } from './interface/http/context.ts'
import { requireCredential } from './interface/http/auth.ts'
import { restRoutes } from './interface/http/rest.ts'
import { mcpRoutes } from './interface/http/mcp.ts'
import { listWorkspaceTools } from './application/catalog.ts'
import { scopeAllowsProvider } from './domain/credential.ts'
import type { GrantResolver, CallDeps } from './application/call-tool.ts'
import type { Registry } from './adapters/providers/registry.ts'

export type ServerDeps = {
  pool: Pool
  config: Config
  registry: Registry
  /** Supplied by main.ts. Defaults to a resolver that has no grants, which is
   *  everything the fake provider needs and nothing a real one does. */
  grants?: GrantResolver
}

export function createServer(deps: ServerDeps): express.Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(withRequestContext())

  const credentials = credentialStore(deps.pool)
  const enablement = enablementStore(deps.pool)
  const authenticated = requireCredential(credentials)

  const callDeps: CallDeps = {
    registry: deps.registry,
    enablement,
    grants: deps.grants ?? { accessTokenFor: async () => null },
    idempotency: idempotencyStore(deps.pool),
  }

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
        [req.gateway.workspaceId],
      )
      const enabled = await enablement.enabledPrefixes(req.gateway.workspaceId)
      res.json({
        workspace_id: req.gateway.workspaceId,
        plan: rows[0]?.plan ?? 'free',
        call_quota: rows[0]?.call_quota ?? 0,
        providers: enabled.filter((prefix) => scopeAllowsProvider(req.gateway.scope, prefix)),
        credential_scope: req.gateway.scope,
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
        req.gateway.workspaceId,
        { provider: typeof req.query.provider === 'string' ? req.query.provider : undefined },
      )
      // The credential scope narrows what this bearer may see, on top of what
      // the workspace has connected.
      const visible = tools.filter((tool) => scopeAllowsProvider(req.gateway.scope, tool.provider))
      res.json({ tools: visible, catalog_truncated: truncated, request_id: req.requestId })
    } catch (err) {
      next(err)
    }
  })

  app.use(authenticated, mcpRoutes(callDeps))
  app.use(authenticated, restRoutes(callDeps))

  app.use(errorHandler())
  return app
}
