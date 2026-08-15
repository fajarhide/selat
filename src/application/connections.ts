import { randomBytes } from 'node:crypto'
import { GatewayError } from '../domain/errors.ts'
import {
  buildAuthorizeUrl,
  createPkce,
  exchangeCode,
  type TokenSet,
} from '../adapters/oauth/client.ts'
import type { OauthConfigResolver } from '../adapters/oauth/catalog.ts'
import type { StateStore } from '../adapters/db/state-store.ts'
import type { GrantStore } from './grants.ts'
import type { Registry } from '../adapters/providers/registry.ts'
import type { EnablementStore } from '../ports/stores.ts'

export type ConnectionDeps = {
  registry: Registry
  publicUrl: string
  /** Where the portal lives. Unset on a self-host, which has no portal. */
  dashboardUrl?: string
  oauthConfig: OauthConfigResolver
  states: StateStore
  grants: GrantStore
  enablement: EnablementStore
  exchange?: typeof exchangeCode
}

/**
 * Keyed on the grant, not the prefix. A vendor requires every redirect uri to
 * be registered exactly, so keying on the prefix would make one google
 * application need a separate registration for gmail, gcal and gdrive, and a
 * fourth prefix would be a console change before it could connect at all. The
 * callback recovers the prefix from the single-use state, so the path segment
 * carries no decision.
 */
export function redirectUriFor(publicUrl: string, grantId: string): string {
  return `${publicUrl}/v1/connections/${grantId}/callback`
}

export async function beginConnection(
  deps: ConnectionDeps,
  input: { workspaceId: string; prefix: string; returnTo?: string },
): Promise<{ url: string; state: string }> {
  const adapter = deps.registry.get(input.prefix)
  const cfg = deps.oauthConfig(adapter.grantId)
  const { verifier, challenge } = createPkce()
  const state = randomBytes(24).toString('base64url')
  const enabled = await deps.enablement.enabledPrefixes(input.workspaceId)

  await deps.states.put({
    state,
    workspaceId: input.workspaceId,
    prefix: input.prefix,
    verifier,
    returnTo: input.returnTo ?? null,
  })

  return {
    state,
    url: buildAuthorizeUrl(cfg, {
      redirectUri: redirectUriFor(deps.publicUrl, adapter.grantId),
      state,
      challenge,
      scopes: scopesForGrant(deps.registry, adapter, enabled),
    }),
  }
}

/**
 * One grant can back several prefixes, and the callback overwrites it whole.
 * Asking only for the scopes of the prefix being connected therefore narrows
 * the token every sibling reads, and the siblings start failing with a vendor
 * 403 that no reconnect of their own would fix. So the request carries the
 * union: this prefix, plus every already-connected prefix on the same grant.
 */
function scopesForGrant(
  registry: Registry,
  connecting: { prefix: string; grantId: string; scopes: string[] },
  enabledPrefixes: string[],
): string[] {
  const wanted = new Set(connecting.scopes)
  for (const adapter of registry.all()) {
    if (adapter.grantId !== connecting.grantId) continue
    if (adapter.prefix === connecting.prefix) continue
    if (!enabledPrefixes.includes(adapter.prefix)) continue
    for (const scope of adapter.scopes) wanted.add(scope)
  }
  return [...wanted].sort()
}

export async function completeConnection(
  deps: ConnectionDeps,
  input: { state: string; code: string },
): Promise<{ prefix: string; workspaceId: string; returnTo: string | null }> {
  const found = await deps.states.consume(input.state)
  if (!found) throw new GatewayError('invalid_arguments', 'unknown or expired oauth state')

  const adapter = deps.registry.get(found.prefix)
  const exchange = deps.exchange ?? exchangeCode
  const tokens: TokenSet = await exchange(deps.oauthConfig(adapter.grantId), {
    code: input.code,
    verifier: found.verifier,
    redirectUri: redirectUriFor(deps.publicUrl, adapter.grantId),
  })

  await deps.grants.save(found.workspaceId, adapter.grantId, tokens)
  await deps.enablement.enable(found.workspaceId, found.prefix)
  return { prefix: found.prefix, workspaceId: found.workspaceId, returnTo: found.returnTo }
}

export async function disconnect(
  deps: ConnectionDeps,
  input: { workspaceId: string; prefix: string },
): Promise<void> {
  const adapter = deps.registry.get(input.prefix)
  await deps.enablement.disable(input.workspaceId, input.prefix)

  // One grant can back several prefixes, so the tokens only go when the last
  // provider using them is gone. Dropping earlier would break a sibling.
  const stillEnabled = await deps.enablement.enabledPrefixes(input.workspaceId)
  const sharesGrant = stillEnabled.some(
    (prefix) => safeGrantId(deps.registry, prefix) === adapter.grantId,
  )
  if (!sharesGrant) await deps.grants.drop(input.workspaceId, adapter.grantId)
}

function safeGrantId(registry: Registry, prefix: string): string | null {
  try {
    return registry.get(prefix).grantId
  } catch {
    // A prefix left over from a provider that is no longer registered must not
    // strand a grant, so it simply does not vote.
    return null
  }
}
