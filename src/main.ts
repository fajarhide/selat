#!/usr/bin/env node
import { openDatabase } from './open-database.ts'
import { provisionLocal } from './local-provision.ts'
import { createServer } from './server.ts'
import { bootRegistry } from './adapters/providers/boot.ts'

const { pool, config, local } = await openDatabase()
const token = local ? await provisionLocal(pool, local.root) : undefined

const server = createServer({ pool, config, registry: bootRegistry() }).listen(config.port, () => {
  console.log(
    JSON.stringify({
      msg: 'listening',
      port: config.port,
      ...(config.databaseUrl ? {} : { database: 'embedded', dataDir: local?.dataDir }),
    }),
  )
  if (token) {
    process.stdout.write(
      `\nNo DATABASE_URL, so this is a local instance with its own embedded Postgres.\n` +
        `State lives in ${local?.root}, and this credential is in ${local?.root}/credential:\n\n` +
        `  ${token}\n\n` +
        `  curl -s ${config.publicUrl}/v1/tools -H "Authorization: Bearer ${token}"\n\n` +
        `  curl -s -X POST ${config.publicUrl}/v1/tools/fake__echo/call \\\n` +
        `    -H "Authorization: Bearer ${token}" -H 'content-type: application/json' \\\n` +
        `    -d '{"message":"hello"}'\n\n`,
    )
  }
})

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => void pool.end().then(() => process.exit(0)))
  })
}
