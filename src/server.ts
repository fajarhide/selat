import express from 'express'
import type { Config } from './config.ts'
import type { Pool } from './adapters/db/pool.ts'
import { credentialStore } from './adapters/db/credential-store.ts'
import { enablementStore } from './adapters/db/enablement-store.ts'
import { idempotencyStore } from './adapters/db/idempotency-store.ts'
import { grantStore } from './adapters/db/grant-store.ts'
import { stateStore } from './adapters/db/state-store.ts'
import { envOauthConfig, type OauthConfigResolver } from './adapters/oauth/catalog.ts'
import { refreshGrant } from './adapters/oauth/client.ts'
import { errorHandler, withRequestContext } from './interface/http/context.ts'
import { requireCredential } from './interface/http/auth.ts'
import { restRoutes } from './interface/http/rest.ts'
import { mcpRoutes } from './interface/http/mcp.ts'
import { connectionRoutes } from './interface/http/connections.ts'
import { rateLimiter } from './interface/http/rate-limit.ts'
import { listWorkspaceTools } from './application/catalog.ts'
import { createGrantResolver } from './application/grants.ts'
import { scopeAllowsProvider } from './domain/credential.ts'
import type { CallDeps } from './application/call-tool.ts'
import type { ConnectionDeps } from './application/connections.ts'
import type { Registry } from './adapters/providers/registry.ts'

export type ServerDeps = {
  pool: Pool
  config: Config
  registry: Registry
  /** Overridable so tests can point at a fake vendor without a network. */
  oauthConfig?: OauthConfigResolver
  connectionOverrides?: Partial<ConnectionDeps>
  /** Per workspace token bucket, refilled continuously. */
  callsPerMinute?: number
}

export function createServer(deps: ServerDeps): express.Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(withRequestContext())

  const credentials = credentialStore(deps.pool)
  const enablement = enablementStore(deps.pool)
  const grants = grantStore(deps.pool, deps.config.vaultKey)
  const oauthConfig = deps.oauthConfig ?? envOauthConfig()
  const authenticated = requireCredential(credentials)

  const grantResolver = createGrantResolver({
    grants,
    oauthConfig,
    refresh: (cfg, refreshToken) => refreshGrant(cfg, refreshToken),
    reauthUrl: (grantId) => `${deps.config.publicUrl}/v1/connections/${grantId}/authorize`,
  })

  const callDeps: CallDeps = {
    registry: deps.registry,
    enablement,
    grants: grantResolver,
    idempotency: idempotencyStore(deps.pool),
  }

  const connectionDeps: ConnectionDeps = {
    registry: deps.registry,
    publicUrl: deps.config.publicUrl,
    oauthConfig,
    states: stateStore(deps.pool),
    grants,
    enablement,
    ...deps.connectionOverrides,
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

  app.use(connectionRoutes(connectionDeps, authenticated))
  // Authentication and the token bucket are mounted once, ahead of both tool
  // surfaces. Mounting the limiter per router would charge one request twice.
  app.use(authenticated, rateLimiter(deps.callsPerMinute ?? 600))
  app.use(mcpRoutes(callDeps, deps.pool))
  app.use(restRoutes(callDeps, deps.pool))

  app.use(errorHandler())
  return app
}
