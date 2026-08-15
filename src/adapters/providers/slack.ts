import { manifestProvider, type ProviderManifest } from './manifest.ts'
import type { ProviderAdapter } from './registry.ts'

/**
 * No request in this file has reached Slack. It was written from the
 * documentation to prove the body-failure error rule, and its tests run
 * against fixtures, which catch a wrong shape and cannot catch a wrong
 * document. github, gmail, gcal and gdrive have been driven against the real
 * vendor; this one has not, and the difference is worth knowing before
 * enabling it.
 */
export const slackManifest: ProviderManifest = {
  id: 'slack',
  prefix: 'slack',
  maturity: 'experimental',
  baseUrl: 'https://slack.com/api',
  scopes: ['channels:read', 'chat:write', 'users:read'],
  auth: { type: 'bearer' },
  pagination: {
    style: 'cursor',
    size: 100,
    sizeParam: 'limit',
    param: 'cursor',
    nextPath: 'response_metadata.next_cursor',
    // No has_more field: next_cursor is "" on the last page.
  },
  errors: {
    // Slack answers HTTP 200 with {ok: false} and puts the real outcome in the
    // body, so the status carries no signal at all.
    bodyFailure: {
      path: 'ok',
      equals: false,
      codeFrom: 'error',
      codes: {
        ratelimited: 'rate_limited',
        invalid_auth: 'reauth_required',
        not_authed: 'reauth_required',
        token_revoked: 'reauth_required',
        account_inactive: 'reauth_required',
        missing_scope: 'credential_scope_denied',
      },
    },
    retryAfter: [{ header: 'retry-after', as: 'seconds' }],
  },
  tools: [
    {
      name: 'list_channels',
      description: 'List the channels the connected token can see',
      write: false,
      request: 'GET /conversations.list',
      args: {
        types: {
          type: 'string',
          description: 'Comma separated: public_channel, private_channel',
          default: 'public_channel',
        },
      },
      items: 'channels',
      fields: ['id', 'name', 'is_private', 'num_members', 'topic.value'],
    },
    {
      name: 'post_message',
      description: 'Post a message to one channel as the connected app',
      write: true,
      request: 'POST /chat.postMessage',
      args: {
        channel: { type: 'string', description: 'Channel id, not its name', required: true },
        text: { type: 'string', required: true },
        thread_ts: { type: 'string', description: 'Reply inside this thread' },
      },
      fields: ['ts', 'channel'],
    },
    {
      name: 'list_users',
      description: 'List the members of the connected workspace',
      write: false,
      request: 'GET /users.list',
      args: {},
      items: 'members',
      fields: ['id', 'name', 'real_name', 'is_bot'],
    },
  ],
}

export function slackProvider(): ProviderAdapter {
  return manifestProvider(slackManifest)
}
