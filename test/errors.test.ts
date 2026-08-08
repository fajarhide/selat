import { describe, expect, it } from 'vitest'
import { GatewayError, toEnvelope } from '../src/domain/errors.ts'

describe('error envelope', () => {
  it('maps every code to its documented status', () => {
    expect(new GatewayError('invalid_arguments', 'no').status).toBe(400)
    expect(new GatewayError('invalid_credential', 'no').status).toBe(401)
    expect(new GatewayError('provider_not_connected', 'no').status).toBe(403)
    expect(new GatewayError('credential_scope_denied', 'no').status).toBe(403)
    expect(new GatewayError('plan_blocked', 'no').status).toBe(403)
    expect(new GatewayError('tool_not_found', 'no').status).toBe(404)
    expect(new GatewayError('reauth_required', 'no').status).toBe(409)
    expect(new GatewayError('quota_exceeded', 'no').status).toBe(429)
    expect(new GatewayError('rate_limited', 'no').status).toBe(429)
    expect(new GatewayError('upstream_error', 'no').status).toBe(502)
    expect(new GatewayError('upstream_timeout', 'no').status).toBe(504)
  })

  it('carries provider, retry and reauth details', () => {
    const err = new GatewayError('reauth_required', 'grant expired', {
      provider: 'google',
      reauthUrl: 'https://app.example.com/connect/google',
    })
    const { status, body } = toEnvelope(err, 'req-1')
    expect(status).toBe(409)
    expect(body).toEqual({
      error: {
        code: 'reauth_required',
        message: 'grant expired',
        provider: 'google',
        reauth_url: 'https://app.example.com/connect/google',
        request_id: 'req-1',
      },
    })
  })

  it('omits details that were not set', () => {
    const { body } = toEnvelope(new GatewayError('tool_not_found', 'nope'), 'req-3')
    expect(body).toEqual({
      error: { code: 'tool_not_found', message: 'nope', request_id: 'req-3' },
    })
  })

  it('never leaks an unknown error message to the client', () => {
    const { status, body } = toEnvelope(new Error('connect ECONNREFUSED 10.0.0.5'), 'req-2')
    expect(status).toBe(500)
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED')
    expect(JSON.stringify(body)).toContain('req-2')
  })
})
