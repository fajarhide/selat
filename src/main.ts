import { loadConfig } from './config.ts'
import { createPool, runMigrations } from './adapters/db/pool.ts'
import { createServer } from './server.ts'
import { bootRegistry } from './adapters/providers/boot.ts'

const config = loadConfig()
const pool = createPool(config.databaseUrl, config.poolMax)
await runMigrations(pool)

const server = createServer({ pool, config, registry: bootRegistry() }).listen(config.port, () => {
  console.log(JSON.stringify({ msg: 'listening', port: config.port }))
})

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => void pool.end().then(() => process.exit(0)))
  })
}
