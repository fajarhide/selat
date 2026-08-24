import { manifestProvider, type ProviderManifest } from './manifest.ts'
import type { ProviderAdapter } from './registry.ts'

export const gmailManifest: ProviderManifest = {
  id: 'gmail',
  prefix: 'gmail',
  // One google OAuth application backs every google prefix, so the grant is
  // named for the vendor and not for this adapter.
  grantId: 'google',
  maturity: 'beta',
  baseUrl: 'https://gmail.googleapis.com',
  // gmail.modify covers messages.send, modify and trash, so one scope carries
  // every write here rather than gmail.send sitting beside gmail.modify. It is
  // the same restricted tier gmail.readonly already sat in, so the verification
  // Google will ask for does not change.
  scopes: ['https://www.googleapis.com/auth/gmail.modify'],
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
    {
      name: 'send_message',
      description:
        'Send an email. The whole RFC 2822 message goes in raw, headers included, base64 encoded',
      write: true,
      request: 'POST /gmail/v1/users/me/messages/send',
      args: {
        raw: {
          type: 'base64url',
          required: true,
          description:
            'The complete message, To and Subject headers included, then a blank line, then the body',
        },
      },
      fields: ['id', 'threadId', 'labelIds'],
    },
    {
      name: 'modify_message',
      description:
        'Add or remove labels on one message, which is how a message is marked read or archived',
      write: true,
      request: 'POST /gmail/v1/users/me/messages/{id}/modify',
      args: {
        id: { type: 'string', required: true },
        // Removing UNREAD marks it read and removing INBOX archives it, which
        // is why this is one tool rather than four named after the outcomes.
        add_label_ids: { type: 'string[]', param: 'addLabelIds' },
        remove_label_ids: { type: 'string[]', param: 'removeLabelIds' },
      },
      fields: ['id', 'threadId', 'labelIds'],
    },
    {
      name: 'trash_message',
      description: 'Move one message to the trash, where it can still be recovered',
      write: true,
      request: 'POST /gmail/v1/users/me/messages/{id}/trash',
      args: { id: { type: 'string', required: true } },
      fields: ['id', 'threadId', 'labelIds'],
    },
  ],
}

export function gmailProvider(): ProviderAdapter {
  return manifestProvider(gmailManifest)
}
