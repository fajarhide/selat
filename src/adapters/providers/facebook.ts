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
 * Proven against Meta on 2026-08-17: a real connection completes and get_me
 * returns a real profile.
 *
 * It carries one tool because Meta refuses the rest. list_my_posts on /me/posts
 * and list_liked_pages on /me/likes were written from the documentation, passed
 * their fixtures, and are refused by the live API with error_subcode 2069030,
 * "New Pages Experience Is Not Supported", on a connection where get_me works.
 * See #28. Do not add them back without a live call proving otherwise.
 */

export const facebookManifest: ProviderManifest = {
  id: 'facebook',
  prefix: 'facebook',
  maturity: 'beta',
  baseUrl: 'https://graph.facebook.com',
  scopes: ['public_profile', 'user_link'],
  auth: { type: 'bearer' },
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
  ],
}

export function facebookProvider(): ProviderAdapter {
  return manifestProvider(facebookManifest)
}
