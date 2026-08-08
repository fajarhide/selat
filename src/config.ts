import { z } from 'zod'

const schema = z.object({
  PORT: z.coerce.number().default(8080),
  DATABASE_URL: z.string().min(1),
  VAULT_KEY: z.string().regex(/^[0-9a-f]{64}$/, 'VAULT_KEY must be 32 bytes of hex'),
  PUBLIC_URL: z.string().url(),
})

export type Config = {
  port: number
  databaseUrl: string
  vaultKey: Buffer
  publicUrl: string
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
    databaseUrl: parsed.DATABASE_URL,
    vaultKey,
    publicUrl: parsed.PUBLIC_URL.replace(/\/$/, ''),
  }
}
