import express, { type Router } from 'express'
import { GatewayError } from '../../domain/errors.ts'
import { requireService, workspaceParam } from './service.ts'
import { applyPlan, createWorkspace, readWorkspace } from '../../application/workspaces.ts'
import {
  listCredentials,
  mintForWorkspace,
  revokeCredential,
} from '../../application/credentials.ts'
import { recordAudit } from '../../application/metering.ts'
import type { Pool } from '../../adapters/db/pool.ts'
import type { Config } from '../../config.ts'
import type { Registry } from '../../adapters/providers/registry.ts'
import type { ConnectionDeps } from '../../application/connections.ts'

export type AdminDeps = {
  pool: Pool
  config: Config
  registry: Registry
  connections: ConnectionDeps
}

export function adminRoutes(deps: AdminDeps): Router {
  const router = express.Router()
  router.use('/v1/admin', express.json({ limit: '64kb' }), requireService(deps.config.serviceToken))

  router.post('/v1/admin/workspaces', async (req, res, next) => {
    try {
      const summary = await createWorkspace(deps.pool, String(req.body?.name ?? ''))
      res.status(201).json(present(summary, req.requestId))
    } catch (err) {
      next(err)
    }
  })

  router.get('/v1/admin/workspaces/:workspaceId', async (req, res, next) => {
    try {
      res.json(present(await readWorkspace(deps.pool, workspaceParam(req)), req.requestId))
    } catch (err) {
      next(err)
    }
  })

  router.patch('/v1/admin/workspaces/:workspaceId', async (req, res, next) => {
    try {
      const workspaceId = workspaceParam(req)
      const summary = await applyPlan(deps.pool, workspaceId, {
        plan: typeof req.body?.plan === 'string' ? req.body.plan : undefined,
        callQuota: typeof req.body?.call_quota === 'number' ? req.body.call_quota : undefined,
      })
      await recordAudit(deps.pool, {
        workspaceId,
        actor: 'service',
        action: 'plan.changed',
        target: summary.plan,
        requestId: req.requestId,
      })
      res.json(present(summary, req.requestId))
    } catch (err) {
      next(err)
    }
  })

  router.post('/v1/admin/workspaces/:workspaceId/credentials', async (req, res, next) => {
    try {
      const workspaceId = workspaceParam(req)
      await readWorkspace(deps.pool, workspaceId)
      const minted = await mintForWorkspace(deps.pool, workspaceId, {
        name: typeof req.body?.name === 'string' ? req.body.name : undefined,
        scope: req.body?.scope,
      })
      await recordAudit(deps.pool, {
        workspaceId,
        actor: 'service',
        action: 'credential.minted',
        target: minted.last4,
        requestId: req.requestId,
      })
      res.status(201).json({ ...minted, request_id: req.requestId })
    } catch (err) {
      next(err)
    }
  })

  router.get('/v1/admin/workspaces/:workspaceId/credentials', async (req, res, next) => {
    try {
      const credentials = await listCredentials(deps.pool, workspaceParam(req))
      res.json({
        credentials: credentials.map((c) => ({
          id: c.id,
          name: c.name,
          last4: c.last4,
          scope: c.scope,
          last_used_at: c.lastUsedAt,
          revoked_at: c.revokedAt,
          created_at: c.createdAt,
        })),
        request_id: req.requestId,
      })
    } catch (err) {
      next(err)
    }
  })

  router.delete(
    '/v1/admin/workspaces/:workspaceId/credentials/:credentialId',
    async (req, res, next) => {
      try {
        const workspaceId = workspaceParam(req)
        const credentialId = req.params.credentialId
        if (typeof credentialId !== 'string') {
          throw new GatewayError('invalid_arguments', 'missing credentialId')
        }
        await revokeCredential(deps.pool, workspaceId, credentialId)
        await recordAudit(deps.pool, {
          workspaceId,
          actor: 'service',
          action: 'credential.revoked',
          target: credentialId,
          requestId: req.requestId,
        })
        res.json({ revoked: credentialId, request_id: req.requestId })
      } catch (err) {
        next(err)
      }
    },
  )

  return router
}

function present(
  summary: Awaited<ReturnType<typeof readWorkspace>>,
  requestId: string,
): Record<string, unknown> {
  return {
    workspace_id: summary.workspaceId,
    name: summary.name,
    plan: summary.plan,
    call_quota: summary.callQuota,
    calls_this_period: summary.callsThisPeriod,
    created_at: summary.createdAt,
    request_id: requestId,
  }
}
