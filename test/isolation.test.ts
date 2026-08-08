import { readdir, readFile } from 'node:fs/promises'
import { afterAll, describe, expect, it } from 'vitest'
import { mintCredential } from '../src/domain/credential.ts'
import { closeTestServers, startTestServer } from './helpers/server.ts'
import { testPool } from './helpers/db.ts'
import { json } from './helpers/http.ts'

afterAll(async () => {
  await closeTestServers()
  await (await testPool()).end()
})

const TENANT_TABLES = [
  'gateway_credentials',
  'grants',
  'oauth_states',
  'idempotency_keys',
  'provider_enablements',
  'tool_overrides',
  'usage_events',
  'usage_counters',
  'audit_log',
]

// A statement that touches a tenant table without naming workspace_id is the
// one bug class that leaks another customer's data, so it fails the build
// rather than waiting for review to catch it.
//
// Scan whole string literals of every quoting style. An earlier version ran to
// the next backtick instead, which silently skipped every file that had none,
// and credential-store.ts was exactly such a file.
// A query that genuinely cannot carry the predicate says so on the line above
// it. Requiring the marker keeps every exception in the diff and in review,
// which a silently loosened rule would not.
const LITERAL = /`[^`]*`|'[^']*'|"[^"]*"/g
const VERB = /\b(SELECT|INSERT|UPDATE|DELETE)\b/i
const EXEMPT = 'isolation-exempt:'

describe('tenant isolation', () => {
  it('every query against a tenant table names workspace_id', async () => {
    const dirs = ['src/adapters/db', 'src/application']
    let checked = 0
    for (const dir of dirs) {
      for (const file of await readdir(dir)) {
        if (!file.endsWith('.ts')) continue
        const source = await readFile(`${dir}/${file}`, 'utf8')
        const lines = source.split('\n')
        for (const statement of source.match(LITERAL) ?? []) {
          if (!VERB.test(statement)) continue
          if (!TENANT_TABLES.some((table) => statement.includes(table))) continue
          const line = source.slice(0, source.indexOf(statement)).split('\n').length - 1
          // Six lines back, because the reason is usually longer than the
          // query and a marker that only fits on one line invites a bad one.
          if (lines.slice(Math.max(0, line - 6), line + 1).some((l) => l.includes(EXEMPT))) continue
          checked += 1
          expect(statement, `${dir}/${file}: ${statement.slice(0, 80)}`).toMatch(/workspace_id/)
        }
      }
    }
    expect(checked).toBeGreaterThan(5)
  })

  it('a credential from one workspace cannot see another workspace catalog', async () => {
    const { base, token, pool } = await startTestServer()
    const { rows } = await pool.query("INSERT INTO workspaces (name) VALUES ('other') RETURNING id")
    const other = rows[0].id as string
    const minted = mintCredential('live')
    await pool.query(
      'INSERT INTO gateway_credentials (workspace_id, token_hash, last4) VALUES ($1,$2,$3)',
      [other, minted.hash, minted.last4],
    )

    const mine = await json(
      await fetch(`${base}/v1/tools`, { headers: { authorization: `Bearer ${token}` } }),
    )
    const theirs = await json(
      await fetch(`${base}/v1/tools`, { headers: { authorization: `Bearer ${minted.token}` } }),
    )

    expect(mine.tools.length).toBeGreaterThan(0)
    expect(theirs.tools).toEqual([])
  })

  it('a credential from one workspace cannot call another workspace provider', async () => {
    const { base, pool } = await startTestServer()
    const { rows } = await pool.query("INSERT INTO workspaces (name) VALUES ('other') RETURNING id")
    const minted = mintCredential('live')
    await pool.query(
      'INSERT INTO gateway_credentials (workspace_id, token_hash, last4) VALUES ($1,$2,$3)',
      [rows[0].id, minted.hash, minted.last4],
    )

    const res = await fetch(`${base}/v1/tools/fake__echo/call`, {
      method: 'POST',
      headers: { authorization: `Bearer ${minted.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    })
    expect(res.status).toBe(403)
    expect((await json(res)).error.code).toBe('provider_not_connected')
  })

  it('meters a call against the workspace that made it', async () => {
    const { base, token, pool, workspaceId } = await startTestServer()
    await fetch(`${base}/v1/tools/fake__echo/call`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    })
    const { rows } = await pool.query(
      'SELECT provider, tool, outcome FROM usage_events WHERE workspace_id = $1',
      [workspaceId],
    )
    expect(rows).toEqual([{ provider: 'fake', tool: 'echo', outcome: 'ok' }])
  })

  it('refuses a call once the workspace quota is spent', async () => {
    const { base, token, pool, workspaceId } = await startTestServer()
    await pool.query('UPDATE workspaces SET call_quota = 0 WHERE id = $1', [workspaceId])
    const res = await fetch(`${base}/v1/tools/fake__echo/call`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    })
    expect(res.status).toBe(429)
    expect((await json(res)).error.code).toBe('quota_exceeded')
    expect(res.headers.get('retry-after')).toBe('3600')
  })

  it('rate limits a workspace and says how long to wait', async () => {
    const { base, token } = await startTestServer({ overrides: { callsPerMinute: 1 } })
    const call = () =>
      fetch(`${base}/v1/tools/fake__echo/call`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hi' }),
      })
    expect((await call()).status).toBe(200)
    const limited = await call()
    expect(limited.status).toBe(429)
    expect((await json(limited)).error.code).toBe('rate_limited')
    expect(limited.headers.get('retry-after')).toBe('60')
  })
})
