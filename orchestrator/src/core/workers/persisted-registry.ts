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
import type { ProviderName } from './provider-types'
import { PROVIDERS } from './providers'

// A Worker declaration as stored in the registry file. Same shape as
// WorkerConfig but name is a plain string — not constrained to the built-in
// WorkerName union — to allow operator-defined workers beyond the five
// shipped defaults.
export interface WorkerDeclaration {
  readonly name: string
  readonly model: string
  readonly fallbackModel?: string
  readonly effort: ClaudeEffort
  readonly permissionMode: ClaudePermissionMode
  readonly bare: boolean
  readonly disallowedTools: readonly string[]
  readonly outputFormat: ClaudeOutputFormat
  readonly runtime: WorkerRuntime
  // Which agent CLI this Worker drives. Defaults to 'claude' when absent for
  // backwards-compat with pre-provider registry entries.
  readonly provider?: ProviderName
  // Free-form list of routing tags. pickWorkerForTags routes a task to this
  // Worker when the task's tag list intersects this set. Any string is valid;
  // well-known values mirror the built-in Worker names (e.g. 'coder',
  // 'planner', 'slicer', 'triager', 'fixer'). Operator-defined Workers should
  // use domain-specific tags (e.g. 'scaffold', 'docs') that do not collide
  // with built-in tags unless the intent is to override a built-in route.
  readonly tags?: readonly string[]
}

const REGISTRY_FILENAME = 'worker-registry.json'

// Load the persisted Worker registry from stateDir. Returns the declarations
// stored in the registry file, or an empty array when the file is absent.
// Throws if any declaration specifies a provider not in the PROVIDERS registry.
export const loadWorkerRegistry = (stateDir: string): WorkerDeclaration[] => {
  const filePath = resolve(stateDir, REGISTRY_FILENAME)
  if (!existsSync(filePath)) return []
  const raw = readFileSync(filePath, 'utf8')
  const parsed = JSON.parse(raw) as Record<string, WorkerDeclaration>
  const knownProviders = Object.keys(PROVIDERS)
  const decls = Object.values(parsed)
  for (const decl of decls) {
    if (decl.provider !== undefined && !knownProviders.includes(decl.provider)) {
      throw new Error(
        `Unknown provider '${decl.provider}' in worker-registry.json — known: ${knownProviders.join(', ')}`,
      )
    }
  }
  return decls
}

// Produce a WorkerDeclaration from a hard-coded WORKER_CONFIGS entry.
// Used when seeding the registry file on first write.
const configToDeclaration = (
  config: (typeof WORKER_CONFIGS)[keyof typeof WORKER_CONFIGS],
): WorkerDeclaration => ({
  name: config.name,
  model: config.model,
  ...(config.fallbackModel !== undefined
    ? { fallbackModel: config.fallbackModel }
    : {}),
  effort: config.effort,
  permissionMode: config.permissionMode,
  bare: config.bare,
  disallowedTools: [...config.disallowedTools],
  outputFormat: config.outputFormat,
  runtime: config.runtime,
  provider: config.provider,
  ...(config.tags !== undefined ? { tags: [...config.tags] } : {}),
})

// Build a Worker from a WorkerDeclaration via createWorker. Missing
// WorkerConfig fields (maxContextTokens, etc.) are filled with safe
// defaults — operator-declared workers in the registry do not carry a
// context budget (0 = disabled). A declaration without its own provider uses
// the active daemon provider, matching built-in Workers.
const declarationToWorker = (decl: WorkerDeclaration): Worker =>
  createWorker({
    name: decl.name,
    model: decl.model,
    ...(decl.fallbackModel !== undefined ? { fallbackModel: decl.fallbackModel } : {}),
    effort: decl.effort,
    permissionMode: decl.permissionMode,
    bare: decl.bare,
    disallowedTools: [...decl.disallowedTools],
    outputFormat: decl.outputFormat,
    maxContextTokens: 0,
    runtime: decl.runtime,
    provider: decl.provider ?? WORKER_PROVIDER,
    ...(decl.tags !== undefined ? { tags: [...decl.tags] } : {}),
  })

// Returns all known Workers: hard-coded defaults merged with registry entries.
// Registry entries override defaults for matching names; novel names from the
// registry are appended after the defaults. When no registry file exists,
// only the hard-coded defaults are returned.
// Each declaration is converted to a fully-constructed Worker via createWorker
// so the result can be passed directly to pickWorkerForTags.
export const listMergedWorkers = (stateDir: string): Worker[] => {
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

  return decls.map(declarationToWorker)
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
