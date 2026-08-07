// Persisted Worker declaration registry — operator-defined workers stored in
// .mars/worker-registry.json. At daemon start the file is loaded if present;
// if absent, the existing hard-coded WORKER_CONFIGS continue to serve as
// defaults (the registry shadows but does not replace them when missing).
//
// Dispatch behaviour is unchanged by this module: the Workers object in
// index.ts is still used for dispatch. This module owns the file I/O and
// the merged-view computation.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ClaudeEffort, ClaudePermissionMode } from '../lib/git/claude'
import {
  WORKER_CONFIGS,
  WORKER_PROVIDER,
  createWorker,
  type ClaudeOutputFormat,
  type Worker,
  type WorkerRuntime,
} from './index'
import {
  PROVIDER_MODELS,
  tierForModel,
  type ProviderModelTier,
  type ProviderName,
} from './provider-types'
import { PROVIDERS } from './providers'

// A Worker declaration as stored in the registry file. Same shape as
// WorkerConfig but name is a plain string — not constrained to the built-in
// WorkerName union — to allow operator-defined workers beyond the five
// shipped defaults.
//
// modelTier replaces the old model: string field. A tier survives a
// provider switch; a concrete model id does not. The registry ALWAYS persists
// a tier; the concrete model id is resolved at runtime through the active
// provider via PROVIDER_MODELS[provider][modelTier].
//
// modelOverride is set only when a concrete model id was explicitly requested
// (e.g. via mars worker add --model <id>) AND that id maps cleanly to a tier
// under the active provider. When the id does NOT map to any tier, the
// registry stores the best-effort tier and the raw id as modelOverride so
// it can be surfaced as a conflict in mars worker list.
export interface WorkerDeclaration {
  readonly name: string
  // Semantic tier: 'flagship' | 'balanced' | 'fast'. Drives model resolution
  // at runtime. Replaces the old `model: string` field.
  readonly modelTier: ProviderModelTier
  // Explicit concrete model id override. Present only when an operator
  // explicitly pinned a model id that does not map to a tier of the active
  // provider — surfaces as a conflict warning in mars worker list.
  readonly modelOverride?: string
  readonly fallbackModel?: string
  readonly effort: ClaudeEffort
  readonly permissionMode: ClaudePermissionMode
  readonly bare: boolean
  readonly disallowedTools: readonly string[]
  readonly outputFormat: ClaudeOutputFormat
  readonly runtime: WorkerRuntime
  // Which agent CLI this Worker drives. Defaults to WORKER_PROVIDER (daemon-level
  // provider) when absent — so a declaration without a provider inherits the
  // active provider and its resolved model changes when the provider changes.
  readonly provider?: ProviderName
  // Free-form list of routing tags. pickWorkerForTags routes a task to this
  // Worker when the task's tag list intersects this set. Any string is valid;
  // well-known values mirror the built-in Worker names (e.g. 'coder',
  // 'planner', 'slicer', 'triager', 'fixer'). Operator-defined Workers should
  // use domain-specific tags (e.g. 'scaffold', 'docs') that do not collide
  // with built-in tags unless the intent is to override a built-in route.
  readonly tags?: readonly string[]
}

// Display entry returned by listMergedWorkersForDisplay. Carries the Worker
// plus display metadata (resolved tier + conflict info) for mars worker list.
export interface WorkerDisplayEntry {
  readonly worker: Worker
  // Tier as stored in the registry (the intent).
  readonly modelTier: ProviderModelTier
  // Resolved concrete model id under the active provider (what actually runs).
  readonly resolvedModel: string
  // Active provider used for resolution.
  readonly activeProvider: ProviderName
  // When a modelOverride was set but doesn't belong to the active provider,
  // this field carries the conflicting override id. mars worker list displays
  // a conflict warning instead of the override as if it were in effect.
  readonly conflictingOverride?: string
  // True when this worker is a hard-coded built-in (one of the eight shipped
  // defaults). False for operator-added workers persisted in the registry.
  readonly isBuiltIn: boolean
}

const REGISTRY_FILENAME = 'worker-registry.json'

// Shape of an old-format registry entry that stored `model: string` instead
// of `modelTier`. Used for migration only.
interface LegacyDeclaration {
  readonly model: string
  readonly [key: string]: unknown
}

const isLegacyDeclaration = (
  raw: Record<string, unknown>,
): raw is LegacyDeclaration =>
  typeof raw['model'] === 'string' && !('modelTier' in raw)

