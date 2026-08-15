import { GatewayError } from '../domain/errors.ts'
import { scopeAllowsProvider, type CredentialScope } from '../domain/credential.ts'
import { listWorkspaceTools, type CatalogDeps, type NamespacedTool } from './catalog.ts'
import { searchTools } from './tool-search.ts'
import type { ToolDef, ToolResult } from '../adapters/providers/registry.ts'

/** Reserved so a manifest cannot shadow the meta namespace. */
export const RESERVED_PREFIX = 'selat'
export const SEARCH_TOOL = 'selat__search_tools'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 100

/**
 * Built per request, because the count in the description is the entire
 * truncation signal. MCP has no field for "there are more tools than this", and
 * inventing one would need every client to read it. A sentence the model
 * already reads costs nothing and works on every client that exists.
 */
export function searchToolDefinition(total: number, hidden: number): ToolDef {
  return {
    name: SEARCH_TOOL,
    description:
      `Search the ${total} tools this workspace has enabled. ` +
      // Omitted rather than rendered as "0 of them", which asks a model to do
      // arithmetic to learn nothing.
      (hidden > 0 ? `${hidden} of them are not in this list. ` : '') +
      'Returns names, descriptions and input schemas ready to pass to tools/call.',
    write: false,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free text, for example "create a jira issue"' },
        provider: { type: 'string', description: 'Restrict to one provider prefix' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
      },
      required: ['query'],
      additionalProperties: false,
    },
  }
}

/** The same tool in the shape `GET /v1/tools` returns, so the two surfaces
 *  keep listing exactly the same set. */
export function searchToolCatalogEntry(total: number, hidden: number): NamespacedTool {
  return { ...searchToolDefinition(total, hidden), provider: RESERVED_PREFIX, maturity: 'beta' }
}

export async function callSearchTool(
  deps: CatalogDeps,
  input: { workspaceId: string; scope: CredentialScope; args: unknown },
): Promise<ToolResult> {
  const args = (input.args ?? {}) as Record<string, unknown>
  const query = args.query
  if (typeof query !== 'string' || query.trim() === '') {
    throw new GatewayError('invalid_arguments', 'query is required')
  }

  const { tools } = await listWorkspaceTools(deps, input.workspaceId, {
    limit: null,
    ...(typeof args.provider === 'string' ? { provider: args.provider } : {}),
  })

  // Filtered on the results rather than on the tool itself. A read-only or
  // provider-scoped credential still has to discover what it may call, but it
  // must not learn that other providers are connected.
  const visible = tools.filter((tool) => scopeAllowsProvider(input.scope, tool.provider))
  const hits = searchTools(visible, query, clampLimit(args.limit))

  return {
    content: {
      query,
      matched: hits.length,
      tools: hits.map((tool) => ({
        name: tool.name,
        provider: tool.provider,
        description: tool.description,
        write: tool.write,
        inputSchema: tool.inputSchema,
      })),
    },
    nextCursor: null,
    hasMore: false,
  }
}

// Clamped, not rejected: an agent guessing 500 wants as many as it can have,
// and failing the call teaches it to stop searching.
function clampLimit(raw: unknown): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 1) return DEFAULT_LIMIT
  return Math.min(Math.floor(value), MAX_LIMIT)
}
