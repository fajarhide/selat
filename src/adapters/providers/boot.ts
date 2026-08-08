import { createRegistry, type ProviderAdapter, type Registry } from './registry.ts'
import { fakeProvider } from './fake.ts'
import { githubProvider } from './github.ts'

/**
 * The registry is booted from the environment: cloud enables per plan, a
 * self-host enables what it has OAuth applications for. A provider with no
 * client id is left out, because it could only ever fail at connect time.
 *
 * The fake provider is always present. It needs no vendor, which is what lets
 * the quickstart reach a first tool call before any OAuth application exists.
 */
export function bootRegistry(env: NodeJS.ProcessEnv = process.env): Registry {
  const adapters: ProviderAdapter[] = [fakeProvider()]
  if (env.GITHUB_CLIENT_ID) adapters.push(githubProvider())
  return createRegistry(adapters)
}
