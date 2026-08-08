import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    hookTimeout: 30_000,
    testTimeout: 30_000,
    // Integration suites share one Postgres database and truncate between
    // tests, so they must not run concurrently with each other.
    fileParallelism: false,
    // Defaults match docker-compose, so a fresh clone runs `npm test` with no
    // setup beyond starting Postgres. A real environment overrides them.
    env: {
      TEST_DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        'postgres://selat:selat@localhost:5432/selat_test',
      DATABASE_URL:
        process.env.DATABASE_URL ?? 'postgres://selat:selat@localhost:5432/selat_test',
      PUBLIC_URL: process.env.PUBLIC_URL ?? 'http://localhost:8080',
      VAULT_KEY:
        process.env.VAULT_KEY ??
        '11111111111111111111111111111111111111111111111111111111111111ff',
    },
  },
})
