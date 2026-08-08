import { describe, expect, it } from 'vitest'
import { createRegistry } from '../src/adapters/providers/registry.ts'
import { fakeProvider } from '../src/adapters/providers/fake.ts'
import { listWorkspaceTools, TOOL_BUDGET } from '../src/application/catalog.ts'
import type { EnablementStore } from '../src/ports/stores.ts'

const enablement: EnablementStore = {
  async enabledPrefixes() {
    return ['fake']
  },
  async disabledTools() {
    return new Set<string>()
  },
  async enable() {},
  async disable() {},
  async setToolOverride() {},
}

const registry = createRegistry([fakeProvider()])

describe('catalog', () => {
  it('namespaces every tool with its provider prefix', async () => {
    const { tools } = await listWorkspaceTools({ registry, enablement }, 'ws-1')
    expect(tools.map((tool) => tool.name)).toContain('fake__echo')
    expect(tools.every((tool) => tool.name.startsWith('fake__'))).toBe(true)
  })

  it('reports the provider maturity so a client can judge the tool', async () => {
    const { tools } = await listWorkspaceTools({ registry, enablement }, 'ws-1')
    expect(tools[0]?.maturity).toBe('experimental')
  })

  it('filters by provider', async () => {
    const { tools } = await listWorkspaceTools({ registry, enablement }, 'ws-1', {
      provider: 'nope',
    })
    expect(tools).toEqual([])
  })

  it('hides a provider that is not enabled for the workspace', async () => {
    const none = { ...enablement, async enabledPrefixes() { return [] } }
    const { tools } = await listWorkspaceTools({ registry, enablement: none }, 'ws-1')
    expect(tools).toEqual([])
  })

  it('hides a tool disabled by an override', async () => {
    const off = { ...enablement, async disabledTools() { return new Set(['fake__echo']) } }
    const { tools } = await listWorkspaceTools({ registry, enablement: off }, 'ws-1')
    expect(tools.map((tool) => tool.name)).not.toContain('fake__echo')
    expect(tools.length).toBeGreaterThan(0)
  })

  it('caps the catalog at the tool budget and says so', async () => {
    const big = createRegistry([fakeProvider({ toolCount: TOOL_BUDGET + 5 })])
    const { tools, truncated } = await listWorkspaceTools({ registry: big, enablement }, 'ws-1')
    expect(tools).toHaveLength(TOOL_BUDGET)
    expect(truncated).toBe(true)
  })

  it('does not claim truncation when everything fits', async () => {
    const { truncated } = await listWorkspaceTools({ registry, enablement }, 'ws-1')
    expect(truncated).toBe(false)
  })
})
