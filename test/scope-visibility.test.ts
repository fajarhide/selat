import { describe, expect, it } from 'vitest'
import { assertScopeAllows, scopeAllowsTool } from '../src/domain/credential.ts'
import { githubProvider } from '../src/adapters/providers/github.ts'
import { gdriveProvider } from '../src/adapters/providers/gdrive.ts'

const listed = (scope: { providers: string[] | null; readOnly: boolean }) =>
  [githubProvider(), gdriveProvider()].flatMap((adapter) =>
    adapter
      .listTools()
      .map((tool) => ({ provider: adapter.prefix, write: tool.write, name: tool.name }))
      .filter((tool) => scopeAllowsTool(scope, tool)),
  )

describe('what a credential is shown', () => {
  it('hides every write tool from a read-only credential', () => {
    const tools = listed({ providers: null, readOnly: true })
    expect(tools.some((tool) => tool.name === 'list_files')).toBe(true)
    expect(tools.some((tool) => tool.write)).toBe(false)
    expect(tools.map((tool) => tool.name)).not.toContain('delete_file')
  })

  it('hides other providers, and keeps writes when the credential has them', () => {
    const tools = listed({ providers: ['gdrive'], readOnly: false })
    expect(new Set(tools.map((tool) => tool.provider))).toEqual(new Set(['gdrive']))
    expect(tools.map((tool) => tool.name)).toContain('delete_file')
  })

  it('lists a tool exactly when the same scope would let it be called', () => {
    // The invariant that matters. A list and a gate that disagree spend a
    // model's turn to teach it a 403 that was knowable before the list existed.
    for (const scope of [
      { providers: null, readOnly: false },
      { providers: null, readOnly: true },
      { providers: ['gdrive'], readOnly: true },
      { providers: ['github'], readOnly: false },
      { providers: [], readOnly: false },
    ]) {
      for (const adapter of [githubProvider(), gdriveProvider()]) {
        for (const tool of adapter.listTools()) {
          const shown = scopeAllowsTool(scope, { provider: adapter.prefix, write: tool.write })
          let callable = true
          try {
            assertScopeAllows(scope, adapter.prefix, tool.write)
          } catch {
            callable = false
          }
          expect(shown).toBe(callable)
        }
      }
    }
  })
})
