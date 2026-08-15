import { manifestProvider, type ProviderManifest } from './manifest.ts'
import type { ProviderAdapter } from './registry.ts'

export const gmailManifest: ProviderManifest = {
  id: 'gmail',
  prefix: 'gmail',
  // One google OAuth application backs every google prefix, so the grant is
  // named for the vendor and not for this adapter.
  grantId: 'google',
  maturity: 'experimental',
  baseUrl: 'https://gmail.googleapis.com',
  scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  auth: { type: 'bearer' },
  // Google answers 401 when the credential is bad. A 403 is something else,
  // most often an API that was never enabled on the project, and telling
  // someone to reconnect a healthy grant sends them the wrong way.
  errors: { forbidden: 'upstream_error' },
  pagination: {
    style: 'cursor',
    size: 25,
    sizeParam: 'maxResults',
    param: 'pageToken',
    nextPath: 'nextPageToken',
    // No has_more field: Gmail omits nextPageToken on the last page.
  },
  tools: [
    {
      name: 'get_profile',
      description: 'Read the mailbox address and its total message and thread counts',
      write: false,
      request: 'GET /gmail/v1/users/me/profile',
      args: {},
      fields: ['emailAddress', 'messagesTotal', 'threadsTotal'],
    },
    {
      name: 'list_messages',
      description: 'List message ids matching a Gmail search query, newest first',
      write: false,
      request: 'GET /gmail/v1/users/me/messages',
      args: {
        query: {
          type: 'string',
          description: 'Gmail search syntax, for example "is:unread from:someone@example.com"',
          param: 'q',
        },
      },
      items: 'messages',
      fields: ['id', 'threadId'],
    },
    {
      name: 'get_message',
      description: 'Fetch one message by id, with its headers and a snippet',
      write: false,
      request: 'GET /gmail/v1/users/me/messages/{id}',
      args: {
        id: { type: 'string', required: true },
        format: {
          type: 'string',
          description: 'metadata keeps headers only, full includes the body',
          enum: ['metadata', 'full', 'minimal'],
          default: 'metadata',
        },
      },
      fields: ['id', 'threadId', 'snippet', 'internalDate', 'labelIds', 'payload.headers'],
    },
    {
      name: 'get_label',
      description: 'Read one label with its unread and total counts, for example UNREAD or INBOX',
      write: false,
      request: 'GET /gmail/v1/users/me/labels/{id}',
      args: { id: { type: 'string', description: 'Label id, uppercase for the built-ins', required: true } },
      fields: ['id', 'name', 'type', 'messagesTotal', 'messagesUnread', 'threadsUnread'],
    },
  ],
}

export function gmailProvider(): ProviderAdapter {
  return manifestProvider(gmailManifest)
}
