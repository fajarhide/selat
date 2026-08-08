import type { NextFunction, Request, Response } from 'express'
import { hashCredential, type CredentialScope } from '../../domain/credential.ts'
import { GatewayError } from '../../domain/errors.ts'
import type { CredentialStore } from '../../ports/stores.ts'

declare global {
  namespace Express {
    interface Request {
      auth: { workspaceId: string; credentialId: string; scope: CredentialScope }
    }
  }
}

export function requireCredential(store: CredentialStore) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const header = req.get('authorization') ?? ''
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
      if (!token.startsWith('lyc_')) {
        throw new GatewayError('invalid_credential', 'missing bearer credential')
      }
      // The lookup is by hash, so an attacker who can time it learns nothing
      // the hash does not already reveal.
      const found = await store.findByHash(hashCredential(token))
      if (!found || found.revokedAt) {
        throw new GatewayError('invalid_credential', 'unknown or revoked credential')
      }
      req.auth = { workspaceId: found.workspaceId, credentialId: found.id, scope: found.scope }
      // Fire and forget: a last-used write must never fail a tool call.
      void store.touch(found.id).catch(() => {})
      next()
    } catch (err) {
      next(err)
    }
  }
}
