import { GatewayError } from '../../domain/errors.ts'
import type { ProviderAdapter, ToolDef } from './registry.ts'

// The fake provider exists so the call pipeline, the MCP surface and the
// metering path can be exercised without any network or OAuth grant. It is
// also what the quickstart enables, so a first tool call needs no vendor.
export function fakeProvider(opts: { toolCount?: number } = {}): ProviderAdapter {
  const count = opts.toolCount ?? 1
  const tools: ToolDef[] = [
    {
      name: 'echo',
      description: 'Return the message argument unchanged, for connectivity checks',
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
      write: false,
    },
    {
      name: 'list_items',
      description: 'Return a fixed page of items, to exercise the pagination contract',
      inputSchema: {
        type: 'object',
        properties: { cursor: { type: 'string' } },
        required: [],
      },
      write: false,
    },
    {
      name: 'write_note',
      description: 'Pretend to write a note, used to exercise the idempotency path',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      write: true,
    },
  ]

  for (let i = 1; i < count; i += 1) {
    tools.push({
      name: `noop${i}`,
      description: 'Do nothing, used to test the catalog tool budget',
      inputSchema: { type: 'object', properties: {}, required: [] },
      write: false,
    })
  }

  return {
    id: 'fake',
    prefix: 'fake',
    grantId: 'fake',
    maturity: 'experimental',
    scopes: [],
    listTools: () => tools,

    async callTool(_ctx, tool, args) {
      switch (tool) {
        case 'echo':
          return {
            content: { message: (args as { message?: string }).message ?? null },
            nextCursor: null,
            hasMore: false,
          }
        case 'list_items': {
          const page = Number((args as { cursor?: string }).cursor ?? '1')
          const hasMore = page < 2
          return {
            content: { items: [{ id: `item-${page}` }] },
            nextCursor: hasMore ? String(page + 1) : null,
            hasMore,
          }
        }
        case 'write_note':
          return { content: { ok: true }, nextCursor: null, hasMore: false }
        default:
          if (tool.startsWith('noop')) return { content: null, nextCursor: null, hasMore: false }
          throw new GatewayError('tool_not_found', `fake has no tool ${tool}`, { provider: 'fake' })
      }
    },

    mapError(err) {
      if (err instanceof GatewayError) return err
      return new GatewayError('upstream_error', 'fake provider failed', { provider: 'fake' })
    },
  }
}
