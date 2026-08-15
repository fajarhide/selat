import { manifestProvider, type ProviderManifest } from './manifest.ts'
import type { ProviderAdapter } from './registry.ts'

/**
 * Written ahead of activation, which is the plan for every social provider:
 * the adapter lands early and the vendor approval decides when it turns on.
 * Nothing here has been run against the real API, because that needs a Meta
 * app this repository does not have.
 *
 * Two things in Meta's OAuth are not handled yet, and both bite after the
 * connect flow appears to succeed rather than during it:
 *
 * 1. The code exchange returns a token that lives about an hour, and carries
 *    no expires_in and no refresh_token. A grant with no expiry reads as fresh
 *    forever here, so the gateway keeps presenting a dead token and the caller
 *    sees reauth_required from then on. The fix is Meta's own second step,
 *    GET /access_token?grant_type=th_exchange_token, which trades the short
 *    token for a sixty day one, plus GET /refresh_access_token to roll it.
 * 2. Both of those are GET requests with the token in the query string, which
 *    the OAuth client cannot express: it posts a form body.
 *
 * So this provider lists and calls correctly, and cannot yet hold a connection
 * for longer than an hour. Do not enable it for anyone until that is built and
 * verified against a real app.
 */

// Meta returns id and nothing else unless the request names the fields it
// wants, the same shape Drive has. Declared as an argument with a default,
// which is how a manifest sends a fixed query parameter today.
const POST_FIELDS =
  'id,media_product_type,media_type,text,permalink,timestamp,username,is_quote_post,shortcode'

export const threadsManifest: ProviderManifest = {
  id: 'threads',
  prefix: 'threads',
  maturity: 'experimental',
  baseUrl: 'https://graph.threads.net',
  scopes: ['threads_basic', 'threads_read_replies'],
  auth: { type: 'bearer' },
  pagination: {
    style: 'cursor',
    size: 25,
    sizeParam: 'limit',
    param: 'after',
    nextPath: 'paging.cursors.after',
    // Meta leaves a cursor behind on the last page, so the cursor alone would
    // page forever. paging.next is present only while more exists.
    hasMorePath: 'paging.next',
  },
  tools: [
    {
      name: 'get_profile',
      description: 'Read the Threads account behind this connection',
      write: false,
      request: 'GET /v1.0/me',
      args: {
        response_fields: {
          type: 'string',
          description: 'Meta fields selector',
          default: 'id,username,name,threads_profile_picture_url,threads_biography',
          param: 'fields',
        },
      },
      fields: ['id', 'username', 'name', 'threads_biography', 'threads_profile_picture_url'],
    },
    {
      name: 'list_posts',
      description: 'List the posts this account published, newest first',
      write: false,
      request: 'GET /v1.0/me/threads',
      args: {
        since: { type: 'string', description: 'ISO date lower bound, for example 2026-08-01' },
        until: { type: 'string', description: 'ISO date upper bound' },
        response_fields: {
          type: 'string',
          description: 'Meta fields selector',
          default: POST_FIELDS,
          param: 'fields',
        },
      },
      items: 'data',
      fields: ['id', 'text', 'media_type', 'permalink', 'timestamp', 'is_quote_post'],
    },
    {
      name: 'get_post',
      description: 'Fetch one post by id, with its text and permalink',
      write: false,
      request: 'GET /v1.0/{post_id}',
      args: {
        post_id: { type: 'string', required: true },
        response_fields: {
          type: 'string',
          description: 'Meta fields selector',
          default: POST_FIELDS,
          param: 'fields',
        },
      },
      fields: ['id', 'text', 'media_type', 'permalink', 'timestamp', 'username', 'is_quote_post'],
    },
    {
      name: 'list_replies',
      description: 'List the direct replies to one post, for reading a conversation',
      write: false,
      request: 'GET /v1.0/{post_id}/replies',
      args: {
        post_id: { type: 'string', required: true },
        response_fields: {
          type: 'string',
          description: 'Meta fields selector',
          default: `${POST_FIELDS},hide_status`,
          param: 'fields',
        },
      },
      items: 'data',
      fields: ['id', 'text', 'username', 'permalink', 'timestamp', 'hide_status'],
    },
  ],
}

export function threadsProvider(): ProviderAdapter {
  return manifestProvider(threadsManifest)
}
