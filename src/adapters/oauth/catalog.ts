import { GatewayError } from '../../domain/errors.ts'
import type { ProviderOAuthConfig } from './client.ts'

/**
 * OAuth endpoints live on the grant, not the provider, because one grant serves
 * many prefixes: a single `google` grant backs gdrive, gdocs and gsheets.
 */
export const GRANT_ENDPOINTS: Record<string, { authorizeUrl: string; tokenUrl: string }> = {
  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
  },
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
  },
  atlassian: {
    authorizeUrl: 'https://auth.atlassian.com/authorize',
    tokenUrl: 'https://auth.atlassian.com/oauth/token',
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