// Migrate a single legacy declaration (model: string) to the new format.
// Searches all providers for a matching tier; falls back to 'balanced' with
// the original model id stored as modelOverride so it surfaces as a conflict.
//
// isBuiltIn: true when this entry is for a built-in worker name (Coder, etc.).
// Built-in workers that were seeded by configToDeclaration had their `provider`
// set to the daemon provider that was active at seeding time — not by operator
// intent (the old `mars worker add` never offered a --provider flag). Strip it
// so they inherit the current daemon provider, which is what tier-based
// resolution is designed to do.
const migrateLegacyDeclaration = (
  raw: Record<string, unknown>,
  isBuiltIn: boolean,
): WorkerDeclaration => {
  const modelId = raw['model'] as string
  // Search all known providers for a tier that maps to this model id.
  let inferredTier: ProviderModelTier | undefined
  for (const provider of Object.keys(PROVIDER_MODELS) as ProviderName[]) {
    inferredTier = tierForModel(modelId, provider)
    if (inferredTier !== undefined) break
  }
  const { model: _model, ...rest } = raw
  // Strip the provider for built-in workers — it was set by seeding, not by
  // the operator. Let it inherit the active daemon provider.
  if (isBuiltIn) {
    delete (rest as Record<string, unknown>)['provider']
  }
  if (inferredTier !== undefined) {
    // Model maps cleanly to a known tier across providers — store the tier.
    return { ...rest, modelTier: inferredTier } as WorkerDeclaration
  }
  // Unknown model id — store as override so it shows up as a conflict.
  return {
    ...rest,
    modelTier: 'balanced',
    modelOverride: modelId,
  } as WorkerDeclaration
}

// Load the persisted Worker registry from stateDir. Returns the declarations
// stored in the registry file, or an empty array when the file is absent.
// Throws if any declaration specifies a provider not in the PROVIDERS registry.
// Migrates old-format entries (model: string) to the new format (modelTier)
// in-memory; the file is not rewritten (callers should trigger addWorkerToRegistry
// to persist the migration if desired).
export const loadWorkerRegistry = (stateDir: string): WorkerDeclaration[] => {
  const filePath = resolve(stateDir, REGISTRY_FILENAME)
  if (!existsSync(filePath)) return []
  const raw = readFileSync(filePath, 'utf8')
  const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>
  const knownProviders = Object.keys(PROVIDERS)
  const builtInNames = new Set(Object.keys(WORKER_CONFIGS))
  const decls: WorkerDeclaration[] = []
  for (const entry of Object.values(parsed)) {
    const provider = entry['provider']
    if (provider !== undefined && typeof provider === 'string' && !knownProviders.includes(provider)) {
      throw new Error(
        `Unknown provider '${provider}' in worker-registry.json — known: ${knownProviders.join(', ')}`,
      )
    }
    const name = typeof entry['name'] === 'string' ? entry['name'] : undefined
    const isBuiltIn = name !== undefined && builtInNames.has(name)
    // Migrate legacy entries that still carry model: string.
    // Also strip the provider from new-format built-in entries — older versions
    // of configToDeclaration persisted provider: WORKER_PROVIDER, pinning every
    // built-in to whichever provider was active at seeding time and defeating
    // the defaultProvider lever. Built-ins must always inherit the active
    // daemon provider so a provider swap takes effect without a registry edit.
    let decl: WorkerDeclaration
    if (isLegacyDeclaration(entry)) {
      decl = migrateLegacyDeclaration(entry, isBuiltIn)
    } else if (isBuiltIn && 'provider' in entry) {
      // New-format built-in with a pinned provider — strip it.
      const { provider: _provider, ...rest } = entry
      decl = rest as unknown as WorkerDeclaration
    } else {
      decl = entry as unknown as WorkerDeclaration
    }
    decls.push(decl)
  }
  return decls
}

