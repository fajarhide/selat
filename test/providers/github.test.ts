import { describe, expect, it } from 'vitest'
import { githubProvider } from '../../src/adapters/providers/github.ts'
import { fakeUpstream, itemsPage, type FakeUpstream } from '../helpers/fake-upstream.ts'
import { runAdapterConformance } from '../conformance/adapter.ts'

const github = githubProvider()

function ctx(upstream: FakeUpstream) {
  return {
    workspaceId: 'ws-1',
    requestId: 'req-1',
    accessToken: 'gho_token',
    fetch: upstream.fetch,
  }
}

describe('github provider conformance', () => {
  runAdapterConformance(github, {
    pagedTool: 'list_issues',
    fullPage: {
      args: { owner: 'octo', repo: 'demo' },
      upstream: fakeUpstream([{ match: /issues/, body: itemsPage(30) }]),
    },
    lastPage: {
      args: { owner: 'octo', repo: 'demo' },
      upstream: fakeUpstream([{ match: /issues/, body: itemsPage(4) }]),
    },
  })
})

describe('github provider', () => {
  it('advances the cursor only when a full page came back', async () => {
    const full = fakeUpstream([{ match: /issues/, body: itemsPage(30) }])
    const first = await github.callTool(ctx(full), 'list_issues', { owner: 'o', repo: 'r' })
    expect(first.nextCursor).toBe('2')

    const short = fakeUpstream([{ match: /issues/, body: itemsPage(1) }])
    const last = await github.callTool(ctx(short), 'list_issues', { owner: 'o', repo: 'r' })
    expect(last.hasMore).toBe(false)
    expect(last.nextCursor).toBeNull()
  })

  it('sends the cursor back as the page number', async () => {
    const upstream = fakeUpstream([{ match: /issues/, body: itemsPage(2) }])
    await github.callTool(ctx(upstream), 'list_issues', { owner: 'o', repo: 'r', cursor: '3' })
    expect(upstream.calls[0]?.url).toContain('page=3')
  })

  it('refuses a cursor it never issued', async () => {
    const upstream = fakeUpstream([{ match: /issues/, body: itemsPage(2) }])
    await expect(
      github.callTool(ctx(upstream), 'list_issues', { owner: 'o', repo: 'r', cursor: 'nonsense' }),
    ).rejects.toMatchObject({ code: 'invalid_arguments' })
  })

  it('escapes path segments so an owner cannot reach another endpoint', async () => {
    const upstream = fakeUpstream([{ match: /repos/, body: itemsPage(1) }])
    await github.callTool(ctx(upstream), 'list_issues', { owner: '../../orgs', repo: 'r' })
    expect(upstream.calls[0]?.url).not.toContain('/orgs/')
    expect(upstream.calls[0]?.url).toContain('%2F')
  })

  it('maps a rate limited response to rate_limited with a retry hint', async () => {
    const limited = fakeUpstream([
      {
        match: /issues/,
        status: 403,
        body: {},
        headers: { 'x-ratelimit-remaining': '0', 'retry-after': '42' },
      },
    ])
    const err = await github
      .callTool(ctx(limited), 'list_issues', { owner: 'o', repo: 'r' })
      .catch((e) => e)
    expect(err.code).toBe('rate_limited')
    expect(err.details.retryAfter).toBe(42)
  })

  it('separates a permission problem from a rate limit on the same status', async () => {
    const denied = fakeUpstream([
      { match: /issues/, status: 403, body: {}, headers: { 'x-ratelimit-remaining': '4999' } },
    ])
    const err = await github
      .callTool(ctx(denied), 'list_issues', { owner: 'o', repo: 'r' })
      .catch((e) => e)
    expect(err.code).toBe('reauth_required')
  })

  it('maps a 401 to reauth_required', async () => {
    const denied = fakeUpstream([{ match: /issues/, status: 401, body: {} }])
    const err = await github
      .callTool(ctx(denied), 'list_issues', { owner: 'o', repo: 'r' })
      .catch((e) => e)
    expect(err.code).toBe('reauth_required')
  })

  it('maps a server failure to upstream_error', async () => {
    const broken = fakeUpstream([{ match: /issues/, status: 500, body: {} }])
    const err = await github
      .callTool(ctx(broken), 'list_issues', { owner: 'o', repo: 'r' })
      .catch((e) => e)
    expect(err.code).toBe('upstream_error')
    expect(err.details.provider).toBe('github')
  })

  it('requires the arguments its schema marks required', async () => {
    const upstream = fakeUpstream([{ match: /issues/, body: itemsPage(1) }])
    await expect(
      github.callTool(ctx(upstream), 'list_issues', { owner: 'o' }),
    ).rejects.toMatchObject({ code: 'invalid_arguments' })
  })

  it('creates an issue as a write, carrying the request id upstream', async () => {
    const upstream = fakeUpstream([{ match: /issues/, body: { number: 7 } }])
    const result = await github.callTool(ctx(upstream), 'create_issue', {
      owner: 'o',
      repo: 'r',
      title: 'hello',
    })
    expect(result.content).toEqual({ number: 7 })
    const headers = upstream.calls[0]?.init?.headers as Record<string, string>
    expect(headers['x-request-id']).toBe('req-1')
    expect(upstream.calls[0]?.init?.method).toBe('POST')
    expect(github.listTools().find((tool) => tool.name === 'create_issue')?.write).toBe(true)
  })
})
