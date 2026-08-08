import { loadConfig } from './config.ts'
import { createPool, runMigrations } from './adapters/db/pool.ts'
import { createServer } from './server.ts'

const config = loadConfig()
const pool = createPool(config.databaseUrl)
await runMigrations(pool)

const server = createServer({ pool, config }).listen(config.port, () => {
  console.log(JSON.stringify({ msg: 'listening', port: config.port }))
})

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => void pool.end().then(() => process.exit(0)))
  })
}
