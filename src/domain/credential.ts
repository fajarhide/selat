import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { GatewayError } from './errors.ts'

export type CredentialScope = { providers: string[] | null; readOnly: boolean }

export const DEFAULT_SCOPE: CredentialScope = { providers: null, readOnly: false }

export function mintCredential(env: 'live' | 'test'): {
  token: string
  hash: string
  last4: string
} {
  // The fixed prefix is what makes the token matchable by secret scanners,
  // which turns a public leak into an automatic revocation.
  const secret = randomBytes(32).toString('base64url')
  const token = `slt_${env}_${secret}`
  return { token, hash: hashCredential(token), last4: token.slice(-4) }
}

export function hashCredential(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function credentialHashEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  return left.length === right.length && timingSafeEqual(left, right)
}

export function assertScopeAllows(
  scope: CredentialScope,
  prefix: string,
  isWrite: boolean,
): void {
  if (!scopeAllowsProvider(scope, prefix)) {
    throw new GatewayError('credential_scope_denied', `credential is not scoped to ${prefix}`, {
      provider: prefix,
    })
  }
  if (scope.readOnly && isWrite) {
    throw new GatewayError('credential_scope_denied', 'credential is read only', {
      provider: prefix,
    })
  }
}

export function scopeAllowsProvider(scope: CredentialScope, prefix: string): boolean {
  return scope.providers === null || scope.providers.includes(prefix)
}

/**
 * The listing half of `assertScopeAllows`, and the two have to agree: a tool
 * belongs in a credential's list exactly when that credential could call it.
 * Offering one it cannot spends the model's turn to teach it a 403 that was
 * knowable before the list was written.
 */
export function scopeAllowsTool(
  scope: CredentialScope,
  tool: { provider: string; write: boolean },
): boolean {
  if (!scopeAllowsProvider(scope, tool.provider)) return false
  return !(scope.readOnly && tool.write)
}
