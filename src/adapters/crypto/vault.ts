import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export type Sealed = {
  ciphertext: string
  iv: string
  tag: string
  keyVersion: number
}

// The additional authenticated data binds a ciphertext to its tenant and grant.
// Without it, a row copied between workspaces would still decrypt.
export function grantAad(workspaceId: string, grantId: string): string {
  return `${workspaceId}|${grantId}`
}

export type Vault = {
  seal(plaintext: string, aad: string): Sealed
  open(sealed: Sealed, aad: string): string
}

export function createVault(key: Buffer, keyVersion = 1): Vault {
  if (key.length !== 32) throw new Error('vault key must be 32 bytes')
  return {
    seal(plaintext, aad) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      cipher.setAAD(Buffer.from(aad, 'utf8'))
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      return {
        ciphertext: ciphertext.toString('base64'),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        keyVersion,
      }
    },

    open(sealed, aad) {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'))
      decipher.setAAD(Buffer.from(aad, 'utf8'))
      decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
      return Buffer.concat([
        decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8')
    },
  }
}
