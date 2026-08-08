import express, { type Router } from 'express'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { CallDeps } from '../../application/call-tool.ts'
import { meteredCall } from '../../application/metering.ts'
import type { Pool } from '../../adapters/db/pool.ts'
import { listWorkspaceTools } from '../../application/catalog.ts'
import { scopeAllowsProvider } from '../../domain/credential.ts'
import { toEnvelope } from '../../domain/errors.ts'

export const SERVER_INFO = { name: 'selat', version: '0.1.0' } as const

export function mcpRoutes(deps: CallDeps, pool: Pool): Router {
  const router = express.Router()

  router.post('/mcp', express.json({ limit: '1mb' }), async (req, res) => {
    // The low level Server is used on purpose: it passes provider input schemas
    // through as JSON Schema, which a gateway proxying arbitrary upstreams
    // needs. The high level helper would require every schema to be zod.
    const server = new Server(SERVER_INFO, { capabilities: { tools: {} } })
    const gateway = req.gateway
    const requestId = req.requestId

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const { tools } = await listWorkspaceTools(deps, gateway.workspaceId)
      return {
        tools: tools
          .filter((tool) => scopeAllowsProvider(gateway.scope, tool.provider))
          .map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
      }
    })

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const result = await meteredCall(pool, deps, {
          workspaceId: gateway.workspaceId,
          credentialId: gateway.credentialId,
          scope: gateway.scope,
          name: request.params.name,
          args: request.params.arguments ?? {},
          requestId,
        })
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result.content) }],
          structuredContent: asStructured(result.content),
          ...(result.hasMore ? { _meta: { nextCursor: result.nextCursor } } : {}),
        }
      } catch (err) {
        // MCP wants a tool failure as an error result, not a transport error,
        // so the model can read the stable code and react.
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(toEnvelope(err, requestId).body) }],
          isError: true,
        }
      }
    })

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })

    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch (err) {
      if (!res.headersSent) {
        const { status, body } = toEnvelope(err, requestId)
        res.status(status).json(body)
      }
    }
  })

  return router
}

function asStructured(content: unknown): Record<string, unknown> | undefined {
  return content !== null && typeof content === 'object' && !Array.isArray(content)
    ? (content as Record<string, unknown>)
    : undefined
}
