import express, { type Router } from 'express'
import { GatewayError } from '../../domain/errors.ts'
import { requireService, workspaceParam } from './service.ts'
import { applyPlan, createWorkspace, readWorkspace } from '../../application/workspaces.ts'
import {
  listCredentials,
  mintForWorkspace,
  revokeCredential,
} from '../../application/credentials.ts'
import { meterWindow, usageReport } from '../../application/usage-report.ts'
import { recordAudit } from '../../application/metering.ts'
import type { Pool } from '../../adapters/db/pool.ts'
import type { Config } from '../../config.ts'
import type { Registry } from '../../adapters/providers/registry.ts'
import { parseToolName } from '../../domain/tool-names.ts'
import { listWorkspaceTools } from '../../application/catalog.ts'
import { pathParam } from './connections.ts'
import {
  beginConnection,
  disconnect,
  setApiKey,
  type ConnectionDeps,
} from '../../application/connections.ts'

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

  router.get('/v1/admin/workspaces/:workspaceId/usage', async (req, res, next) => {
    try {
      const report = await usageReport(deps.pool, workspaceParam(req))
      res.json({
        period: report.period,
        calls: report.calls,
        quota: report.quota,
        by_provider: report.byProvider,
        daily: report.daily,
        recent: report.recent.map((row) => ({
          tool: row.tool,
          outcome: row.outcome,
          latency_ms: row.latencyMs,
          created_at: row.createdAt,
        })),
        request_id: req.requestId,
      })
    } catch (err) {
      next(err)
    }
  })

  router.get('/v1/admin/workspaces/:workspaceId/usage/meter', async (req, res, next) => {
    try {
      // A repeated query parameter arrives as an array, which is not a cursor.
      const since = typeof req.query.since === 'string' ? req.query.since : undefined
      const counted = await meterWindow(deps.pool, workspaceParam(req), since)
      res.json({
        since: counted.since,
        until: counted.until,
        calls: counted.calls,
        request_id: req.requestId,
      })
    } catch (err) {
      next(err)
    }
  })

  router.get('/v1/admin/workspaces/:workspaceId/connections', async (req, res, next) => {
    try {
      const workspaceId = workspaceParam(req)
      const enabled = await deps.connections.enablement.enabledPrefixes(workspaceId)
      res.json({
        connections: deps.registry.all().map((adapter) => ({
          provider: adapter.prefix,
          grant: adapter.grantId,
          maturity: adapter.maturity,
          scopes: adapter.scopes,
          // The portal has to know whether to open a consent window or ask for
          // a secret, and the prefix does not say. Without this it offers
          // Connect for every provider and the api_key ones answer 400.
          credential: adapter.credential ?? 'oauth',
          connected: enabled.includes(adapter.prefix),
        })),
        request_id: req.requestId,
      })
    } catch (err) {
      next(err)
    }
  })

  router.post(
    '/v1/admin/workspaces/:workspaceId/connections/:prefix/authorize',
    async (req, res, next) => {
      try {
        const workspaceId = workspaceParam(req)
        // Without this the missing workspace surfaces as a foreign key violation
        // on the state insert, which is a 500 for what is a 404.
        await readWorkspace(deps.pool, workspaceId)
        const prefix = pathParam(req, 'prefix')
        const { url } = await beginConnection(deps.connections, {
          workspaceId,
          prefix,
          ...(typeof req.body?.return_to === 'string' ? { returnTo: req.body.return_to } : {}),
        })
        await recordAudit(deps.pool, {
          workspaceId,
          actor: 'service',
          action: 'connection.authorized',
          target: prefix,
          requestId: req.requestId,
        })
        res.json({ authorize_url: url, request_id: req.requestId })
      } catch (err) {
        next(err)
      }
    },
  )

  // The service-token twin of PUT /v1/connections/:prefix/key. The portal holds
  // the service token and never the workspace credential, so without this route
  // there is no way for it to connect a provider that takes a key at all.
  router.put(
    '/v1/admin/workspaces/:workspaceId/connections/:prefix/key',
    async (req, res, next) => {
      try {
        const workspaceId = workspaceParam(req)
        await readWorkspace(deps.pool, workspaceId)
        const prefix = pathParam(req, 'prefix')
        if (typeof req.body?.api_key !== 'string') {
          throw new GatewayError('invalid_arguments', 'api_key must be a string')
        }
        await setApiKey(deps.connections, { workspaceId, prefix, key: req.body.api_key })
        // The key itself is never echoed back, not even its tail, so the audit
        // row records that it changed and nothing about what it is.
        await recordAudit(deps.pool, {
          workspaceId,
          actor: 'service',
          action: 'connection.key_set',
          target: prefix,
          requestId: req.requestId,
        })
        res.json({ connected: prefix, request_id: req.requestId })
      } catch (err) {
        next(err)
      }
    },
  )

  router.delete('/v1/admin/workspaces/:workspaceId/connections/:prefix', async (req, res, next) => {
    try {
      const workspaceId = workspaceParam(req)
      await readWorkspace(deps.pool, workspaceId)
      const prefix = pathParam(req, 'prefix')
      await disconnect(deps.connections, { workspaceId, prefix })
      await recordAudit(deps.pool, {
        workspaceId,
        actor: 'service',
        action: 'connection.disconnected',
        target: prefix,
        requestId: req.requestId,
      })
      res.json({ disconnected: prefix, request_id: req.requestId })
    } catch (err) {
      next(err)
    }
  })

  router.get('/v1/admin/workspaces/:workspaceId/tools', async (req, res, next) => {
    try {
      const { tools, truncated } = await listWorkspaceTools(
        { registry: deps.registry, enablement: deps.connections.enablement },
        workspaceParam(req),
        // No cap. This is the only screen that can turn a tool off, and one
        // that hides what it manages cannot manage it.
        { includeDisabled: true, limit: null },
      )
      res.json({
        tools: tools.map((tool) => ({
          name: tool.name,
          provider: tool.provider,
          description: tool.description,
          write: tool.write,
          maturity: tool.maturity,
          enabled: tool.enabled !== false,
        })),
        catalog_truncated: truncated,
        request_id: req.requestId,
      })
    } catch (err) {
      next(err)
    }
  })

  router.put('/v1/admin/workspaces/:workspaceId/tools/:toolName', async (req, res, next) => {
    try {
      const workspaceId = workspaceParam(req)
      await readWorkspace(deps.pool, workspaceId)
      const toolName = pathParam(req, 'toolName')
      if (typeof req.body?.enabled !== 'boolean') {
        throw new GatewayError('invalid_arguments', 'enabled must be a boolean')
      }
      const { prefix, tool } = parseToolName(toolName)
      // A row for a name no adapter serves would sit in the table forever and a
      // portal typo would report success while toggling nothing.
      if (!deps.registry.get(prefix).listTools().some((def) => def.name === tool)) {
        throw new GatewayError('tool_not_found', `unknown tool: ${toolName}`)
      }
      await deps.connections.enablement.setToolOverride(workspaceId, toolName, req.body.enabled)
      await recordAudit(deps.pool, {
        workspaceId,
        actor: 'service',
        action: 'tool.toggled',
        target: toolName,
        requestId: req.requestId,
      })
      res.json({ tool: toolName, enabled: req.body.enabled, request_id: req.requestId })
    } catch (err) {
      next(err)
    }
  })

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
