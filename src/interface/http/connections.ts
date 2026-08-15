import express, { type Router } from 'express'
import { GatewayError } from '../../domain/errors.ts'
import {
  beginConnection,
  completeConnection,
  disconnect,
  setApiKey,
  type ConnectionDeps,
} from '../../application/connections.ts'
import type { requireCredential } from './auth.ts'

type Authenticated = ReturnType<typeof requireCredential>

export function connectionRoutes(deps: ConnectionDeps, authenticated: Authenticated): Router {
  const router = express.Router()

  router.get('/v1/connections', authenticated, async (req, res, next) => {
    try {
      const enabled = await deps.enablement.enabledPrefixes(req.gateway.workspaceId)
      res.json({
        connections: deps.registry.all().map((adapter) => ({
          provider: adapter.prefix,
          grant: adapter.grantId,
          maturity: adapter.maturity,
          scopes: adapter.scopes,
          // A client has to know whether to open a consent window or ask for
          // a secret, and it cannot tell from the prefix.
          credential: adapter.credential ?? 'oauth',
          connected: enabled.includes(adapter.prefix),
        })),
        request_id: req.requestId,
      })
    } catch (err) {
      next(err)
    }
  })

  router.post('/v1/connections/:prefix/authorize', authenticated, async (req, res, next) => {
    try {
      const { url } = await beginConnection(deps, {
        workspaceId: req.gateway.workspaceId,
        prefix: pathParam(req, 'prefix'),
      })
      res.json({ authorize_url: url, request_id: req.requestId })
    } catch (err) {
      next(err)
    }
  })

  // The callback is reached by the vendor redirect, so it carries no bearer.
  // The single-use state is the only thing that authorises it.
  router.get('/v1/connections/:prefix/callback', async (req, res, next) => {
    try {
      const state = req.query.state
      const code = req.query.code
      if (typeof state !== 'string' || typeof code !== 'string') {
        throw new GatewayError('invalid_arguments', 'callback needs both state and code')
      }
      const { prefix, returnTo } = await completeConnection(deps, { state, code })
      if (returnTo && isDashboardUrl(deps.dashboardUrl, returnTo)) {
        res.redirect(302, returnTo)
        return
      }
      res.type('html').send(connectedPage(prefix))
    } catch (err) {
      next(err)
    }
  })

  // The key arrives on the workspace's own credential and is written straight
  // into the vault. It is never echoed back, not even the tail of it.
  router.put(
    '/v1/connections/:prefix/key',
    authenticated,
    express.json({ limit: '8kb' }),
    async (req, res, next) => {
      try {
        const body = (req.body ?? {}) as { api_key?: unknown }
        if (typeof body.api_key !== 'string') {
          throw new GatewayError('invalid_arguments', 'api_key must be a string')
        }
        const prefix = pathParam(req, 'prefix')
        await setApiKey(deps, { workspaceId: req.gateway.workspaceId, prefix, key: body.api_key })
        res.json({ connected: prefix, request_id: req.requestId })
      } catch (err) {
        next(err)
      }
    },
  )

  router.delete('/v1/connections/:prefix', authenticated, async (req, res, next) => {
    try {
      await disconnect(deps, {
        workspaceId: req.gateway.workspaceId,
        prefix: pathParam(req, 'prefix'),
      })
      res.json({ disconnected: pathParam(req, 'prefix'), request_id: req.requestId })
    } catch (err) {
      next(err)
    }
  })

  return router
}

// Express 5 widens params to string | string[] when a route carries extra
// middleware, so the value is narrowed once here instead of at every use.
// This route carries no bearer, so return_to is attacker reachable and an
// unchecked value is an open redirect. The trailing slash is what stops
// https://dash.example.com.evil.com passing a bare prefix match.
function isDashboardUrl(dashboardUrl: string | undefined, returnTo: string): boolean {
  if (!dashboardUrl) return false
  return returnTo === dashboardUrl || returnTo.startsWith(`${dashboardUrl}/`)
}

export function pathParam(req: express.Request, key: string): string {
  const value = req.params[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new GatewayError('invalid_arguments', `missing path parameter ${key}`)
  }
  return value
}

function connectedPage(prefix: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Connected</title>
<body style="font:16px system-ui;padding:3rem;max-width:32rem">
<h1>${escapeHtml(prefix)} connected</h1>
<p>Its tools are live under the <code>${escapeHtml(prefix)}__</code> prefix. Your gateway
credential did not change, so nothing needs updating in your agent.</p>
</body>`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
}
