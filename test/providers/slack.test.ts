import { describe, expect, it } from 'vitest'
import { slackProvider } from '../../src/adapters/providers/slack.ts'
import { fakeUpstream, itemsPage, type FakeUpstream } from '../helpers/fake-upstream.ts'
import { runAdapterConformance } from '../conformance/adapter.ts'

const slack = slackProvider()

function ctx(upstream: FakeUpstream) {
  return {
    workspaceId: 'ws-1',
    requestId: 'req-1',
    accessToken: 'xoxb-token',
    fetch: upstream.fetch,
  }
}

function channels(count: number, nextCursor: string) {
  return {
    ok: true,
    channels: itemsPage(count),
    response_metadata: { next_cursor: nextCursor },
  }
}

describe('slack provider conformance', () => {
  runAdapterConformance(slack, {
    pagedTool: 'list_channels',
    fullPage: {
      args: {},
      upstream: fakeUpstream([{ match: /conversations/, body: channels(100, 'dGVhbTpDMDE=') }]),
    },
    lastPage: {
      args: {},
      upstream: fakeUpstream([{ match: /conversations/, body: channels(4, '') }]),
    },
  })
})

describe('slack provider', () => {
  it('maps {ok: false} on a 200 onto the gateway error set', async () => {
    const cases: [string, string][] = [
      ['ratelimited', 'rate_limited'],
      ['invalid_auth', 'reauth_required'],
      ['missing_scope', 'credential_scope_denied'],
      ['some_new_failure', 'upstream_error'],
    ]
    for (const [upstreamError, expected] of cases) {
      const upstream = fakeUpstream([
        { match: /conversations/, body: { ok: false, error: upstreamError } },
      ])
      const err = await slack.callTool(ctx(upstream), 'list_channels', {}).catch((e) => e)
      expect(err.code, upstreamError).toBe(expected)
      expect(err.details.provider).toBe('slack')
    }
  })

  it('treats an empty next_cursor as the end of the list', async () => {
    const more = fakeUpstream([{ match: /conversations/, body: channels(100, 'ZZZ') }])
    expect(await slack.callTool(ctx(more), 'list_channels', {})).toMatchObject({
      hasMore: true,
      nextCursor: 'ZZZ',
    })

    const done = fakeUpstream([{ match: /conversations/, body: channels(100, '') }])
    expect(await slack.callTool(ctx(done), 'list_channels', {})).toMatchObject({
      hasMore: false,
      nextCursor: null,
    })
  })

  it('posts a message as a JSON body and projects the receipt', async () => {
    const upstream = fakeUpstream([
      { match: /postMessage/, body: { ok: true, ts: '1.2', channel: 'C1', message: { text: 'x' } } },
    ])
    const result = await slack.callTool(ctx(upstream), 'post_message', {
      channel: 'C1',
      text: 'hello',
    })
    expect(JSON.parse(String(upstream.calls[0]?.init?.body))).toEqual({
      channel: 'C1',
      text: 'hello',
    })
    expect(result.content).toEqual({ ts: '1.2', channel: 'C1' })
  })
})
