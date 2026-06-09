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
  type ClaudeOutputFormat,
  type WorkerRuntime,
} from './index'

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
export const loadWorkerRegistry = (stateDir: string): WorkerDeclaration[] => {
  const filePath = resolve(stateDir, REGISTRY_FILENAME)
  if (!existsSync(filePath)) return []
  const raw = readFileSync(filePath, 'utf8')
  const parsed = JSON.parse(raw) as Record<string, WorkerDeclaration>
  return Object.values(parsed)
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
  ...(config.tags !== undefined ? { tags: [...config.tags] } : {}),
})

// Returns all known Workers: hard-coded defaults merged with registry entries.
// Registry entries override defaults for matching names; novel names from the
// registry are appended after the defaults. When no registry file exists,
// only the hard-coded defaults are returned.
export const listMergedWorkers = (stateDir: string): WorkerDeclaration[] => {
  const registered = loadWorkerRegistry(stateDir)
  const byName = new Map(registered.map((d) => [d.name, d]))
  const defaultNames = new Set(Object.keys(WORKER_CONFIGS))

  // Start with defaults, overriding with registry entries where names match.
  const result: WorkerDeclaration[] = Object.values(WORKER_CONFIGS).map(
    (c) => byName.get(c.name) ?? configToDeclaration(c),
  )

  // Append registry entries whose names are not in the defaults.
  for (const decl of registered) {
    if (!defaultNames.has(decl.name)) {
      result.push(decl)
    }
  }

  return result
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
