import { loadConfig, type Config } from './config.ts'
import { createPool, runMigrations, type Pool } from './adapters/db/pool.ts'
import { createEmbeddedPool } from './adapters/db/embedded.ts'
import { localMode, type LocalMode } from './local-mode.ts'

/** One place decides which database is in play, so the server and the
 *  quickstart script can never disagree about which one they just wrote to. */
export async function openDatabase(env: NodeJS.ProcessEnv = process.env): Promise<{
  pool: Pool
  config: Config
  local: LocalMode | null
}> {
  const local = localMode(env)
  const config = loadConfig(local ? local.env : env)
  const pool = config.databaseUrl
    ? createPool(config.databaseUrl, config.poolMax)
    : createEmbeddedPool(local?.dataDir)
  await runMigrations(pool)
  return { pool, config, local }
}
