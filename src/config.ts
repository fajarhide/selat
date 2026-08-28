import { z } from 'zod'

const schema = z.object({
  PORT: z.coerce.number().default(8080),
  // Which address to listen on. Unset keeps Node's own choice, every interface,
  // because a container on a bridge network is unreachable on loopback and that
  // is the common deployment. A host-networked one behind a reverse proxy
  // should set 127.0.0.1: the proxy is the only thing that needs this port, and
  // binding wider leaves the firewall as the only thing between the gateway and
  // the internet in plaintext, with no access log to show for it.
  HOST: z.string().min(1).optional(),
  // Absent means local mode: an embedded Postgres under the data directory.
  // A deployment sets it, and setting it takes that path out of the picture.
  DATABASE_URL: z.string().min(1).optional(),
  VAULT_KEY: z.string().regex(/^[0-9a-f]{64}$/, 'VAULT_KEY must be 32 bytes of hex'),
  PUBLIC_URL: z.string().url(),
  SERVICE_TOKEN: z.string().startsWith('slt_svc_').min(40).optional(),
  DASHBOARD_URL: z.string().url().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
})

export type Config = {
  port: number
  /** Unset means every interface, which is Node's own default. */
  host?: string
  databaseUrl?: string
  vaultKey: Buffer
  publicUrl: string
  serviceToken?: string
  dashboardUrl?: string
  poolMax: number
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env)
  const vaultKey = Buffer.from(parsed.VAULT_KEY, 'hex')
  // The all-zero key is the value shipped in .env.example. Refusing it here is
  // what stops a deployment from silently encrypting with a public key.
  if (vaultKey.every((byte) => byte === 0)) {
    throw new Error('VAULT_KEY is still the example value, generate one with: openssl rand -hex 32')
  }
  return {
    port: parsed.PORT,
    ...(parsed.HOST ? { host: parsed.HOST } : {}),
    ...(parsed.DATABASE_URL ? { databaseUrl: parsed.DATABASE_URL } : {}),
    vaultKey,
    publicUrl: parsed.PUBLIC_URL.replace(/\/$/, ''),
    serviceToken: parsed.SERVICE_TOKEN,
    dashboardUrl: parsed.DASHBOARD_URL?.replace(/\/$/, ''),
    poolMax: parsed.DATABASE_POOL_MAX,
  }
}
