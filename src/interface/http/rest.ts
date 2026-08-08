import express, { type Router } from 'express'
import { callTool, type CallDeps } from '../../application/call-tool.ts'

export function restRoutes(deps: CallDeps): Router {
  const router = express.Router()

  router.post('/v1/tools/:name/call', express.json({ limit: '1mb' }), async (req, res, next) => {
    try {
      const result = await callTool(deps, {
        workspaceId: req.gateway.workspaceId,
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
