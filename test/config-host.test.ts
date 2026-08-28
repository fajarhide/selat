import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'

const BASE = {
  VAULT_KEY: '1'.repeat(64),
  PUBLIC_URL: 'https://api.example.com',
  DATABASE_URL: 'postgres://selat:selat@localhost:5432/selat',
}

describe('the address the gateway binds', () => {
  // Absent has to stay absent rather than become a default string. main.ts
  // picks its listen call on that, and an explicit '::' would lose Node's own
  // fallback to IPv4 on a host with IPv6 turned off.
  it('is left to node when HOST is unset', () => {
    expect(loadConfig({ ...BASE } as NodeJS.ProcessEnv).host).toBeUndefined()
  })

  it('is carried through when HOST is set', () => {
    expect(loadConfig({ ...BASE, HOST: '127.0.0.1' } as NodeJS.ProcessEnv).host).toBe('127.0.0.1')
  })

  it('refuses an empty HOST rather than binding everywhere', () => {
    expect(() => loadConfig({ ...BASE, HOST: '' } as NodeJS.ProcessEnv)).toThrow()
  })
})
