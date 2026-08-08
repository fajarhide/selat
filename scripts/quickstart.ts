import { loadConfig } from '../src/config.ts'
import { createPool, runMigrations } from '../src/adapters/db/pool.ts'
import { mintCredential } from '../src/domain/credential.ts'
import { bootRegistry } from '../src/adapters/providers/boot.ts'

/**
 * Creates a workspace, mints a credential and enables the providers that need
 * no vendor. It exists so the README's step two is a command rather than a
 * paragraph, which is what makes time to first tool call measurable.
 */
const config = loadConfig()
const pool = createPool(config.databaseUrl)
await runMigrations(pool)

const name = process.argv[2] ?? 'my workspace'
const { rows } = await pool.query('INSERT INTO workspaces (name) VALUES ($1) RETURNING id', [name])
const workspaceId = rows[0].id as string

const { token, hash, last4 } = mintCredential('live')
await pool.query(
  'INSERT INTO gateway_credentials (workspace_id, token_hash, last4) VALUES ($1,$2,$3)',
  [workspaceId, hash, last4],
)

// The fake provider needs no OAuth application, so a fresh install can reach a
// real tool call before touching any vendor console.
await pool.query('INSERT INTO provider_enablements (workspace_id, prefix) VALUES ($1,$2)', [
  workspaceId,
  'fake',
])

const providers = bootRegistry()
  .all()
  .map((adapter) => adapter.prefix)
  .join(', ')

await pool.end()

process.stdout.write(`
Workspace ${workspaceId} created.
Registered providers: ${providers}

Your gateway credential, shown once:

  ${token}

Try it:

  curl -s ${config.publicUrl}/v1/tools -H "Authorization: Bearer ${token}"

  curl -s -X POST ${config.publicUrl}/v1/tools/fake__echo/call \\
    -H "Authorization: Bearer ${token}" -H 'content-type: application/json' \\
    -d '{"message":"hello"}'

Point an MCP client at it:

  {
    "mcpServers": {
      "lycosagate": {
        "type": "http",
        "url": "${config.publicUrl}/mcp",
        "headers": { "Authorization": "Bearer ${token}" }
      }
    }
  }
`)
