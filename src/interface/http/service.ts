import { createHash, timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { GatewayError } from '../../domain/errors.ts'

export const SERVICE_PREFIX = 'slt_svc_'

/**
 * The portal acts on behalf of a workspace with one long-lived token. It is a
 * separate plane from the agent credential on purpose: an agent bearer must
 * never reach an admin route, and this token must never reach a tool call.
 */
export function requireService(serviceToken: string | undefined) {
  const expected = serviceToken ? sha256(serviceToken) : null
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!expected) {
        throw new GatewayError('invalid_credential', 'service plane is not configured')
      }
      const header = req.get('authorization') ?? ''
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
      if (!token.startsWith(SERVICE_PREFIX) || !equalHex(sha256(token), expected)) {
        throw new GatewayError('invalid_credential', 'invalid service token')
      }
      next()
    } catch (err) {
      next(err)
    }
  }
}

export function workspaceParam(req: Request): string {
  const value = req.params.workspaceId
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new GatewayError('invalid_arguments', 'workspaceId must be a uuid')
  }
  return value
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function equalHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  return left.length === right.length && timingSafeEqual(left, right)
}
