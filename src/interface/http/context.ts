import { randomUUID } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { GatewayError, toEnvelope } from '../../domain/errors.ts'

declare global {
  namespace Express {
    interface Request {
      requestId: string
    }
  }
}

export function withRequestContext() {
  return (req: Request, res: Response, next: NextFunction) => {
    req.requestId = randomUUID()
    res.setHeader('X-Request-Id', req.requestId)
    next()
  }
}

export function errorHandler() {
  return (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const { status, body } = toEnvelope(err, req.requestId)
    if (err instanceof GatewayError && err.details.retryAfter) {
      res.setHeader('Retry-After', String(err.details.retryAfter))
    }
    if (status >= 500) {
      console.error(
        JSON.stringify({ msg: 'unhandled', request_id: req.requestId, error: String(err) }),
      )
    }
    res.status(status).json(body)
  }
}
