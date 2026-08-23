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
import { fileStore } from './adapters/db/file-store.ts'
import { GatewayError } from './domain/errors.ts'
import { mcpRoutes } from './interface/http/mcp.ts'
import { connectionRoutes } from './interface/http/connections.ts'
import { adminRoutes } from './interface/http/admin.ts'
import { rateLimiter } from './interface/http/rate-limit.ts'
import { listWorkspaceTools, TOOL_BUDGET } from './application/catalog.ts'
import { searchTools } from './application/tool-search.ts'
import { searchToolCatalogEntry } from './application/meta-tools.ts'
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

  const files = fileStore(deps.pool)

  const callDeps: CallDeps = {
    registry: deps.registry,
    enablement,
    grants: grantResolver,
    idempotency: idempotencyStore(deps.pool),
    files: files,
  }

  const connectionDeps: ConnectionDeps = {
    registry: deps.registry,
    publicUrl: deps.config.publicUrl,
    dashboardUrl: deps.config.dashboardUrl,
    oauthConfig,
    states: stateStore(deps.pool),
    grants,
    enablement,
    ...deps.connectionOverrides,
  }

  app.get('/v1/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  /**
   * What this deployment booted, with no credential, because the site that
   * renders a page per provider must not need a workspace to know what exists.
   * Keeping its own copy is how it once published a tool the gateway never had.
   *
   * Carries no workspace, no connected account and no scope. It does say which
   * OAuth applications this instance has configured, which is the point for a
   * hosted gateway and a small disclosure for a private one.
   */
  app.get('/v1/catalog', (_req, res) => {
    const providers = deps.registry.all().map((adapter) => {
      const tools = adapter.listTools().map((tool) => `${adapter.prefix}__${tool.name}`)
      return {
        id: adapter.id,
        prefix: adapter.prefix,
        maturity: adapter.maturity,
        credential: adapter.credential,
        tool_count: tools.length,
        tools,
      }
    })
    res.setHeader('cache-control', 'public, max-age=300')
    res.json({
      providers,
      provider_count: providers.length,
      tool_count: providers.reduce((total, provider) => total + provider.tool_count, 0),
    })
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

  // A search answers a question, so it returns few results rather than a page
  // sized to what a model can hold in its tool list.
  const SEARCH_RESULT_LIMIT = 25

  app.get('/v1/tools', authenticated, async (req, res, next) => {
    try {
      const query = typeof req.query.q === 'string' ? req.query.q : undefined
      const { tools } = await listWorkspaceTools(
        { registry: deps.registry, enablement },
        req.gateway.workspaceId,
        {
          provider: typeof req.query.provider === 'string' ? req.query.provider : undefined,
          limit: null,
        },
      )
      // The credential scope narrows what this bearer may see, on top of what
      // the workspace has connected. Capped after that filter, so the count
      // reported is the one this bearer can actually reach.
      const visible = tools.filter((tool) => scopeAllowsProvider(req.gateway.scope, tool.provider))
      // A search asks a question about the whole catalog, so the budget that
      // exists to keep a model's tool list short does not apply to it.
      const listed = query ? searchTools(visible, query, SEARCH_RESULT_LIMIT) : visible.slice(0, TOOL_BUDGET)
      res.json({
        // Listed beside the rest, not instead of them. Left out of a search
        // result because search is what it does, and left out of an empty
        // catalog because searching nothing is an invitation to a dead end.
        tools:
          query || visible.length === 0
            ? listed
            : [...listed, searchToolCatalogEntry(visible.length, visible.length - listed.length)],
        catalog_truncated: !query && visible.length > listed.length,
        request_id: req.requestId,
      })
    } catch (err) {
      next(err)
    }
  })

  // Mounted only when a service token is configured, so a self-host deployment
  // has no admin plane unless it asks for one.
  if (deps.config.serviceToken) {
    app.use(
      adminRoutes({
        pool: deps.pool,
        config: deps.config,
        registry: deps.registry,
        connections: connectionDeps,
      }),
    )
  }

  app.use(connectionRoutes(connectionDeps, authenticated))
  // Authentication and the token bucket are mounted once, ahead of both tool
  // surfaces. Mounting the limiter per router would charge one request twice.
  app.use(authenticated, rateLimiter(deps.callsPerMinute ?? 600))
  app.use(mcpRoutes(callDeps, deps.pool))
  app.use(restRoutes(callDeps, deps.pool))

  // Bytes a tool produced and could not hand to a model. Same credential as
  // the call that made them, and scoped to its workspace, so a file id from
  // another tenant is a 404 rather than a leak.
  app.get('/v1/files/:id', async (req, res, next) => {
    try {
      const id = String(req.params.id ?? '')
      const found = /^[0-9a-f-]{36}$/.test(id)
        ? await files.get(req.gateway.workspaceId, id)
        : null
      if (!found) {
        throw new GatewayError('tool_not_found', 'no such file, or it expired')
      }
      res.setHeader('content-type', found.mimeType)
      res.setHeader('content-length', String(found.size))
      res.setHeader('x-request-id', req.requestId)
      res.send(found.bytes)
    } catch (err) {
      next(err)
    }
  })

  app.use(errorHandler())
  return app
}