// Produce a WorkerDeclaration from a hard-coded WORKER_CONFIGS entry.
// Used when seeding the registry file on first write.
//
// Built-in workers do NOT persist a `provider` field — they inherit the
// active daemon provider at runtime. This means changing `defaultProvider`
// in daemon.json changes ALL un-pinned workers' resolved models without a
// registry edit. Operator-added workers that explicitly pin a provider (via
// `mars worker add --provider ...`) keep their `provider` field.
const configToDeclaration = (
  config: (typeof WORKER_CONFIGS)[keyof typeof WORKER_CONFIGS],
): WorkerDeclaration => {
  // Use the tracked modelTier from WorkerConfig if present, otherwise
  // reverse-map the concrete model id to a tier for the worker's provider.
  const modelTier: ProviderModelTier =
    config.modelTier ??
    tierForModel(config.model, config.provider) ??
    'balanced'

  return {
    name: config.name,
    modelTier,
    ...(config.fallbackModel !== undefined
      ? { fallbackModel: config.fallbackModel }
      : {}),
    effort: config.effort,
    permissionMode: config.permissionMode,
    bare: config.bare,
    disallowedTools: [...config.disallowedTools],
    outputFormat: config.outputFormat,
    runtime: config.runtime,
    // Intentionally NOT including provider — built-in workers inherit the
    // active daemon provider at runtime (WORKER_PROVIDER). Storing it would
    // pin them to whichever provider was active at seeding time, defeating
    // the whole point of tier-based resolution.
    ...(config.tags !== undefined ? { tags: [...config.tags] } : {}),
  }
}

// Resolve the effective provider name for a declaration, with fallback to the
// active daemon provider.
const effectiveProvider = (
  decl: WorkerDeclaration,
  activeProvider: ProviderName,
): ProviderName => decl.provider ?? activeProvider

// Resolve the concrete model id for a declaration given the active provider.
// If a modelOverride is set AND belongs to the effective provider, it is used
// directly. Otherwise the modelTier is resolved against the provider's tier table.
// Returns { model, conflict } where conflict is set when the override doesn't
// belong to the effective provider.
const resolveModel = (
  decl: WorkerDeclaration,
  providerName: ProviderName,
): { model: string; conflict?: string } => {
  if (decl.modelOverride !== undefined) {
    const overrideTier = tierForModel(decl.modelOverride, providerName)
    if (overrideTier !== undefined) {
      // Override belongs to this provider — use it directly.
      return { model: decl.modelOverride }
    }
    // Override doesn't belong to this provider — conflict.
    // Fall back to tier-based resolution and surface the conflict.
    return {
      model: PROVIDER_MODELS[providerName][decl.modelTier],
      conflict: decl.modelOverride,
    }
  }
  return { model: PROVIDER_MODELS[providerName][decl.modelTier] }
}

// Build a Worker from a WorkerDeclaration via createWorker. Missing
// WorkerConfig fields (maxContextTokens, etc.) are filled with safe
// defaults — operator-declared workers in the registry do not carry a
// context budget (0 = disabled). A declaration without its own provider uses
// the active daemon provider, matching built-in Workers.
const declarationToWorker = (
  decl: WorkerDeclaration,
  activeProvider: ProviderName,
): Worker => {
  const providerName = effectiveProvider(decl, activeProvider)
  const { model } = resolveModel(decl, providerName)
  return createWorker({
    name: decl.name,
    model,
    modelTier: decl.modelTier,
    ...(decl.fallbackModel !== undefined ? { fallbackModel: decl.fallbackModel } : {}),
    effort: decl.effort,
    permissionMode: decl.permissionMode,
    bare: decl.bare,
    disallowedTools: [...decl.disallowedTools],
    outputFormat: decl.outputFormat,
    maxContextTokens: 0,
    runtime: decl.runtime,
    provider: providerName,
    ...(decl.tags !== undefined ? { tags: [...decl.tags] } : {}),
  })
}

// Returns all known Workers: hard-coded defaults merged with registry entries.
// Registry entries override defaults for matching names; novel names from the
// registry are appended after the defaults. When no registry file exists,
// only the hard-coded defaults are returned.
// Each declaration is converted to a fully-constructed Worker via createWorker
// so the result can be passed directly to pickWorkerForTags.
// activeProvider defaults to WORKER_PROVIDER (resolved from the daemon env).
// Pass an explicit value to test model resolution under a different provider.
export const listMergedWorkers = (
  stateDir: string,
  activeProvider: ProviderName = WORKER_PROVIDER,
): Worker[] => {
  const registered = loadWorkerRegistry(stateDir)
  const byName = new Map(registered.map((d) => [d.name, d]))
  const defaultNames = new Set(Object.keys(WORKER_CONFIGS))

  // Start with defaults, overriding with registry entries where names match.
  const decls: WorkerDeclaration[] = Object.values(WORKER_CONFIGS).map(
    (c) => byName.get(c.name) ?? configToDeclaration(c),
  )

  // Append registry entries whose names are not in the defaults.
  for (const decl of registered) {
    if (!defaultNames.has(decl.name)) {
      decls.push(decl)
    }
  }

  return decls.map((d) => declarationToWorker(d, activeProvider))
}

