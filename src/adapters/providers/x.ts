import { manifestProvider, type ProviderManifest } from './manifest.ts'
import type { ProviderAdapter } from './registry.ts'

/**
 * The prefix is `x` because that is what the tools are called, and the grant is
 * `twitter` because that is what the environment variable and the callback url
 * have to be, and X_CLIENT_ID is too generic a name to put in someone's
 * environment.
 *
 * Driven against a real X application on 2026-08-15: consent, PKCE, the Basic
 * token exchange, the stored grant and get_me all work, and get_me returns the
 * live account. The other four tools answer 402, because X gates search and
 * timeline reads behind a paid tier. They are unproven for that reason and not
 * for any doubt about the manifest.
 *
 * A confidential application works. X requires HTTP Basic at the token
 * endpoint from one, which the grant table declares. A public client has no
 * secret and falls back to the body form on its own, so either registration
 * connects.
 *
 * Older note, kept because it is the trap: X requires HTTP Basic on
 * the token endpoint for confidential clients, which this OAuth client does not
 * send: it posts the client id in the form body, which is exactly what a public
 * client with PKCE expects. A confidential client fails at the code exchange.
 */

// X returns an id and text and nothing else unless the request names its
// fields, the same shape Drive, Threads and Meta all have.
const TWEET_FIELDS = 'created_at,public_metrics,author_id,conversation_id,lang,referenced_tweets'
const USER_FIELDS = 'description,public_metrics,verified,created_at,location'

// X wraps a single object in { data: ... }, so the projections below keep that
// path rather than flattening it. Projection preserves the upstream shape by
// contract, and an agent that saw the raw response sees the same paths here.

export const xManifest: ProviderManifest = {
  id: 'twitter',
  prefix: 'x',
  grantId: 'twitter',
  maturity: 'beta',
  baseUrl: 'https://api.x.com',
  // offline.access is what makes the grant refreshable. Without it the
  // connection dies in two hours and cannot be rolled.
  scopes: ['tweet.read', 'users.read', 'offline.access'],
  auth: { type: 'bearer' },
  // X answers 401 for a bad token and keeps 403 for an access level the app is
  // not enrolled in, which no reconnect fixes.
  errors: {
    forbidden: 'upstream_error',
    retryAfter: [{ header: 'x-rate-limit-reset', as: 'epoch' }],
  },
  pagination: {
    style: 'cursor',
    size: 25,
    sizeParam: 'max_results',
    param: 'pagination_token',
    nextPath: 'meta.next_token',
  },
  tools: [
    {
      name: 'get_me',
      description: 'Read the X account behind this connection, with its follower counts',
      write: false,
      request: 'GET /2/users/me',
      args: {
        user_fields: {
          type: 'string',
          description: 'X user.fields selector',
          default: USER_FIELDS,
          param: 'user.fields',
        },
      },
      fields: ['data.id', 'data.name', 'data.username', 'data.description', 'data.public_metrics'],
    },
    {
      name: 'get_user',
      description: 'Look one account up by its handle, without the leading at sign',
      write: false,
      request: 'GET /2/users/by/username/{username}',
      args: {
        username: { type: 'string', required: true },
        user_fields: {
          type: 'string',
          description: 'X user.fields selector',
          default: USER_FIELDS,
          param: 'user.fields',
        },
      },
      fields: ['data.id', 'data.name', 'data.username', 'data.description', 'data.public_metrics'],
    },
    {
      name: 'list_user_posts',
      description: 'List recent posts by one account id, newest first',
      write: false,
      request: 'GET /2/users/{user_id}/tweets',
      args: {
        user_id: { type: 'string', description: 'Numeric id, not the handle', required: true },
        tweet_fields: {
          type: 'string',
          description: 'X tweet.fields selector',
          default: TWEET_FIELDS,
          param: 'tweet.fields',
        },
      },
      items: 'data',
      fields: ['id', 'text', 'created_at', 'public_metrics', 'lang'],
    },
    {
      name: 'search_recent_posts',
      description: 'Search posts from the last seven days using X search syntax',
      write: false,
      request: 'GET /2/tweets/search/recent',
      args: {
        query: {
          type: 'string',
          description: 'X search syntax, for example "mcp -is:retweet lang:en"',
          required: true,
        },
        tweet_fields: {
          type: 'string',
          description: 'X tweet.fields selector',
          default: TWEET_FIELDS,
          param: 'tweet.fields',
        },
      },
      items: 'data',
      fields: ['id', 'text', 'author_id', 'created_at', 'public_metrics', 'lang'],
    },
    {
      name: 'get_post',
      description: 'Fetch one post by id, with its metrics and language',
      write: false,
      request: 'GET /2/tweets/{tweet_id}',
      args: {
        tweet_id: { type: 'string', required: true },
        tweet_fields: {
          type: 'string',
          description: 'X tweet.fields selector',
          default: TWEET_FIELDS,
          param: 'tweet.fields',
        },
      },
      fields: ['data.id', 'data.text', 'data.author_id', 'data.created_at', 'data.public_metrics'],
    },
  ],
}

export function xProvider(): ProviderAdapter {
  return manifestProvider(xManifest)
}
