import { expect, it } from 'vitest'
import { GatewayError } from '../../src/domain/errors.ts'
import type { ProviderAdapter } from '../../src/adapters/providers/registry.ts'
import type { FakeUpstream } from '../helpers/fake-upstream.ts'

export type PageCase = { args: object; upstream: FakeUpstream }

export type ConformanceFixtures = {
  /** A tool whose result is a page, used to check the pagination contract. */
  pagedTool: string
  /** A call that lands mid list, so more pages must be reported. */
  fullPage: PageCase
  /** A call that lands on the last page, so no cursor may be handed back. */
  lastPage: PageCase
}

const ACCESS_TOKEN = 'conformance-access-token'

/**
 * Every adapter must pass this suite, including community contributions. It is
 * the only thing standing between a growing catalog and a catalog that lies
 * about pagination, leaks a token or invents its own error codes.
 */
export function runAdapterConformance(adapter: ProviderAdapter, fx: ConformanceFixtures): void {
  const ctx = (upstream: FakeUpstream) => ({
    workspaceId: 'ws-1',
    requestId: 'req-1',
    accessToken: ACCESS_TOKEN,
    fetch: upstream.fetch,
  })

  it('declares a lowercase prefix and a grant id', () => {
    expect(adapter.prefix).toMatch(/^[a-z][a-z0-9]*$/)
    expect(adapter.grantId.length).toBeGreaterThan(0)
    expect(['experimental', 'beta', 'ga']).toContain(adapter.maturity)
  })

  it('declares every tool with an object input schema and a write flag', () => {
    const tools = adapter.listTools()
    expect(tools.length).toBeGreaterThan(0)
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/)
      expect(tool.description.length).toBeGreaterThan(10)
      const schema = tool.inputSchema as { type?: string; properties?: object }
      expect(schema.type).toBe('object')
      expect(schema.properties).toBeTypeOf('object')
      expect(typeof tool.write).toBe('boolean')
    }
  })

  it('returns unique tool names', () => {
    const names = adapter.listTools().map((tool) => tool.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('reports more pages honestly when the upstream returned a full one', async () => {
    const result = await adapter.callTool(ctx(fx.fullPage.upstream), fx.pagedTool, fx.fullPage.args)
    expect(result).toHaveProperty('hasMore')
    expect(result.hasMore).toBe(true)
    expect(result.nextCursor).toBeTruthy()
  })

  it('reports the end of a list rather than an empty cursor', async () => {
    const result = await adapter.callTool(ctx(fx.lastPage.upstream), fx.pagedTool, fx.lastPage.args)
    expect(result.hasMore).toBe(false)
    expect(result.nextCursor ?? null).toBeNull()
  })

  it('maps an arbitrary throw to a GatewayError carrying its provider', () => {
    const mapped = adapter.mapError(new Error('anything'))
    expect(mapped).toBeInstanceOf(GatewayError)
    expect(mapped.details.provider).toBe(adapter.prefix)
  })

  it('passes a GatewayError through mapError unchanged', () => {
    const original = new GatewayError('rate_limited', 'slow down', { provider: adapter.prefix })
    expect(adapter.mapError(original)).toBe(original)
  })

  it('rejects an unknown tool with tool_not_found', async () => {
    const err = await adapter
      .callTool(ctx(fx.fullPage.upstream), 'definitely_not_a_tool', {})
      .catch((e) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect(err.code).toBe('tool_not_found')
  })

  it('never returns the access token in a result', async () => {
    const result = await adapter.callTool(ctx(fx.fullPage.upstream), fx.pagedTool, fx.fullPage.args)
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN)
  })
}
