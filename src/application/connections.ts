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
  oauthConfig: OauthConfigResolver
  states: StateStore
  grants: GrantStore
  enablement: EnablementStore
  exchange?: typeof exchangeCode
}

export function redirectUriFor(publicUrl: string, prefix: string): string {
  return `${publicUrl}/v1/connections/${prefix}/callback`
}

export async function beginConnection(
  deps: ConnectionDeps,
  input: { workspaceId: string; prefix: string },
): Promise<{ url: string; state: string }> {
  const adapter = deps.registry.get(input.prefix)
  const cfg = deps.oauthConfig(adapter.grantId)
  const { verifier, challenge } = createPkce()
  const state = randomBytes(24).toString('base64url')

  await deps.states.put({
    state,
    workspaceId: input.workspaceId,
    prefix: input.prefix,
    verifier,
  })

  return {
    state,
    url: buildAuthorizeUrl(cfg, {
      redirectUri: redirectUriFor(deps.publicUrl, input.prefix),
      state,
      challenge,
      scopes: adapter.scopes,
    }),
  }
}

export async function completeConnection(
  deps: ConnectionDeps,
  input: { state: string; code: string },
): Promise<{ prefix: string; workspaceId: string }> {
  const found = await deps.states.consume(input.state)
  if (!found) throw new GatewayError('invalid_arguments', 'unknown or expired oauth state')

  const adapter = deps.registry.get(found.prefix)
  const exchange = deps.exchange ?? exchangeCode
  const tokens: TokenSet = await exchange(deps.oauthConfig(adapter.grantId), {
    code: input.code,
    verifier: found.verifier,
    redirectUri: redirectUriFor(deps.publicUrl, found.prefix),
  })

  await deps.grants.save(found.workspaceId, adapter.grantId, tokens)
  await deps.enablement.enable(found.workspaceId, found.prefix)
  return { prefix: found.prefix, workspaceId: found.workspaceId }
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
