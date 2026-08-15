import { describe, expect, it } from 'vitest'
import { createRegistry } from '../src/adapters/providers/registry.ts'
import { fakeProvider } from '../src/adapters/providers/fake.ts'
import { githubProvider } from '../src/adapters/providers/github.ts'
import { callSearchTool, searchToolDefinition, SEARCH_TOOL } from '../src/application/meta-tools.ts'
import type { CredentialScope } from '../src/domain/credential.ts'
import type { EnablementStore } from '../src/ports/stores.ts'

const enablement: EnablementStore = {
  async enabledPrefixes() { return ['fake', 'github'] },
  async disabledTools() { return new Set<string>() },
  async enable() {},
  async disable() {},
  async setToolOverride() {},
}

const deps = { registry: createRegistry([fakeProvider(), githubProvider()]), enablement }
const open: CredentialScope = { providers: null, readOnly: false }

function call(args: unknown, scope = open) {
  return callSearchTool(deps, { workspaceId: 'ws-1', scope, args })
}

describe('the search tool definition', () => {
  it('states the hidden count so a model knows the list is not everything', () => {
    expect(searchToolDefinition(80, 20).description).toContain('20 of them are not in this list')
  })

  it('omits the sentence when nothing is hidden', () => {
    const description = searchToolDefinition(12, 0).description
    expect(description).toContain('Search the 12 tools')
    expect(description).not.toContain('not in this list')
  })

  it('is named under the reserved prefix and is not a write', () => {
    expect(searchToolDefinition(1, 0).name).toBe(SEARCH_TOOL)
    expect(searchToolDefinition(1, 0).write).toBe(false)
  })
})

describe('calling the search tool', () => {
  it('finds a tool by name across every enabled provider', async () => {
    const result = (await call({ query: 'create issue' })).content as {
      matched: number
      tools: { name: string }[]
    }
    expect(result.tools[0]?.name).toBe('github__create_issue')
    expect(result.matched).toBeGreaterThan(0)
  })

  it('returns schemas ready to pass straight to a tool call', async () => {
    const result = (await call({ query: 'create issue' })).content as {
      tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[]
    }
    expect(Object.keys(result.tools[0]?.inputSchema.properties ?? {})).toContain('owner')
  })

  it('restricts to one provider when asked', async () => {
    const result = (await call({ query: 'echo', provider: 'fake' })).content as {
      tools: { provider: string }[]
    }
    expect(result.tools.every((tool) => tool.provider === 'fake')).toBe(true)
  })

  it('does not leak a provider the credential may not call', async () => {
    const scoped: CredentialScope = { providers: ['fake'], readOnly: false }
    const result = (await call({ query: 'issue' }, scoped)).content as { tools: unknown[] }
    // Every issue tool belongs to github, which this credential cannot reach.
    expect(result.tools).toEqual([])
  })

  it('rejects a missing or blank query', async () => {
    await expect(call({})).rejects.toMatchObject({ code: 'invalid_arguments' })
    await expect(call({ query: '  ' })).rejects.toMatchObject({ code: 'invalid_arguments' })
  })

  it('clamps an oversized limit rather than failing the call', async () => {
    const result = (await call({ query: 'issue', limit: 5000 })).content as { tools: unknown[] }
    expect(result.tools.length).toBeGreaterThan(0)
    expect(result.tools.length).toBeLessThanOrEqual(100)
  })

  it('reports no pagination, because it answers from one in-memory list', async () => {
    const result = await call({ query: 'issue' })
    expect(result.hasMore).toBe(false)
    expect(result.nextCursor).toBeNull()
  })
})
