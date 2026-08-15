import { describe, expect, it, vi } from 'vitest'
import { callTool, type CallDeps } from '../src/application/call-tool.ts'
import { createRegistry } from '../src/adapters/providers/registry.ts'
import { fakeProvider } from '../src/adapters/providers/fake.ts'
import { GatewayError } from '../src/domain/errors.ts'

function deps(overrides: Partial<CallDeps> = {}): CallDeps {
  const memory = new Map<string, never>()
  return {
    registry: createRegistry([fakeProvider()]),
    enablement: {
      async enabledPrefixes() { return ['fake'] },
      async disabledTools() { return new Set<string>() },
      async enable() {},
      async disable() {},
    async setToolOverride() {},
    },
    grants: { async accessTokenFor() { return 'token' } },
    idempotency: {
      async get(_workspaceId, key) { return memory.get(key) ?? null },
      async put(_workspaceId, key, result) { memory.set(key, result as never) },
    },
    ...overrides,
  }
}

const base = { workspaceId: 'ws-1', scope: { providers: null, readOnly: false }, requestId: 'r1' }

describe('callTool', () => {
  it('routes a namespaced call to its adapter', async () => {
    const result = await callTool(deps(), { ...base, name: 'fake__echo', args: { message: 'hi' } })
    expect(result.content).toEqual({ message: 'hi' })
  })

  it('rejects an unknown tool', async () => {
    await expect(
      callTool(deps(), { ...base, name: 'fake__nope', args: {} }),
    ).rejects.toMatchObject({ code: 'tool_not_found' })
  })

  it('rejects an unqualified tool name', async () => {
    await expect(callTool(deps(), { ...base, name: 'echo', args: {} })).rejects.toMatchObject({
      code: 'tool_not_found',
    })
  })

  it('rejects a provider that is not connected for the workspace', async () => {
    const detached = deps({
      enablement: {
        async enabledPrefixes() { return [] },
        async disabledTools() { return new Set<string>() },
        async enable() {},
        async disable() {},
    async setToolOverride() {},
      },
    })
    await expect(
      callTool(detached, { ...base, name: 'fake__echo', args: {} }),
    ).rejects.toMatchObject({ code: 'provider_not_connected' })
  })

  it('stops an enabled provider with no grant before it reaches the upstream', async () => {
    const reached = vi.fn()
    const needy = {
      ...fakeProvider(),
      credential: 'oauth' as const,
      callTool: async () => {
        reached()
        return { content: null, nextCursor: null, hasMore: false }
      },
    }
    const ungranted = deps({
      registry: createRegistry([needy]),
      grants: { async accessTokenFor() { return null } },
    })

    await expect(
      callTool(ungranted, { ...base, name: 'fake__echo', args: {} }),
    ).rejects.toMatchObject({ code: 'provider_not_connected' })
    // reauth_required would send someone to repair a connection they never made.
    expect(reached).not.toHaveBeenCalled()
  })

  it('still lets a provider that needs no credential run without a grant', async () => {
    const ungranted = deps({ grants: { async accessTokenFor() { return null } } })
    const result = await callTool(ungranted, {
      ...base,
      name: 'fake__echo',
      args: { message: 'hi' },
    })
    expect(result.content).toEqual({ message: 'hi' })
  })

  it('rejects a tool disabled by a workspace override', async () => {
    const off = deps({
      enablement: {
        async enabledPrefixes() { return ['fake'] },
        async disabledTools() { return new Set(['fake__echo']) },
        async enable() {},
        async disable() {},
    async setToolOverride() {},
      },
    })
    await expect(callTool(off, { ...base, name: 'fake__echo', args: {} })).rejects.toMatchObject({
      code: 'tool_not_found',
    })
  })

  it('rejects a write through a read-only credential', async () => {
    await expect(
      callTool(deps(), {
        ...base,
        scope: { providers: null, readOnly: true },
        name: 'fake__write_note',
        args: { text: 'x' },
      }),
    ).rejects.toMatchObject({ code: 'credential_scope_denied' })
  })

  it('rejects a provider outside the credential allowlist', async () => {
    await expect(
      callTool(deps(), {
        ...base,
        scope: { providers: ['github'], readOnly: false },
        name: 'fake__echo',
        args: {},
      }),
    ).rejects.toMatchObject({ code: 'credential_scope_denied' })
  })

  it('replays a stored response for a repeated idempotency key', async () => {
    const shared = deps()
    const spy = vi.spyOn(shared.registry.get('fake'), 'callTool')
    const input = { ...base, name: 'fake__write_note', args: { text: 'x' }, idempotencyKey: 'k1' }
    await callTool(shared, input)
    await callTool(shared, input)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('does not replay a read, even with an idempotency key', async () => {
    const shared = deps()
    const spy = vi.spyOn(shared.registry.get('fake'), 'callTool')
    const input = { ...base, name: 'fake__echo', args: { message: 'x' }, idempotencyKey: 'k2' }
    await callTool(shared, input)
    await callTool(shared, input)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('maps an adapter throw to a gateway error carrying the provider', async () => {
    const shared = deps()
    vi.spyOn(shared.registry.get('fake'), 'callTool').mockRejectedValueOnce(new Error('boom'))
    const err = await callTool(shared, { ...base, name: 'fake__echo', args: {} }).catch((e) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect(err.code).toBe('upstream_error')
    expect(err.details.provider).toBe('fake')
  })

  it('gives up on a hanging upstream with upstream_timeout', async () => {
    const shared = deps({ timeoutMs: 20 })
    vi.spyOn(shared.registry.get('fake'), 'callTool').mockImplementationOnce(
      () => new Promise(() => {}),
    )
    await expect(callTool(shared, { ...base, name: 'fake__echo', args: {} })).rejects.toMatchObject({
      code: 'upstream_timeout',
    })
  })

  it('passes the resolved access token to the adapter', async () => {
    const shared = deps()
    const spy = vi.spyOn(shared.registry.get('fake'), 'callTool')
    await callTool(shared, { ...base, name: 'fake__echo', args: { message: 'x' } })
    expect(spy.mock.calls[0]?.[0].accessToken).toBe('token')
    expect(spy.mock.calls[0]?.[0].requestId).toBe('r1')
  })
})
