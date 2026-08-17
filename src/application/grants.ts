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
  /** Holds every refresher of one grant to a single turn, across processes. */
  withRefreshLock<T>(workspaceId: string, grantId: string, fn: () => Promise<T>): Promise<T>
}

export type GrantDeps = {
  grants: GrantStore
  oauthConfig(grantId: string): ProviderOAuthConfig
  refresh(cfg: ProviderOAuthConfig, refreshToken: string): Promise<TokenSet>
  /** Deep link the agent can hand to a human when a grant dies. */
  reauthUrl?(grantId: string): string
}

const isFresh = (grant: StoredGrant): boolean =>
  !grant.expiresAt || grant.expiresAt.getTime() - Date.now() > SKEW_MS

export function createGrantResolver(deps: GrantDeps) {
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

      if (isFresh(grant)) return grant.accessToken

      if (!grant.refreshToken) {
        await deps.grants.markReauth(workspaceId, grantId)
        throw reauth(grantId, `${grantId} expired and has no refresh token`)
      }

      // Providers that rotate refresh tokens revoke the whole grant if two
      // refreshes race, and the racer is as likely to be another replica as
      // another request, so the lock has to outlive this process.
      return deps.grants.withRefreshLock(workspaceId, grantId, async () => {
        // Re-read inside the lock. Whoever held it before may already have
        // done the work, and spending the rotated token again is the revoke.
        const current = (await deps.grants.load(workspaceId, grantId)) ?? grant
        if (current.reauthNeeded) throw reauth(grantId, `${grantId} needs to be reconnected`)
        if (isFresh(current)) return current.accessToken

        const refreshToken = current.refreshToken
        if (!refreshToken) {
          await deps.grants.markReauth(workspaceId, grantId)
          throw reauth(grantId, `${grantId} expired and has no refresh token`)
        }

        try {
          const tokens = await deps.refresh(deps.oauthConfig(grantId), refreshToken)
          await deps.grants.save(workspaceId, grantId, tokens)
          return tokens.accessToken
        } catch {
          await deps.grants.markReauth(workspaceId, grantId)
          throw reauth(grantId, `${grantId} refresh was rejected`)
        }
      })
    },
  }
}
