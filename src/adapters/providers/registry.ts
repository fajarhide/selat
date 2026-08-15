import { GatewayError } from '../../domain/errors.ts'

export type Maturity = 'experimental' | 'beta' | 'ga'

export type ToolDef = {
  name: string
  description: string
  inputSchema: object
  write: boolean
}

export type AdapterContext = {
  workspaceId: string
  requestId: string
  accessToken: string | null
  fetch: typeof fetch
}

export type ToolResult = {
  content: unknown
  nextCursor?: string | null
  hasMore?: boolean
  resultTruncated?: boolean
}

export interface ProviderAdapter {
  id: string
  prefix: string
  grantId: string
  maturity: Maturity
  /** OAuth scopes this provider needs on its grant. */
  scopes: string[]
  /** Whether a call needs a connected account. Absent means yes, because a
   *  provider that forgot to say would otherwise send `Bearer null` upstream. */
  needsCredential?: boolean
  listTools(): ToolDef[]
  callTool(ctx: AdapterContext, tool: string, args: unknown): Promise<ToolResult>
  mapError(err: unknown): GatewayError
}

export type Registry = {
  get(prefix: string): ProviderAdapter
  all(): ProviderAdapter[]
}

export function createRegistry(adapters: ProviderAdapter[]): Registry {
  const byPrefix = new Map(adapters.map((adapter) => [adapter.prefix, adapter]))
  if (byPrefix.size !== adapters.length) throw new Error('duplicate provider prefix in registry')
  return {
    get(prefix) {
      const found = byPrefix.get(prefix)
      if (!found) throw new GatewayError('tool_not_found', `unknown provider: ${prefix}`)
      return found
    },
    all: () => [...byPrefix.values()],
  }
}
