import { describe, expect, it } from 'vitest'
import { gmailProvider } from '../../src/adapters/providers/gmail.ts'
import { fakeUpstream, itemsPage, type FakeUpstream } from '../helpers/fake-upstream.ts'
import { runAdapterConformance } from '../conformance/adapter.ts'

const gmail = gmailProvider()

function ctx(upstream: FakeUpstream) {
  return {
    workspaceId: 'ws-1',
    requestId: 'req-1',
    accessToken: 'ya29.token',
    fetch: upstream.fetch,
  }
}

function messages(count: number, over: object = {}) {
  return { messages: itemsPage(count), resultSizeEstimate: count, ...over }
}

describe('gmail provider conformance', () => {
  runAdapterConformance(gmail, {
    pagedTool: 'list_messages',
    fullPage: {
      args: { query: 'is:unread' },
      upstream: fakeUpstream([
        { match: /messages/, body: messages(25, { nextPageToken: '09876543' }) },
      ]),
    },
    lastPage: {
      args: { query: 'is:unread' },
      upstream: fakeUpstream([{ match: /messages/, body: messages(4) }]),
    },
  })
})

describe('gmail provider', () => {
  it('rides the google grant rather than a gmail one', () => {
    expect(gmail.grantId).toBe('google')
    expect(gmail.prefix).toBe('gmail')
  })

  it('sends the search query as q and ends the list when no page token comes back', async () => {
    const upstream = fakeUpstream([{ match: /messages/, body: messages(2) }])
    const result = await gmail.callTool(ctx(upstream), 'list_messages', { query: 'is:unread' })
    const url = upstream.calls[0]?.url ?? ''
    expect(url).toContain('q=is%3Aunread')
    expect(url).toContain('maxResults=25')
    expect(result).toMatchObject({ hasMore: false, nextCursor: null })
  })

  it('keeps the headers a mail client needs and drops the rest of the payload', async () => {
    const upstream = fakeUpstream([
      {
        match: /messages/,
        body: {
          id: 'm1',
          threadId: 't1',
          snippet: 'Your build finished',
          internalDate: '1754000000000',
          labelIds: ['UNREAD', 'INBOX'],
          sizeEstimate: 4096,
          payload: {
            headers: [
              { name: 'From', value: 'ci@example.test' },
              { name: 'Subject', value: 'Build 41 passed' },
            ],
            body: { data: 'base64-of-the-whole-message' },
          },
        },
      },
    ])
    const result = await gmail.callTool(ctx(upstream), 'get_message', { id: 'm1' })
    expect(result.content).toEqual({
      id: 'm1',
      threadId: 't1',
      snippet: 'Your build finished',
      internalDate: '1754000000000',
      labelIds: ['UNREAD', 'INBOX'],
      payload: {
        headers: [
          { name: 'From', value: 'ci@example.test' },
          { name: 'Subject', value: 'Build 41 passed' },
        ],
      },
    })
    expect(JSON.stringify(result)).not.toContain('base64-of-the-whole-message')
    expect(upstream.calls[0]?.url).toContain('format=metadata')
  })

  it('reads the unread count off a label', async () => {
    const upstream = fakeUpstream([
      {
        match: /labels/,
        body: { id: 'UNREAD', name: 'UNREAD', type: 'system', messagesUnread: 3, threadsUnread: 2 },
      },
    ])
    const result = await gmail.callTool(ctx(upstream), 'get_label', { id: 'UNREAD' })
    expect(result.content).toMatchObject({ id: 'UNREAD', messagesUnread: 3 })
  })
})
