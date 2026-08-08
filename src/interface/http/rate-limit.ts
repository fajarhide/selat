import type { NextFunction, Request, Response } from 'express'
import { GatewayError } from '../../domain/errors.ts'

type Bucket = { tokens: number; refilledAt: number }

/**
 * ponytail: in-process token bucket per workspace. Move it to Redis only when
 * the gateway runs more than one replica per region, since until then a shared
 * store buys nothing and costs a dependency.
 */
export function rateLimiter(perMinute: number, buckets = new Map<string, Bucket>()) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const key = req.gateway.workspaceId
    const now = Date.now()
    const bucket = buckets.get(key) ?? { tokens: perMinute, refilledAt: now }

    const refill = Math.floor(((now - bucket.refilledAt) / 60_000) * perMinute)
    if (refill > 0) {
      bucket.tokens = Math.min(perMinute, bucket.tokens + refill)
      bucket.refilledAt = now
    }

    if (bucket.tokens <= 0) {
      buckets.set(key, bucket)
      next(new GatewayError('rate_limited', 'workspace rate limit', { retryAfter: 60 }))
      return
    }

    bucket.tokens -= 1
    buckets.set(key, bucket)
    next()
  }
}
