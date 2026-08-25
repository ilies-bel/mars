/**
 * Provider registry — the open, runtime-registrable set of agent-CLI
 * providers. Replaces the closed `ProviderName` union and the static
 * `PROVIDER_MODELS` / `PROVIDERS` records that used to key off it
 * (`provider-types.ts`, `providers.ts`).
 *
 * Built on `@mars/workflow`'s keyed service registry — a plain `Map` would
 * store the same data, but `require()` (throws with the known-provider list
 * instead of returning `undefined`) and `changes` (so a future consumer can
 * react to a provider being registered/withdrawn without polling) are exactly
 * what this seam needs, and reusing the container's primitive here is the
 * "use it where it fits naturally" case from the target architecture.
 *
 * `claude`, `gemini`, and `codex` self-register as a side effect of importing
 * `./providers` (which every current call site already imports transitively
 * through `./index`). `PROVIDERS` and `PROVIDER_MODELS` below are live,
 * registry-backed compatibility views — Proxies, not snapshots — so the ~15
 * existing call sites that index them like plain records (`PROVIDERS.claude`,
 * `Object.keys(PROVIDER_MODELS)`, `{ ...Workers }`-style spreads) keep working
 * unchanged while a provider registered later (there is no discovery
 * mechanism yet, but the seam is real) is visible through them immediately.
 */

import { createServiceRegistry, type Disposer } from '@mars/workflow'
import type { Provider, ProviderModelTier, ProviderModels, ProviderName } from './provider-types'

/**
 * A registered provider's full descriptor: everything the old `Provider`
 * interface carried, plus the provider-native model-tier table that used to
 * live in the separate `PROVIDER_MODELS` record, and the (optional) binary
 * resolution overrides that used to live in `provider-bin.ts`'s
 * `PROVIDER_BIN_ENV` / `PROVIDER_BIN_NAME` records.
 */
export interface ProviderDescriptor extends Provider {
  readonly models: ProviderModels
  /** Env var consulted to override this provider's binary path. Defaults to `MARS_<NAME>_BIN`. */
  readonly binEnvVar?: string
  /** Bare executable name searched on PATH when no override is set. Defaults to the provider name. */
  readonly binName?: string
}

type ProviderMap = Record<ProviderName, ProviderDescriptor>

const registry = createServiceRegistry<ProviderMap>()

/** Register a provider. Built-ins self-register at import time (see `providers.ts`). */
export const registerProvider = (descriptor: ProviderDescriptor): Disposer =>
  registry.provide(descriptor.name, descriptor)

export const getProvider = (name: ProviderName): ProviderDescriptor | undefined => registry.get(name)

/** Like {@link getProvider}, but throws naming every registered provider instead of returning `undefined`. */
export const requireProvider = (name: ProviderName): ProviderDescriptor => {
  if (!registry.has(name)) {
    const known = listProviders()
      .map((p) => p.name)
      .sort()
      .join(', ')
    throw new Error(`Unknown provider '${name}' — known: ${known || '(none registered)'}`)
  }
  return registry.require(name)
}

export const listProviders = (): readonly ProviderDescriptor[] =>
  registry.keys().map((name) => registry.require(name))

/**
 * A live `Readonly<Record<ProviderName, V>>` view over the registry, built
 * with a `Proxy` so it supports every access pattern the old static records
 * supported (`view.claude`, `'claude' in view`, `Object.keys(view)`,
 * `Object.values(view)`, `{ ...view }`) while staying backed by whatever is
 * currently registered rather than a value frozen at module-load time.
 */
const registryView = <V>(pick: (d: ProviderDescriptor) => V): Readonly<Record<ProviderName, V>> =>
  new Proxy({} as Record<ProviderName, V>, {
    get: (_t, prop) => {
      if (typeof prop !== 'string') return undefined
      const d = getProvider(prop)
      return d === undefined ? undefined : pick(d)
    },
    has: (_t, prop) => typeof prop === 'string' && getProvider(prop) !== undefined,
    ownKeys: () => listProviders().map((d) => d.name),
    getOwnPropertyDescriptor: (_t, prop) => {
      if (typeof prop !== 'string') return undefined
      const d = getProvider(prop)
      if (d === undefined) return undefined
      return { enumerable: true, configurable: true, value: pick(d) }
    },
  })

/** Compatibility view: `PROVIDERS[name]` → the full descriptor (superset of the old `Provider`). */
export const PROVIDERS: Readonly<Record<ProviderName, ProviderDescriptor>> = registryView((d) => d)

/** Compatibility view: `PROVIDER_MODELS[name]` → `{ flagship, balanced, fast }`. */
export const PROVIDER_MODELS: Readonly<Record<ProviderName, ProviderModels>> = registryView(
  (d) => d.models,
)

/**
 * Reverse-map a concrete model id to the tier it occupies for the given
 * provider. Returns undefined when the provider is unregistered or the model
 * id does not appear in its tier table.
 */
export const tierForModel = (model: string, provider: ProviderName): ProviderModelTier | undefined => {
  const models = getProvider(provider)?.models
  if (models === undefined) return undefined
  for (const tier of ['flagship', 'balanced', 'fast'] as const) {
    if (models[tier] === model) return tier
  }
  return undefined
}

/** Generic Proxy view helper for other provider-keyed compat records (see `provider-bin.ts`). */
export const providerRegistryView = registryView
