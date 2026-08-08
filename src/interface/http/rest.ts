import express, { type Router } from 'express'
import type { CallDeps } from '../../application/call-tool.ts'
import { meteredCall } from '../../application/metering.ts'
import type { Pool } from '../../adapters/db/pool.ts'

export function restRoutes(deps: CallDeps, pool: Pool): Router {
  const router = express.Router()

  router.post('/v1/tools/:name/call', express.json({ limit: '1mb' }), async (req, res, next) => {
    try {
      const result = await meteredCall(pool, deps, {
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
