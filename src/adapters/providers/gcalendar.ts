import { manifestProvider, type ProviderManifest } from './manifest.ts'
import type { ProviderAdapter } from './registry.ts'

export const gcalendarManifest: ProviderManifest = {
  id: 'gcalendar',
  prefix: 'gcal',
  // Rides the same google application as gmail. Connecting this one asks for
  // the union of both scope sets, so neither narrows the other's grant.
  grantId: 'google',
  maturity: 'beta',
  baseUrl: 'https://www.googleapis.com',
  // calendar.readonly stays: calendar.events does not grant calendarList.list,
  // which is the only thing list_calendars calls, so dropping it would break a
  // tool that works today.
  scopes: [
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/calendar.events',
  ],
  auth: { type: 'bearer' },
  // Google answers 401 for a bad credential and keeps 403 for a disabled API
  // or a missing scope, neither of which reconnecting fixes.
  errors: { forbidden: 'upstream_error' },
  pagination: {
    style: 'cursor',
    size: 25,
    sizeParam: 'maxResults',
    param: 'pageToken',
    nextPath: 'nextPageToken',
  },
  tools: [
    {
      name: 'list_calendars',
      description: 'List the calendars on this account, with the access level held on each',
      write: false,
      request: 'GET /calendar/v3/users/me/calendarList',
      args: {},
      items: 'items',
      fields: ['id', 'summary', 'description', 'primary', 'accessRole', 'timeZone'],
    },
    {
      name: 'list_events',
      description: 'List events on one calendar within a time window, soonest first',
      write: false,
      request: 'GET /calendar/v3/calendars/{calendar_id}/events',
      args: {
        // Required so the path can always be filled, defaulted so an agent that
        // just wants "my calendar" does not have to look an id up first.
        calendar_id: { type: 'string', required: true, default: 'primary' },
        time_min: {
          type: 'string',
          description: 'RFC3339 lower bound, for example 2026-08-15T00:00:00Z',
          param: 'timeMin',
        },
        time_max: { type: 'string', description: 'RFC3339 upper bound', param: 'timeMax' },
        query: { type: 'string', description: 'Free text match against the event', param: 'q' },
        // Recurring events arrive as one master entry unless they are expanded,
        // which is almost never what a question about a day wants.
        single_events: { type: 'boolean', default: true, param: 'singleEvents' },
        order_by: { type: 'string', enum: ['startTime', 'updated'], default: 'startTime', param: 'orderBy' },
      },
      items: 'items',
      fields: [
        'id',
        'summary',
        'status',
        'start',
        'end',
        'location',
        'htmlLink',
        'organizer.email',
        'attendees',
      ],
    },
    {
      name: 'get_event',
      description: 'Fetch one event by id, with its attendees and conferencing details',
      write: false,
      request: 'GET /calendar/v3/calendars/{calendar_id}/events/{event_id}',
      args: {
        calendar_id: { type: 'string', required: true, default: 'primary' },
        event_id: { type: 'string', required: true },
      },
      fields: [
        'id',
        'summary',
        'description',
        'status',
        'start',
        'end',
        'location',
        'htmlLink',
        'organizer.email',
        'attendees',
        'conferenceData.entryPoints',
      ],
    },
    {
      name: 'create_event',
      description: 'Put an event on a calendar. Start and end are required',
      write: true,
      request: 'POST /calendar/v3/calendars/{calendar_id}/events',
      args: {
        calendar_id: { type: 'string', required: true, default: 'primary' },
        summary: { type: 'string', description: 'The title shown on the calendar' },
        description: { type: 'string' },
        location: { type: 'string' },
        // Carrying the offset rather than a separate timeZone argument: one
        // argument cannot fill both start.timeZone and end.timeZone, and an
        // RFC3339 stamp with an offset needs neither.
        start_time: {
          type: 'string',
          required: true,
          description: 'RFC3339 with an offset, for example 2026-08-25T14:00:00+07:00',
          param: 'start.dateTime',
        },
        end_time: {
          type: 'string',
          required: true,
          description: 'RFC3339 with an offset',
          param: 'end.dateTime',
        },
      },
      fields: ['id', 'summary', 'status', 'start', 'end', 'location', 'htmlLink'],
    },
    {
      name: 'update_event',
      description: 'Change one event. Anything left out keeps its current value',
      write: true,
      request: 'PATCH /calendar/v3/calendars/{calendar_id}/events/{event_id}',
      args: {
        calendar_id: { type: 'string', required: true, default: 'primary' },
        event_id: { type: 'string', required: true },
        summary: { type: 'string' },
        description: { type: 'string' },
        location: { type: 'string' },
        start_time: { type: 'string', description: 'RFC3339 with an offset', param: 'start.dateTime' },
        end_time: { type: 'string', description: 'RFC3339 with an offset', param: 'end.dateTime' },
      },
      fields: ['id', 'summary', 'status', 'start', 'end', 'location', 'htmlLink'],
    },
    {
      name: 'delete_event',
      description: 'Remove an event from a calendar for good',
      write: true,
      request: 'DELETE /calendar/v3/calendars/{calendar_id}/events/{event_id}',
      // No fields: Calendar answers a delete with an empty body.
      args: {
        calendar_id: { type: 'string', required: true, default: 'primary' },
        event_id: { type: 'string', required: true },
      },
    },
  ],
}

export function gcalendarProvider(): ProviderAdapter {
  return manifestProvider(gcalendarManifest)
}
