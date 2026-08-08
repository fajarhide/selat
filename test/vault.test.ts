import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createVault, grantAad } from '../src/adapters/crypto/vault.ts'

const key = randomBytes(32)
const vault = createVault(key)
const aad = grantAad('ws-1', 'google')

describe('vault', () => {
  it('round trips a secret', () => {
    const sealed = vault.seal('refresh-token-value', aad)
    expect(sealed.ciphertext).not.toContain('refresh-token-value')
    expect(vault.open(sealed, aad)).toBe('refresh-token-value')
  })

  it('produces a different ciphertext each time', () => {
    expect(vault.seal('x', aad).ciphertext).not.toBe(vault.seal('x', aad).ciphertext)
  })

  it('refuses to open a record bound to another tenant', () => {
    const sealed = vault.seal('secret', grantAad('ws-1', 'google'))
    expect(() => vault.open(sealed, grantAad('ws-2', 'google'))).toThrow()
  })

  it('refuses to open a record bound to another grant', () => {
    const sealed = vault.seal('secret', grantAad('ws-1', 'google'))
    expect(() => vault.open(sealed, grantAad('ws-1', 'github'))).toThrow()
  })

  it('refuses to open with a different key', () => {
    const sealed = vault.seal('secret', aad)
    expect(() => createVault(randomBytes(32)).open(sealed, aad)).toThrow()
  })

  it('refuses to open a tampered ciphertext', () => {
    const sealed = vault.seal('secret', aad)
    const flipped = { ...sealed, ciphertext: Buffer.from('nonsense').toString('base64') }
    expect(() => vault.open(flipped, aad)).toThrow()
  })

  it('refuses a key that is not 32 bytes', () => {
    expect(() => createVault(randomBytes(16))).toThrow()
  })

  it('records the key version for rotation', () => {
    expect(createVault(key, 2).seal('x', aad).keyVersion).toBe(2)
  })
})
