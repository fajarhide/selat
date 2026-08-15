import { manifestProvider, type ProviderManifest } from './manifest.ts'
import type { ProviderAdapter } from './registry.ts'

/**
 * Written ahead of activation, which is the plan for every social provider:
 * the adapter lands early and the vendor approval decides when it turns on.
 *
 * Meta's token dance is handled in the grant table rather than here: the code
 * exchange yields an hour-long token with no expires_in and no refresh_token,
 * traded through a second call for a sixty day one, and rolled through a third.
 * See the threads entry in adapters/oauth/catalog.ts.
 *
 * What is still unproven is everything, in the sense that matters: no request
 * in this file or that flow has reached Meta. Both are covered by tests
 * against fixtures written from the documentation, which catches a wrong
 * shape and cannot catch a wrong document. Treat the first real connection as
 * the test, and expect the token dance to be where it goes wrong.
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
