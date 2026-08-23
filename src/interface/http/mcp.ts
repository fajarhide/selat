import express, { type Router } from 'express'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { CallDeps } from '../../application/call-tool.ts'
import { meteredCall } from '../../application/metering.ts'
import type { Pool } from '../../adapters/db/pool.ts'
import { listWorkspaceTools, TOOL_BUDGET } from '../../application/catalog.ts'
import { callSearchTool, searchToolDefinition, SEARCH_TOOL } from '../../application/meta-tools.ts'
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
      // Fetched whole and capped after the scope filter, so the count the meta
      // tool reports is what this credential can actually reach, and a
      // provider-scoped bearer never learns that other providers are connected.
      const { tools } = await listWorkspaceTools(deps, gateway.workspaceId, { limit: null })
      const visible = tools.filter((tool) => scopeAllowsProvider(gateway.scope, tool.provider))
      const listed = visible.slice(0, TOOL_BUDGET)
      const meta =
        visible.length === 0
          ? []
          : [searchToolDefinition(visible.length, visible.length - listed.length)]
      return {
        tools: [
          ...listed.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
          ...meta.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        ],
      }
    })

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        // Branched before metering on purpose. Discovery makes no upstream
        // request, and billing it teaches an agent to guess instead of search.
        const result =
          request.params.name === SEARCH_TOOL
            ? await callSearchTool(deps, {
                workspaceId: gateway.workspaceId,
                scope: gateway.scope,
                args: request.params.arguments ?? {},
              })
            : await meteredCall(pool, deps, {
                workspaceId: gateway.workspaceId,
                credentialId: gateway.credentialId,
                scope: gateway.scope,
                name: request.params.name,
                args: request.params.arguments ?? {},
                requestId,
              })
        // Structured content is skipped for bytes on purpose: it would carry
        // a second copy of the base64 into the same context window.
        return result.binary
          ? { content: [binaryBlock(request.params.name, result.content as BinaryContent)] }
          : {
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

export type BinaryContent = { mime_type: string; size: number; data: string }

/** Text is handed over as text, because an agent asked to read a document can
 *  do nothing with base64. An image goes in the block a client can render.
 *  Everything else travels as a resource, the only block that carries
 *  arbitrary bytes. */
export function binaryBlock(tool: string, content: BinaryContent) {
  const { mime_type: mimeType, data } = content
  if (mimeType.startsWith('image/')) return { type: 'image' as const, data, mimeType }
  if (mimeType.startsWith('text/') || mimeType === 'application/json') {
    return { type: 'text' as const, text: Buffer.from(data, 'base64').toString('utf8') }
  }
  return { type: 'resource' as const, resource: { uri: `selat://${tool}`, mimeType, blob: data } }
}

function asStructured(content: unknown): Record<string, unknown> | undefined {
  return content !== null && typeof content === 'object' && !Array.isArray(content)
    ? (content as Record<string, unknown>)
    : undefined
}
