/**
 * Deployment-provider registry.
 *
 * Providers self-register at startup via `registerProvider`. Callers (the
 * teardown helper, the deploy/status paths) use `getProvider` to look up the
 * registered implementation for a given provider key (e.g. "noop", "http").
 *
 * The registry is process-global: one Map shared by all importers within the
 * same Node.js process. This is intentional — providers register once at
 * boot and are never replaced during normal operation.
 */

import type { DeploymentProvider } from './provider'
import { NoopProvider } from './noop-provider'
import { HttpDeploymentProvider } from './http-provider'

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

// Register the HTTP provider when the required env vars are present.
const httpEndpoint = process.env.MARS_HTTP_DEPLOY_ENDPOINT
const httpToken = process.env.MARS_HTTP_DEPLOY_TOKEN
if (httpEndpoint && httpToken) {
  registerProvider('http', new HttpDeploymentProvider({ endpoint: httpEndpoint, token: httpToken }))
}
