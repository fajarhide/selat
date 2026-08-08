import { GatewayError } from '../domain/errors.ts'
import type { ProviderOAuthConfig, TokenSet } from '../adapters/oauth/client.ts'

// Refresh a minute before expiry, so a call in flight does not race the clock.
const SKEW_MS = 60_000

export type StoredGrant = {
  accessToken: string
  refreshToken: string | null
  expiresAt: Date | null
  reauthNeeded: boolean
}

export interface GrantStore {
  load(workspaceId: string, grantId: string): Promise<StoredGrant | null>
  save(workspaceId: string, grantId: string, tokens: TokenSet): Promise<void>
  markReauth(workspaceId: string, grantId: string): Promise<void>
  drop(workspaceId: string, grantId: string): Promise<void>
}

export type GrantDeps = {
  grants: GrantStore
  oauthConfig(grantId: string): ProviderOAuthConfig
  refresh(cfg: ProviderOAuthConfig, refreshToken: string): Promise<TokenSet>
  /** Deep link the agent can hand to a human when a grant dies. */
  reauthUrl?(grantId: string): string
}

export function createGrantResolver(deps: GrantDeps) {
  // Providers that rotate refresh tokens revoke the whole grant if two
  // refreshes race, so refreshes are single-flighted per workspace and grant.
  const inflight = new Map<string, Promise<string>>()

  const reauth = (grantId: string, message: string) =>
    new GatewayError('reauth_required', message, {
      provider: grantId,
      ...(deps.reauthUrl ? { reauthUrl: deps.reauthUrl(grantId) } : {}),
    })

  return {
    async accessTokenFor(workspaceId: string, grantId: string): Promise<string | null> {
      const grant = await deps.grants.load(workspaceId, grantId)
      if (!grant) return null
      if (grant.reauthNeeded) throw reauth(grantId, `${grantId} needs to be reconnected`)

      const stillFresh = !grant.expiresAt || grant.expiresAt.getTime() - Date.now() > SKEW_MS
      if (stillFresh) return grant.accessToken

      const refreshToken = grant.refreshToken
      if (!refreshToken) {
        await deps.grants.markReauth(workspaceId, grantId)
        throw reauth(grantId, `${grantId} expired and has no refresh token`)
      }

      const key = `${workspaceId}:${grantId}`
      const existing = inflight.get(key)
      if (existing) return existing

      const promise = (async () => {
        try {
          const tokens = await deps.refresh(deps.oauthConfig(grantId), refreshToken)
          await deps.grants.save(workspaceId, grantId, tokens)
          return tokens.accessToken
        } catch {
          await deps.grants.markReauth(workspaceId, grantId)
          throw reauth(grantId, `${grantId} refresh was rejected`)
        } finally {
          inflight.delete(key)
        }
      })()
      inflight.set(key, promise)
      return promise
    },
  }
}
