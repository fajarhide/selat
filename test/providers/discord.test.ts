import { describe, expect, it } from 'vitest'
import { discordProvider } from '../../src/adapters/providers/discord.ts'
import { manifestProvider, type ProviderManifest } from '../../src/adapters/providers/manifest.ts'
import { fakeUpstream, itemsPage, type FakeUpstream } from '../helpers/fake-upstream.ts'
import { runAdapterConformance } from '../conformance/adapter.ts'

const discord = discordProvider()

function ctx(upstream: FakeUpstream) {
  return { workspaceId: 'ws-1', requestId: 'req-1', accessToken: 'bot-secret', fetch: upstream.fetch }
}

/** Discord message ids are snowflakes, and the cursor is the last one seen. */
function messages(count: number, from = 1000) {
  return Array.from({ length: count }, (_u, i) => ({
    id: String(from + i),
    content: `message ${from + i}`,
    author: { username: 'someone', id: 'u1', avatar: 'noise' },
  }))
}

describe('discord conformance', () => {
  runAdapterConformance(discord, {
    pagedTool: 'list_messages',
    fullPage: {
      args: { channel_id: 'c1' },
      upstream: fakeUpstream([{ match: /messages/, body: messages(25) }]),
    },
    lastPage: {
      args: { channel_id: 'c1' },
      upstream: fakeUpstream([{ match: /messages/, body: messages(3) }]),
    },
  })
})

describe('a bot token rather than a consent', () => {
  it('declares itself an api key provider, so no consent is offered', () => {
    expect(discord.credential).toBe('api_key')
  })

  it('sends the token under Bot, not Bearer', async () => {
    const upstream = fakeUpstream([{ match: /users/, body: { id: 'b1', username: 'selat' } }])
    await discord.callTool(ctx(upstream), 'get_bot_user', {})
    const headers = upstream.calls[0]?.init?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bot bot-secret')
    // Bearer is what every other provider sends, and Discord rejects it.
    expect(headers.authorization).not.toContain('Bearer')
  })
})

describe('discord paging by id', () => {
  it('hands back the last id on a full page and nothing on a short one', async () => {
    const full = fakeUpstream([{ match: /messages/, body: messages(25, 1000) }])
    const first = await discord.callTool(ctx(full), 'list_messages', { channel_id: 'c1' })
    expect(first).toMatchObject({ hasMore: true, nextCursor: '1024' })

    const short = fakeUpstream([{ match: /messages/, body: messages(2) }])
    expect(await discord.callTool(ctx(short), 'list_messages', { channel_id: 'c1' })).toMatchObject({
      hasMore: false,
      nextCursor: null,
    })
  })

  it('reads the cursor id off the raw item, not the projected one', async () => {
    // list_guilds projects id away from nothing, but list_messages keeps only
    // a few fields. The cursor must survive a projection that drops it.
    const manifest: ProviderManifest = {
      id: 'demo',
      prefix: 'demo',
      maturity: 'experimental',
      baseUrl: 'https://api.demo.test',
      scopes: [],
      auth: { type: 'api_key', in: 'header', name: 'authorization', prefix: 'Bot ' },
      pagination: { style: 'id', size: 2, sizeParam: 'limit', param: 'before' },
      tools: [
        {
          name: 'list_things',
          description: 'A page whose projection drops the id it pages by',
          write: false,
          request: 'GET /things',
          args: {},
          items: '$',
          fields: ['content'],
        },
      ],
    }
    const narrow = manifestProvider(manifest)

    const upstream = fakeUpstream([
      { match: /things/, body: [{ id: '77', content: 'a' }, { id: '78', content: 'b' }] },
    ])
    const result = await narrow.callTool(ctx(upstream), 'list_things', {})
    expect(result.content).toEqual({ items: [{ content: 'a' }, { content: 'b' }] })
    expect(result.nextCursor).toBe('78')
  })

  it('asks for what came before the cursor it was given', async () => {
    const upstream = fakeUpstream([{ match: /messages/, body: messages(1) }])
    await discord.callTool(ctx(upstream), 'list_messages', { channel_id: 'c1', cursor: '1024' })
    const params = new URL(upstream.calls[0]?.url ?? '').searchParams
    expect(params.get('before')).toBe('1024')
    expect(params.get('limit')).toBe('25')
  })
})

describe('discord tools', () => {
  it('projects a message down to who said what and when', async () => {
    const upstream = fakeUpstream([{ match: /messages/, body: messages(1) }])
    const result = await discord.callTool(ctx(upstream), 'list_messages', { channel_id: 'c1' })
    expect(result.content).toEqual({
      items: [{ id: '1000', content: 'message 1000', author: { username: 'someone', id: 'u1' } }],
    })
    expect(JSON.stringify(result)).not.toContain('noise')
  })

  it('posts as a write, with the content in a json body', async () => {
    const upstream = fakeUpstream([
      { match: /messages/, body: { id: 'm9', channel_id: 'c1', timestamp: 't', extra: 'noise' } },
    ])
    const result = await discord.callTool(ctx(upstream), 'post_message', {
      channel_id: 'c1',
      content: 'hello',
    })
    expect(JSON.parse(String(upstream.calls[0]?.init?.body))).toEqual({ content: 'hello' })
    expect(result.content).toEqual({ id: 'm9', channel_id: 'c1', timestamp: 't' })
    expect(discord.listTools().find((t) => t.name === 'post_message')?.write).toBe(true)
  })

  it('escapes a channel id so it cannot walk out of the endpoint', async () => {
    const upstream = fakeUpstream([{ match: /channels/, body: itemsPage(1) }])
    await discord.callTool(ctx(upstream), 'list_messages', { channel_id: '../../guilds' })
    expect(upstream.calls[0]?.url).not.toContain('/guilds/')
    expect(upstream.calls[0]?.url).toContain('%2F')
  })
})
