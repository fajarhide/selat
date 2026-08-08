import { describe, expect, it } from 'vitest'
import {
  assertScopeAllows,
  credentialHashEquals,
  hashCredential,
  mintCredential,
} from '../src/domain/credential.ts'
import { GatewayError } from '../src/domain/errors.ts'

describe('credentials', () => {
  it('mints a scannable prefixed token', () => {
    const { token, hash, last4 } = mintCredential('live')
    expect(token.startsWith('slt_live_')).toBe(true)
    expect(token.length).toBeGreaterThan(40)
    expect(hash).toBe(hashCredential(token))
    expect(hash).not.toContain(token)
    expect(token.endsWith(last4)).toBe(true)
  })

  it('marks a sandbox token distinctly', () => {
    expect(mintCredential('test').token.startsWith('slt_test_')).toBe(true)
  })

  it('mints distinct tokens', () => {
    expect(mintCredential('live').token).not.toBe(mintCredential('live').token)
  })

  it('compares hashes without leaking length by early exit', () => {
    const { hash } = mintCredential('live')
    expect(credentialHashEquals(hash, hash)).toBe(true)
    expect(credentialHashEquals(hash, hashCredential('other'))).toBe(false)
    expect(credentialHashEquals(hash, 'ab')).toBe(false)
  })

  it('allows any provider when the allowlist is null', () => {
    expect(() => assertScopeAllows({ providers: null, readOnly: false }, 'jira', true)).not.toThrow()
  })

  it('denies a provider outside the allowlist', () => {
    expect(() =>
      assertScopeAllows({ providers: ['github'], readOnly: false }, 'jira', false),
    ).toThrowError(GatewayError)
  })

  it('denies a write through a read-only credential', () => {
    try {
      assertScopeAllows({ providers: null, readOnly: true }, 'jira', true)
      throw new Error('should have thrown')
    } catch (err) {
      expect((err as GatewayError).code).toBe('credential_scope_denied')
    }
  })

  it('still allows a read through a read-only credential', () => {
    expect(() => assertScopeAllows({ providers: null, readOnly: true }, 'jira', false)).not.toThrow()
  })
})
