import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * What `npx selat` needs so that running it is the whole setup. Nothing here
 * applies once DATABASE_URL is set: a deployment states its own values, and
 * silently inventing them there is how a production instance ends up encrypting
 * with a key nobody recorded.
 */
export type LocalMode = { root: string; dataDir: string; env: NodeJS.ProcessEnv }

export function localMode(env: NodeJS.ProcessEnv = process.env): LocalMode | null {
  if (env.DATABASE_URL) return null

  const root = env.SELAT_DATA_DIR ?? join(homedir(), '.selat')
  mkdirSync(root, { recursive: true, mode: 0o700 })

  // Generated once and kept, because it is what every stored vendor token is
  // sealed with. A fresh key on each start would leave the grants in the
  // database unreadable and look like the connections had silently expired.
  const keyFile = join(root, 'vault.key')
  if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 })

  return {
    root,
    dataDir: join(root, 'db'),
    env: {
      ...env,
      VAULT_KEY: env.VAULT_KEY ?? readFileSync(keyFile, 'utf8').trim(),
      PUBLIC_URL: env.PUBLIC_URL ?? `http://localhost:${env.PORT ?? 8080}`,
    },
  }
}
