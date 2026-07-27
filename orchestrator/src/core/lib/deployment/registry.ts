import type { DeploymentProvider } from './provider'
import { NoopProvider } from './noop-provider'

const registry = new Map<string, DeploymentProvider>()

/**
 * Register a deployment provider under the given key.
 *
 * The `key` must match the `provider` field in `.mars/deploy.config.json`.
 * Registering under the same key replaces the prior entry.
 */
export function registerProvider(key: string, provider: DeploymentProvider): void {
  registry.set(key, provider)
}

/**
 * Retrieve the provider registered under `key`, or `undefined` when no
 * provider has been registered under that key.
 */
export function getProvider(key: string): DeploymentProvider | undefined {
  return registry.get(key)
}

// Built-in providers registered at module load.
registerProvider('noop', new NoopProvider())
