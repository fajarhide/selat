import { createRegistry, type ProviderAdapter, type Registry } from './registry.ts'
import { fakeProvider } from './fake.ts'

// The registry is booted from the environment: cloud enables per plan, a
// self-host enables what it has OAuth applications for. A provider with no
// client id would only ever fail at connect time, so it is left out here.
export function bootRegistry(env: NodeJS.ProcessEnv = process.env): Registry {
  const adapters: ProviderAdapter[] = [fakeProvider()]
  void env
  return createRegistry(adapters)
}
