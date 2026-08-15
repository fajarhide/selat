import express, { type Router } from 'express'
import type { CallDeps } from '../../application/call-tool.ts'
import { meteredCall } from '../../application/metering.ts'
import { callSearchTool, SEARCH_TOOL } from '../../application/meta-tools.ts'
import type { Pool } from '../../adapters/db/pool.ts'

export function restRoutes(deps: CallDeps, pool: Pool): Router {
  const router = express.Router()

  router.post('/v1/tools/:name/call', express.json({ limit: '1mb' }), async (req, res, next) => {
    try {
      // Branched before metering, the same way the MCP surface does it, and
      // for the same reason: discovery reaches no upstream, so billing it
      // teaches an agent to guess instead of search.
      const result =
        req.params.name === SEARCH_TOOL
          ? await callSearchTool(deps, {
              workspaceId: req.gateway.workspaceId,
              scope: req.gateway.scope,
              args: req.body ?? {},
            })
          : await meteredCall(pool, deps, {
              workspaceId: req.gateway.workspaceId,
              credentialId: req.gateway.credentialId,
              scope: req.gateway.scope,
              name: req.params.name,
              args: req.body ?? {},
              requestId: req.requestId,
              idempotencyKey: req.get('idempotency-key') ?? undefined,
            })
      res.json({ ...result, request_id: req.requestId })
    } catch (err) {
      next(err)
    }
  })

  return router
}
