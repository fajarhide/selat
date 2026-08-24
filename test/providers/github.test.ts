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

describe('github pull requests', () => {
  it('keeps the head sha on a listed pull request, so checks need no second call', async () => {
    const upstream = fakeUpstream([
      {
        match: /pulls/,
        body: [
          {
            number: 43,
            title: 'fix something',
            state: 'open',
            draft: false,
            user: { login: 'ada', email: 'drop@me.test' },
            head: { sha: 'deadbeef', ref: 'topic' },
            html_url: 'https://github.test/pr/43',
            updated_at: '2026-08-23T00:00:00Z',
          },
        ],
      },
    ])
    const result = await github.callTool(ctx(upstream), 'list_pull_requests', {
      owner: 'o',
      repo: 'r',
    })
    expect(result.content).toEqual({
      items: [
        {
          number: 43,
          title: 'fix something',
          state: 'open',
          draft: false,
          user: { login: 'ada' },
          head: { sha: 'deadbeef' },
          html_url: 'https://github.test/pr/43',
          updated_at: '2026-08-23T00:00:00Z',
        },
      ],
    })
    expect(new URL(upstream.calls[0]?.url ?? '').searchParams.get('state')).toBe('open')
  })

  it('reads the check runs off the array the endpoint nests them in', async () => {
    // The response is {total_count, check_runs: [...]}, not a bare array, so a
    // wrong items path would report a healthy commit as having no checks.
    const upstream = fakeUpstream([
      {
        match: /check-runs/,
        body: {
          total_count: 2,
          check_runs: [
            { name: 'test', status: 'completed', conclusion: 'success', noise: 'x' },
            { name: 'secrets', status: 'completed', conclusion: 'success' },
          ],
        },
      },
    ])
    const result = await github.callTool(ctx(upstream), 'list_check_runs', {
      owner: 'o',
      repo: 'r',
      ref: 'deadbeef',
    })
    expect(result.content).toEqual({
      items: [
        { name: 'test', status: 'completed', conclusion: 'success' },
        { name: 'secrets', status: 'completed', conclusion: 'success' },
      ],
    })
    expect(upstream.calls[0]?.url).toContain('/commits/deadbeef/check-runs')
  })

  it('separates a review verdict from the line a comment sits on', async () => {
    const reviews = fakeUpstream([
      { match: /reviews/, body: [{ id: 1, user: { login: 'ada' }, state: 'CHANGES_REQUESTED', body: 'no' }] },
    ])
    const verdicts = await github.callTool(ctx(reviews), 'list_pull_request_reviews', {
      owner: 'o',
      repo: 'r',
      number: 43,
    })
    expect(verdicts.content).toEqual({
      items: [{ id: 1, user: { login: 'ada' }, state: 'CHANGES_REQUESTED', body: 'no' }],
    })

    const inline = fakeUpstream([
      { match: /comments/, body: [{ id: 9, user: { login: 'ada' }, path: 'src/a.ts', line: 12, body: 'here' }] },
    ])
    const comments = await github.callTool(ctx(inline), 'list_pull_request_comments', {
      owner: 'o',
      repo: 'r',
      number: 43,
    })
    expect(comments.content).toEqual({
      items: [{ id: 9, user: { login: 'ada' }, path: 'src/a.ts', line: 12, body: 'here' }],
    })
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

describe('github writes', () => {
  it('closes an issue with a PATCH that carries the state in the body', async () => {
    // The executor routes an unmatched argument by method, so a PATCH that put
    // state in the query string would answer 200 and change nothing.
    const upstream = fakeUpstream([{ match: /issues/, body: { number: 7, state: 'closed' } }])
    const result = await github.callTool(ctx(upstream), 'update_issue', {
      owner: 'o',
      repo: 'r',
      number: 7,
      state: 'closed',
    })
    expect(result.content).toEqual({ number: 7, state: 'closed' })
    expect(upstream.calls[0]?.init?.method).toBe('PATCH')
    expect(upstream.calls[0]?.url).not.toContain('state=')
    expect(JSON.parse(String(upstream.calls[0]?.init?.body))).toEqual({ state: 'closed' })
  })

  it('sends a review verdict and refuses one the API does not accept', async () => {
    const upstream = fakeUpstream([{ match: /reviews/, body: { id: 5, state: 'CHANGES_REQUESTED' } }])
    await github.callTool(ctx(upstream), 'create_pull_request_review', {
      owner: 'o',
      repo: 'r',
      number: 43,
      body: 'no',
      event: 'REQUEST_CHANGES',
    })
    expect(JSON.parse(String(upstream.calls[0]?.init?.body))).toEqual({
      body: 'no',
      event: 'REQUEST_CHANGES',
    })

    await expect(
      github.callTool(ctx(upstream), 'create_pull_request_review', {
        owner: 'o',
        repo: 'r',
        number: 43,
        body: 'no',
        event: 'LGTM',
      }),
    ).rejects.toMatchObject({ code: 'invalid_arguments' })
  })

  it('merges with a PUT and reports a refused merge as merged false', async () => {
    // GitHub answers 200 with merged false when the branch moved, so dropping
    // the field would read as a successful merge that never happened.
    const upstream = fakeUpstream([
      { match: /merge/, body: { sha: 'abc', merged: false, message: 'Base branch was modified' } },
    ])
    const result = await github.callTool(ctx(upstream), 'merge_pull_request', {
      owner: 'o',
      repo: 'r',
      number: 43,
    })
    expect(result.content).toEqual({ sha: 'abc', merged: false, message: 'Base branch was modified' })
    expect(upstream.calls[0]?.init?.method).toBe('PUT')
    expect(JSON.parse(String(upstream.calls[0]?.init?.body))).toEqual({ merge_method: 'merge' })
  })
})
