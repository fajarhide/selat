import { GatewayError } from '../../domain/errors.ts'
import type { ProviderOAuthConfig } from './client.ts'

/**
 * OAuth endpoints live on the grant, not the provider, because one grant serves
 * many prefixes: a single `google` grant backs gdrive, gdocs and gsheets.
 */
// Derived rather than restated, so a new vendor knob is added in one place.
// The credentials are the half that comes from the environment.
export type GrantEndpoints = Omit<ProviderOAuthConfig, 'clientId' | 'clientSecret'>

export const GRANT_ENDPOINTS: Record<string, GrantEndpoints> = {
  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
  },
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    // Google issues a refresh token only on a consent that explicitly asks to
    // stay offline, and only re-issues one when consent is forced. Without
    // both, the grant dies an hour after it is made and cannot be refreshed.
    // include_granted_scopes keeps whatever this user already approved on the
    // same application, so adding a second google prefix widens the grant
    // instead of replacing it even if the union we compute misses something.
    authorizeParams: {
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    },
  },
  atlassian: {
    authorizeUrl: 'https://auth.atlassian.com/authorize',
    tokenUrl: 'https://auth.atlassian.com/oauth/token',
  },
  notion: {
    authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenUrl: 'https://api.notion.com/v1/oauth/token',
    authorizeParams: { owner: 'user' },
  },
  slack: {
    authorizeUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
  },
  // Register the application as a public client. X demands HTTP Basic on the
  // token endpoint from a confidential one, which this client does not send.
  twitter: {
    authorizeUrl: 'https://x.com/i/oauth2/authorize',
    tokenUrl: 'https://api.x.com/2/oauth2/token',
    // A confidential app must present Basic here. A public one has no secret
    // and falls back to the body form on its own.
    tokenAuth: 'basic',
  },
  // Unversioned on purpose, the same reason the manifest is: Meta applies the
  // app's own default version, and a version pinned from memory would fail
  // every call once it is retired.
  facebook: {
    authorizeUrl: 'https://www.facebook.com/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/oauth/access_token',
    scopeSeparator: ',',
    // The code exchange yields a short lived token. Traded here for a sixty day
    // one, which is the only form worth storing.
    longLived: {
      url: 'https://graph.facebook.com/oauth/access_token',
      tokenParam: 'fb_exchange_token',
      params: { grant_type: 'fb_exchange_token' },
      withClientSecret: true,
    },
    // No longLivedRefresh on purpose. Facebook has no th_refresh_token
    // equivalent for a user token, so a grant dies at sixty days and
    // reconnecting is the only path.
  },
  // The authorize host is threads.net while the token host is graph.threads.net,
  // which is Meta's split and not a typo.
  threads: {
    authorizeUrl: 'https://threads.net/oauth/authorize',
    tokenUrl: 'https://graph.threads.net/oauth/access_token',
    scopeSeparator: ',',
    // The code exchange yields an hour-long token carrying no expires_in and
    // no refresh_token. Traded here for a sixty day one, which is the only
    // form worth storing.
    longLived: {
      url: 'https://graph.threads.net/access_token',
      tokenParam: 'access_token',
      params: { grant_type: 'th_exchange_token' },
      withClientSecret: true,
    },
    // Meta refuses the secret on this one, and refuses the call at all until
    // the token is 24 hours old, which the refresh-before-expiry timing in
    // grants.ts already satisfies for a sixty day token.
    longLivedRefresh: {
      url: 'https://graph.threads.net/refresh_access_token',
      tokenParam: 'access_token',
      params: { grant_type: 'th_refresh_token' },
    },
  },
}

export type OauthConfigResolver = (grantId: string) => ProviderOAuthConfig

/**
 * Client credentials come from the environment. A self-host must bring its own
 * OAuth applications; the hosted applications are the cloud's convenience layer
 * and are deliberately not shipped here.
 */
export function envOauthConfig(env: NodeJS.ProcessEnv = process.env): OauthConfigResolver {
  return (grantId) => {
    const endpoints = GRANT_ENDPOINTS[grantId]
    const clientId = env[`${grantId.toUpperCase()}_CLIENT_ID`]
    if (!endpoints || !clientId) {
      throw new GatewayError(
        'provider_not_connected',
        `no OAuth application configured for ${grantId}, set ${grantId.toUpperCase()}_CLIENT_ID`,
        { provider: grantId },
      )
    }
    const clientSecret = env[`${grantId.toUpperCase()}_CLIENT_SECRET`]
    return {
      ...endpoints,
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
    }
  }
}
