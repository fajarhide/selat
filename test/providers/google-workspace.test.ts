import { describe, expect, it } from 'vitest'
import { gcalendarProvider } from '../../src/adapters/providers/gcalendar.ts'
import { gdriveProvider } from '../../src/adapters/providers/gdrive.ts'
import { gmailProvider } from '../../src/adapters/providers/gmail.ts'
import { fakeUpstream, itemsPage, type FakeUpstream } from '../helpers/fake-upstream.ts'
import { runAdapterConformance } from '../conformance/adapter.ts'

const gcal = gcalendarProvider()
const gdrive = gdriveProvider()

function ctx(upstream: FakeUpstream) {
  return { workspaceId: 'ws-1', requestId: 'req-1', accessToken: 'ya29.token', fetch: upstream.fetch }
}

describe('google calendar conformance', () => {
  runAdapterConformance(gcal, {
    pagedTool: 'list_events',
    fullPage: {
      args: {},
      upstream: fakeUpstream([
        { match: /events/, body: { items: itemsPage(25), nextPageToken: 'CAoQAA' } },
      ]),
    },
    lastPage: {
      args: {},
      upstream: fakeUpstream([{ match: /events/, body: { items: itemsPage(3) } }]),
    },
  })
})

describe('google drive conformance', () => {
  runAdapterConformance(gdrive, {
    pagedTool: 'list_files',
    fullPage: {
      args: {},
      upstream: fakeUpstream([
        { match: /files/, body: { files: itemsPage(25), nextPageToken: 'next' } },
      ]),
    },
    lastPage: {
      args: {},
      upstream: fakeUpstream([{ match: /files/, body: { files: itemsPage(2) } }]),
    },
  })
})

describe('one google application, three prefixes', () => {
  it('puts every google prefix on the same grant', () => {
    for (const provider of [gmailProvider(), gcal, gdrive]) {
      expect(provider.grantId, provider.prefix).toBe('google')
    }
    expect([gmailProvider().prefix, gcal.prefix, gdrive.prefix]).toEqual(['gmail', 'gcal', 'gdrive'])
  })

  it('asks for a different scope per prefix, which is why the union matters', () => {
    const scopes = [gmailProvider(), gcal, gdrive].flatMap((provider) => provider.scopes)
    expect(new Set(scopes).size).toBe(3)
  })
})

describe('google calendar', () => {
  it('defaults the calendar to primary, so no id lookup comes first', async () => {
    const upstream = fakeUpstream([{ match: /events/, body: { items: [] } }])
    await gcal.callTool(ctx(upstream), 'list_events', {})
    expect(upstream.calls[0]?.url).toContain('/calendars/primary/events')
  })

  it('expands recurring events and orders by start unless told otherwise', async () => {
    const upstream = fakeUpstream([{ match: /events/, body: { items: [] } }])
    await gcal.callTool(ctx(upstream), 'list_events', {})
    const url = upstream.calls[0]?.url ?? ''
    expect(url).toContain('singleEvents=true')
    expect(url).toContain('orderBy=startTime')
  })

  it('projects an event down to the fields a calendar question needs', async () => {
    const upstream = fakeUpstream([
      {
        match: /events/,
        body: {
          id: 'e1',
          summary: 'Standup',
          status: 'confirmed',
          start: { dateTime: '2026-08-15T09:00:00Z' },
          end: { dateTime: '2026-08-15T09:15:00Z' },
          organizer: { email: 'lead@example.test', displayName: 'Lead' },
          iCalUID: 'noise',
          etag: 'noise',
        },
      },
    ])
    const result = await gcal.callTool(ctx(upstream), 'get_event', { event_id: 'e1' })
    expect(result.content).toMatchObject({
      id: 'e1',
      summary: 'Standup',
      organizer: { email: 'lead@example.test' },
    })
    expect(JSON.stringify(result.content)).not.toContain('noise')
  })
})

describe('google drive', () => {
  it('names the fields it wants, because Drive returns almost nothing otherwise', async () => {
    const upstream = fakeUpstream([{ match: /files/, body: { files: [] } }])
    await gdrive.callTool(ctx(upstream), 'list_files', { query: "name contains 'report'" })
    const params = new URL(upstream.calls[0]?.url ?? '').searchParams
    expect(params.get('fields')).toContain('files(id,name,mimeType')
    expect(params.get('q')).toBe("name contains 'report'")
  })

  it('lets a caller widen the selector without a code change', async () => {
    const upstream = fakeUpstream([{ match: /files/, body: { files: [] } }])
    await gdrive.callTool(ctx(upstream), 'list_files', { response_fields: 'files(id,trashed)' })
    // Declared as response_fields, sent as Drive's own fields parameter.
    const params = new URL(upstream.calls[0]?.url ?? '').searchParams
    expect(params.get('fields')).toBe('files(id,trashed)')
    expect(params.get('response_fields')).toBeNull()
  })
})
