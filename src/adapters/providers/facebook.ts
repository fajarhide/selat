import { manifestProvider, type ProviderManifest } from './manifest.ts'
import type { ProviderAdapter } from './registry.ts'

/**
 * The personal half of Meta. Every tool here reads through `/me`, so the one
 * user token a grant already stores is the only credential involved. Pages and
 * Instagram live in a separate use case in Meta's console, and each Page there
 * carries its own token, which the executor cannot swap per call. That is why
 * they are absent rather than forgotten.
 *
 * Paths carry no version, so Meta applies the app's own default. Pinning one
 * here would name a version from memory, and Graph versions are retired on a
 * schedule, so the wrong guess would fail every call for a reason nothing in
 * the error explains. Pin it once the console shows which version the app is on.
 *
 * Unproven against the vendor: the fixtures below are written from the
 * documentation, which catches a wrong shape and cannot catch a wrong document.
 */

const POST_FIELDS = 'id,message,story,permalink_url,created_time,status_type'

export const facebookManifest: ProviderManifest = {
  id: 'facebook',
  prefix: 'facebook',
  maturity: 'experimental',
  baseUrl: 'https://graph.facebook.com',
  scopes: ['public_profile', 'user_link', 'user_posts', 'user_likes'],
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
      name: 'get_me',
      description: 'Read the Facebook account behind this connection',
      write: false,
      request: 'GET /me',
      args: {
        response_fields: {
          type: 'string',
          description: 'Meta fields selector',
          default: 'id,name,link',
          param: 'fields',
        },
      },
      fields: ['id', 'name', 'link'],
    },
    {
      name: 'list_my_posts',
      description: 'List the posts this account published, newest first',
      write: false,
      request: 'GET /me/posts',
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
      fields: ['id', 'message', 'story', 'permalink_url', 'created_time', 'status_type'],
    },
    {
      name: 'list_liked_pages',
      description: 'List the Pages this account has liked',
      write: false,
      request: 'GET /me/likes',
      args: {
        response_fields: {
          type: 'string',
          description: 'Meta fields selector',
          default: 'id,name,link,category',
          param: 'fields',
        },
      },
      items: 'data',
      fields: ['id', 'name', 'link', 'category'],
    },
  ],
}

export function facebookProvider(): ProviderAdapter {
  return manifestProvider(facebookManifest)
}