// Returns workers with display metadata — tier, resolved model, and any
// model-override conflicts. Used by mars worker list to render the full table.
export const listWorkersForDisplay = (
  stateDir: string,
  activeProvider: ProviderName = WORKER_PROVIDER,
): WorkerDisplayEntry[] => {
  const registered = loadWorkerRegistry(stateDir)
  const byName = new Map(registered.map((d) => [d.name, d]))
  const defaultNames = new Set(Object.keys(WORKER_CONFIGS))

  const decls: WorkerDeclaration[] = Object.values(WORKER_CONFIGS).map(
    (c) => byName.get(c.name) ?? configToDeclaration(c),
  )
  for (const decl of registered) {
    if (!defaultNames.has(decl.name)) {
      decls.push(decl)
    }
  }

  return decls.map((decl) => {
    const providerName = effectiveProvider(decl, activeProvider)
    const { model, conflict } = resolveModel(decl, providerName)
    const worker = createWorker({
      name: decl.name,
      model,
      modelTier: decl.modelTier,
      ...(decl.fallbackModel !== undefined ? { fallbackModel: decl.fallbackModel } : {}),
      effort: decl.effort,
      permissionMode: decl.permissionMode,
      bare: decl.bare,
      disallowedTools: [...decl.disallowedTools],
      outputFormat: decl.outputFormat,
      maxContextTokens: 0,
      runtime: decl.runtime,
      provider: providerName,
      ...(decl.tags !== undefined ? { tags: [...decl.tags] } : {}),
    })
    return {
      worker,
      modelTier: decl.modelTier,
      resolvedModel: model,
      activeProvider: providerName,
      ...(conflict !== undefined ? { conflictingOverride: conflict } : {}),
      isBuiltIn: defaultNames.has(decl.name),
    }
  })
}

// Remove an operator-added Worker declaration from the registry file. Refuses
// to remove built-in workers (those shipped as hard-coded defaults in
// WORKER_CONFIGS). Throws if the name is not found in the registry or if the
// worker is a built-in.
//
// Returns the names of operator-added workers that remain after removal —
// useful for building error messages in callers that want to list valid names.
export const removeWorkerFromRegistry = (
  stateDir: string,
  name: string,
): void => {
  const filePath = resolve(stateDir, REGISTRY_FILENAME)
  const builtInNames = new Set(Object.keys(WORKER_CONFIGS))

  // Refuse to remove built-in workers.
  if (builtInNames.has(name)) {
    const operatorNames = existsSync(filePath)
      ? Object.keys(
          JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>,
        ).filter((n) => !builtInNames.has(n))
      : []
    const hint =
      operatorNames.length > 0
        ? ` Operator-added workers that can be removed: ${operatorNames.join(', ')}.`
        : ' No operator-added workers are registered.'
    throw new Error(
      `'${name}' is a built-in worker and cannot be removed.${hint}`,
    )
  }

  // Registry must exist and contain the worker.
  if (!existsSync(filePath)) {
    throw new Error(
      `worker '${name}' not found — no registry file exists. No operator-added workers are registered.`,
    )
  }

  const existing = JSON.parse(readFileSync(filePath, 'utf8')) as Record<
    string,
    WorkerDeclaration
  >

  if (!(name in existing)) {
    const operatorNames = Object.keys(existing).filter(
      (n) => !builtInNames.has(n),
    )
    const hint =
      operatorNames.length > 0
        ? `valid operator-added workers: ${operatorNames.join(', ')}`
        : 'no operator-added workers are registered'
    throw new Error(`unknown worker '${name}'; ${hint}`)
  }

  delete existing[name]
  writeFileSync(filePath, JSON.stringify(existing, null, 2) + '\n', 'utf8')
}

// Add or update a Worker declaration in the registry file. Seeds the registry
// from the hard-coded defaults on the first write so the file is always a
// complete view of all known workers.
export const addWorkerToRegistry = (
  stateDir: string,
  decl: WorkerDeclaration,
): void => {
  const filePath = resolve(stateDir, REGISTRY_FILENAME)

  let existing: Record<string, WorkerDeclaration>
  if (existsSync(filePath)) {
    existing = JSON.parse(readFileSync(filePath, 'utf8')) as Record<
      string,
      WorkerDeclaration
    >
  } else {
    // Seed from hard-coded defaults on first write.
    existing = {}
    for (const config of Object.values(WORKER_CONFIGS)) {
      existing[config.name] = configToDeclaration(config)
    }
  }

  existing[decl.name] = decl
  writeFileSync(filePath, JSON.stringify(existing, null, 2) + '\n', 'utf8')
}
