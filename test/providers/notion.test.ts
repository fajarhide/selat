import { describe, expect, it } from 'vitest'
import { notionProvider } from '../../src/adapters/providers/notion.ts'
import { fakeUpstream, itemsPage, type FakeUpstream } from '../helpers/fake-upstream.ts'
import { runAdapterConformance } from '../conformance/adapter.ts'

const notion = notionProvider()

function ctx(upstream: FakeUpstream) {
  return {
    workspaceId: 'ws-1',
    requestId: 'req-1',
    accessToken: 'ntn_token',
    fetch: upstream.fetch,
  }
}

function results(count: number, over: object) {
  return { results: itemsPage(count), ...over }
}

describe('notion provider conformance', () => {
  runAdapterConformance(notion, {
    pagedTool: 'search',
    fullPage: {
      args: { query: 'roadmap' },
      upstream: fakeUpstream([
        { match: /search/, body: results(25, { has_more: true, next_cursor: 'abc' }) },
      ]),
    },
    lastPage: {
      args: { query: 'roadmap' },
      upstream: fakeUpstream([
        { match: /search/, body: results(4, { has_more: false, next_cursor: null }) },
      ]),
    },
  })
})

describe('notion provider', () => {
  it('trusts has_more rather than counting the page', async () => {
    // A full page that is genuinely the last one: counting items would call
    // this "more", and Notion is the reason the cursor style exists.
    const upstream = fakeUpstream([
      { match: /search/, body: results(25, { has_more: false, next_cursor: 'leftover' }) },
    ])
    const result = await notion.callTool(ctx(upstream), 'search', { query: 'x' })
    expect(result.hasMore).toBe(false)
    expect(result.nextCursor).toBeNull()
  })

  it('sends the search query and the cursor in the POST body, not the query string', async () => {
    const upstream = fakeUpstream([
      { match: /search/, body: results(2, { has_more: true, next_cursor: 'next' }) },
    ])
    await notion.callTool(ctx(upstream), 'search', { query: 'roadmap', cursor: 'abc' })
    const call = upstream.calls[0]
    expect(call?.url).not.toContain('?')
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      query: 'roadmap',
      page_size: 25,
      start_cursor: 'abc',
    })
  })

  it('carries the API version every Notion request needs', async () => {
    const upstream = fakeUpstream([{ match: /pages/, body: { id: 'p1' } }])
    await notion.callTool(ctx(upstream), 'get_page', { page_id: 'p1' })
    const headers = upstream.calls[0]?.init?.headers as Record<string, string>
    expect(headers['notion-version']).toBe('2022-06-28')
  })
})
