export type ErrorCode =
  | 'invalid_arguments'
  | 'invalid_credential'
  | 'provider_not_connected'
  | 'credential_scope_denied'
  | 'plan_blocked'
  | 'tool_not_found'
  | 'reauth_required'
  | 'quota_exceeded'
  | 'rate_limited'
  | 'upstream_error'
  | 'upstream_timeout'

const STATUS: Record<ErrorCode, number> = {
  invalid_arguments: 400,
  invalid_credential: 401,
  provider_not_connected: 403,
  credential_scope_denied: 403,
  plan_blocked: 403,
  tool_not_found: 404,
  reauth_required: 409,
  quota_exceeded: 429,
  rate_limited: 429,
  upstream_error: 502,
  upstream_timeout: 504,
}

export type ErrorDetails = {
  provider?: string
  retryAfter?: number
  reauthUrl?: string
}

export class GatewayError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: ErrorDetails = {},
  ) {
    super(message)
    this.name = 'GatewayError'
  }

  get status(): number {
    return STATUS[this.code]
  }
}

export function toEnvelope(err: unknown, requestId: string): { status: number; body: object } {
  if (err instanceof GatewayError) {
    return {
      status: err.status,
      body: {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details.provider ? { provider: err.details.provider } : {}),
          ...(err.details.retryAfter ? { retry_after: err.details.retryAfter } : {}),
          ...(err.details.reauthUrl ? { reauth_url: err.details.reauthUrl } : {}),
          request_id: requestId,
        },
      },
    }
  }
  // An unmapped error may carry a hostname, a connection string or a token in
  // its message, so the client gets the request id and nothing else.
  return {
    status: 500,
    body: { error: { code: 'internal_error', message: 'internal error', request_id: requestId } },
  }
}
