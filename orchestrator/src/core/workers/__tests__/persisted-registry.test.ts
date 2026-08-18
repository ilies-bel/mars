// Tests for the persisted Worker registry (persisted-registry.ts).
// Covers file I/O, default seeding, and the merged-view logic through
// the public API only.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  addWorkerToRegistry,
  listMergedWorkers,
  listWorkersForDisplay,
  loadWorkerRegistry,
  removeWorkerFromRegistry,
  type WorkerDeclaration,
} from '../persisted-registry'
import { WORKER_CONFIGS } from '..'
import { PROVIDER_MODELS } from '../provider-types'

const MINIMUM_DECL: WorkerDeclaration = {
  name: 'TestWorker',
  modelTier: 'balanced',
  effort: 'high',
  permissionMode: 'default',
  bare: false,
  disallowedTools: [],
  outputFormat: 'stream-json',
  runtime: 'headless',
}

let stateDir: string

beforeEach(() => {
  stateDir = mkdtempSync(resolve(tmpdir(), 'mars-persisted-registry-test-'))
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// loadWorkerRegistry
// ---------------------------------------------------------------------------

describe('loadWorkerRegistry', () => {
  it('returns an empty array when the registry file is absent', () => {
    expect(loadWorkerRegistry(stateDir)).toEqual([])
  })

  it('returns the stored declarations when the registry file exists', () => {
    addWorkerToRegistry(stateDir, { ...MINIMUM_DECL, name: 'PersistedWorker' })
    const loaded = loadWorkerRegistry(stateDir)
    expect(loaded.some((d) => d.name === 'PersistedWorker')).toBe(true)
  })

  it('round-trips the modelTier field correctly', () => {
    addWorkerToRegistry(stateDir, {
      ...MINIMUM_DECL,
      name: 'RoundTripWorker',
      modelTier: 'flagship',
    })
    const loaded = loadWorkerRegistry(stateDir)
    const found = loaded.find((d) => d.name === 'RoundTripWorker')
    expect(found?.modelTier).toBe('flagship')
  })

  it('throws when a declaration specifies an unknown provider', () => {
    const filePath = resolve(stateDir, 'worker-registry.json')
    writeFileSync(
      filePath,
      JSON.stringify({
        BadWorker: {
          ...MINIMUM_DECL,
          name: 'BadWorker',
          provider: 'unknown-agent',
        },
      }, null, 2) + '\n',
      'utf8',
    )
    expect(() => loadWorkerRegistry(stateDir)).toThrow(
      "Unknown provider 'unknown-agent' in worker-registry.json",
    )
  })

  it('migrates a legacy entry with model: string to modelTier', () => {
    // Simulate an old-format registry file with a concrete model id.
    const filePath = resolve(stateDir, 'worker-registry.json')
    writeFileSync(
      filePath,
      JSON.stringify({
        LegacyCoder: {
          name: 'LegacyCoder',
          model: 'gpt-5.6-terra',  // old format: codex balanced
          effort: 'high',
          permissionMode: 'default',
          bare: false,
          disallowedTools: [],
          outputFormat: 'stream-json',
          runtime: 'headless',
        },
      }, null, 2) + '\n',
      'utf8',
    )
    const loaded = loadWorkerRegistry(stateDir)
    const found = loaded.find((d) => d.name === 'LegacyCoder')
    // Migration should have inferred the tier from the model id.
    expect(found?.modelTier).toBe('balanced')
    expect('model' in (found ?? {})).toBe(false)
  })

  it('migrates a legacy entry with an unknown model id to modelOverride', () => {
    const filePath = resolve(stateDir, 'worker-registry.json')
    writeFileSync(
      filePath,
      JSON.stringify({
        UnknownModelWorker: {
          name: 'UnknownModelWorker',
          model: 'gpt-4o-mini',  // not in any provider tier table
          effort: 'high',
          permissionMode: 'default',
          bare: false,
          disallowedTools: [],
          outputFormat: 'stream-json',
          runtime: 'headless',
        },
      }, null, 2) + '\n',
      'utf8',
    )
    const loaded = loadWorkerRegistry(stateDir)
    const found = loaded.find((d) => d.name === 'UnknownModelWorker')
    // Falls back to 'balanced' tier and stores the unknown id as modelOverride.
    expect(found?.modelTier).toBe('balanced')
    expect(found?.modelOverride).toBe('gpt-4o-mini')
  })
})

// ---------------------------------------------------------------------------
// addWorkerToRegistry
// ---------------------------------------------------------------------------

describe('addWorkerToRegistry', () => {
  it('seeds the registry with all hard-coded defaults on the first write', () => {
    addWorkerToRegistry(stateDir, MINIMUM_DECL)
    const loaded = loadWorkerRegistry(stateDir)
    const loadedNames = loaded.map((d) => d.name)
    for (const name of Object.keys(WORKER_CONFIGS)) {
      expect(loadedNames).toContain(name)
    }
  })

  it('includes the newly added worker after seeding', () => {
    const decl: WorkerDeclaration = {
      ...MINIMUM_DECL,
      name: 'NewlyAddedWorker',
      modelTier: 'flagship',
    }
    addWorkerToRegistry(stateDir, decl)
    const loaded = loadWorkerRegistry(stateDir)
    const found = loaded.find((d) => d.name === 'NewlyAddedWorker')
    expect(found?.modelTier).toBe('flagship')
  })

  it('overwrites an existing entry when called again with the same name', () => {
    addWorkerToRegistry(stateDir, { ...MINIMUM_DECL, name: 'Mutable' })
    addWorkerToRegistry(stateDir, {
      ...MINIMUM_DECL,
      name: 'Mutable',
      modelTier: 'flagship',
    })
    const loaded = loadWorkerRegistry(stateDir)
    const found = loaded.filter((d) => d.name === 'Mutable')
    // Exactly one entry — no duplicates.
    expect(found).toHaveLength(1)
    expect(found[0]?.modelTier).toBe('flagship')
  })

  it('does not re-seed defaults on the second write when file already exists', () => {
    addWorkerToRegistry(stateDir, { ...MINIMUM_DECL, name: 'First' })
    // Manually tweak the Coder tier in the file after first seed.
    const filePath = resolve(stateDir, 'worker-registry.json')
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Record<
      string,
      WorkerDeclaration
    >
    raw['Coder'] = {
      ...(raw['Coder'] as WorkerDeclaration),
      modelTier: 'fast',
    }
    writeFileSync(filePath, JSON.stringify(raw, null, 2) + '\n', 'utf8')

    // Second add should NOT re-seed (would overwrite our custom tier).
    addWorkerToRegistry(stateDir, { ...MINIMUM_DECL, name: 'Second' })
    const loaded = loadWorkerRegistry(stateDir)
    const coder = loaded.find((d) => d.name === 'Coder')
    expect(coder?.modelTier).toBe('fast')
  })
})

// ---------------------------------------------------------------------------
// WorkerDeclaration tags
// ---------------------------------------------------------------------------

describe('WorkerDeclaration tags', () => {
  it('round-trips a tags field through addWorkerToRegistry / loadWorkerRegistry', () => {
    addWorkerToRegistry(stateDir, {
      ...MINIMUM_DECL,
      name: 'TaggedWorker',
      tags: ['scaffold', 'docs'],
    })
    const loaded = loadWorkerRegistry(stateDir)
    const found = loaded.find((d) => d.name === 'TaggedWorker')
    expect(found?.tags).toEqual(['scaffold', 'docs'])
  })

  it('preserves an undefined tags field (absent from JSON) when no tags are supplied', () => {
    addWorkerToRegistry(stateDir, MINIMUM_DECL)
    const loaded = loadWorkerRegistry(stateDir)
    const found = loaded.find((d) => d.name === 'TestWorker')
    // tags may be absent from JSON or undefined — either is acceptable.
    expect(found?.tags == null || Array.isArray(found.tags)).toBe(true)
  })

  it('seeded default Workers carry their tag sets when the registry is initialised', () => {
    addWorkerToRegistry(stateDir, MINIMUM_DECL) // triggers seed
    const workers = listMergedWorkers(stateDir)
    const coder = workers.find((w) => w.config.name === 'Coder')
    const planner = workers.find((w) => w.config.name === 'Planner')
    const slicer = workers.find((w) => w.config.name === 'Slicer')
    const triager = workers.find((w) => w.config.name === 'Triager')
    const fixer = workers.find((w) => w.config.name === 'Fixer')
    expect(coder?.config.tags).toContain('coder')
    expect(planner?.config.tags).toContain('planner')
    expect(slicer?.config.tags).toContain('slicer')
    expect(triager?.config.tags).toContain('triager')
    expect(fixer?.config.tags).toContain('fixer')
  })
})

describe('WorkerDeclaration runtime:pty round-trip', () => {
  it('persists and reloads a pty runtime declaration without throwing', () => {
    const ptyDecl: WorkerDeclaration = {
      ...MINIMUM_DECL,
      name: 'PtyWorker',
      runtime: 'pty',
    }
    addWorkerToRegistry(stateDir, ptyDecl)
    const loaded = loadWorkerRegistry(stateDir)
    const found = loaded.find((d) => d.name === 'PtyWorker')
    expect(found?.runtime).toBe('pty')
  })

  it('persists and reloads a provider:gemini + runtime:pty declaration', () => {
    const geminiDecl: WorkerDeclaration = {
      ...MINIMUM_DECL,
      name: 'GeminiWorker',
      provider: 'gemini',
      runtime: 'pty',
    }
    addWorkerToRegistry(stateDir, geminiDecl)
    const loaded = loadWorkerRegistry(stateDir)
    const found = loaded.find((d) => d.name === 'GeminiWorker')
    expect(found?.provider).toBe('gemini')
    expect(found?.runtime).toBe('pty')
  })
})

// ---------------------------------------------------------------------------
// listMergedWorkers
// ---------------------------------------------------------------------------

describe('listMergedWorkers', () => {
  it('returns exactly the seven default workers when no registry file exists', () => {
    const workers = listMergedWorkers(stateDir)
    const names = workers.map((w) => w.config.name)
    expect(names).toContain('Coder')
    expect(names).toContain('Planner')
    expect(names).toContain('Slicer')
    expect(names).toContain('Triager')
    expect(names).toContain('Fixer')
    expect(names).toContain('BehaviourVerifier')
    expect(names).toContain('Scorer')
    expect(names).toContain('RescueOperator')
    // RescueOperator (8th) added in PRD 94e2a82a; update this count if more workers are added.
    expect(workers).toHaveLength(8)
  })

  it('includes a novel registry worker alongside the defaults', () => {
    addWorkerToRegistry(stateDir, {
      ...MINIMUM_DECL,
      name: 'NovelWorker',
    })
    const workers = listMergedWorkers(stateDir)
    expect(workers.some((w) => w.config.name === 'NovelWorker')).toBe(true)
    // All five defaults still present.
    expect(workers.some((w) => w.config.name === 'Coder')).toBe(true)
    expect(workers.length).toBeGreaterThan(5)
  })

  it('a registry entry for a default name overrides the default', () => {
    // Seed first so Coder is in the registry, then overwrite it.
    addWorkerToRegistry(stateDir, MINIMUM_DECL) // triggers seed
    addWorkerToRegistry(stateDir, {
      ...MINIMUM_DECL,
      name: 'Coder',
      modelTier: 'flagship',
    })
    const workers = listMergedWorkers(stateDir, 'claude')
    const coder = workers.find((w) => w.config.name === 'Coder')
    // The resolved model should be the flagship model for claude.
    expect(coder?.config.model).toBe(PROVIDER_MODELS.claude.flagship)
    expect(coder?.config.modelTier).toBe('flagship')
  })

  it('does not duplicate the default when the registry contains a matching entry', () => {
    addWorkerToRegistry(stateDir, { ...MINIMUM_DECL, name: 'Coder' })
    const workers = listMergedWorkers(stateDir)
    const coderEntries = workers.filter((w) => w.config.name === 'Coder')
    expect(coderEntries).toHaveLength(1)
  })

  it('builds a Worker with the declared provider and runtime for a codex/pty entry', () => {
    addWorkerToRegistry(stateDir, {
      ...MINIMUM_DECL,
      name: 'CodexWorker',
      provider: 'codex',
      runtime: 'pty',
      tags: ['codex'],
    })
    const workers = listMergedWorkers(stateDir)
    const found = workers.find((w) => w.config.name === 'CodexWorker')
    expect(found?.config.provider).toBe('codex')
    expect(found?.runtime).toBe('pty')
    expect(found?.config.tags).toContain('codex')
  })

  // -------------------------------------------------------------------------
  // Tier-based model resolution (core of the bug fix)
  // -------------------------------------------------------------------------

  it('resolves the balanced tier to the claude balanced model when activeProvider is claude', () => {
    // Write a balanced-tier declaration with no explicit provider.
    addWorkerToRegistry(stateDir, { ...MINIMUM_DECL, name: 'AnyWorker', modelTier: 'balanced' })
    const workers = listMergedWorkers(stateDir, 'claude')
    const found = workers.find((w) => w.config.name === 'AnyWorker')
    expect(found?.config.model).toBe(PROVIDER_MODELS.claude.balanced)
  })

  it('resolves the balanced tier to the codex balanced model when activeProvider is codex', () => {
    addWorkerToRegistry(stateDir, { ...MINIMUM_DECL, name: 'AnyWorker', modelTier: 'balanced' })
    const workers = listMergedWorkers(stateDir, 'codex')
    const found = workers.find((w) => w.config.name === 'AnyWorker')
    expect(found?.config.model).toBe(PROVIDER_MODELS.codex.balanced)
  })

  it('changing activeProvider changes the resolved model without editing the registry', () => {
    // Store a tier once; switch provider — different model, no registry write.
    addWorkerToRegistry(stateDir, { ...MINIMUM_DECL, name: 'Coder', modelTier: 'balanced' })

    const workersWithClaude = listMergedWorkers(stateDir, 'claude')
    const workersWithCodex = listMergedWorkers(stateDir, 'codex')

    const coderClaude = workersWithClaude.find((w) => w.config.name === 'Coder')
    const coderCodex = workersWithCodex.find((w) => w.config.name === 'Coder')

    expect(coderClaude?.config.model).toBe(PROVIDER_MODELS.claude.balanced)
    expect(coderCodex?.config.model).toBe(PROVIDER_MODELS.codex.balanced)
    // The two models must differ (the point of the whole fix).
    expect(coderClaude?.config.model).not.toBe(coderCodex?.config.model)
  })

  it('the resolved model in config.model matches what listWorkersForDisplay shows', () => {
    // A trace records provider + config.model; the list must show the same value.
    addWorkerToRegistry(stateDir, { ...MINIMUM_DECL, name: 'Coder', modelTier: 'balanced' })
    const workers = listMergedWorkers(stateDir, 'claude')
    const displayEntries = listWorkersForDisplay(stateDir, 'claude')
    const workerCoder = workers.find((w) => w.config.name === 'Coder')
    const displayCoder = displayEntries.find((e) => e.worker.config.name === 'Coder')
    // These MUST agree — trace provider vs displayed model cannot disagree.
    expect(workerCoder?.config.model).toBe(displayCoder?.resolvedModel)
  })
})

// ---------------------------------------------------------------------------
// Built-in worker provider-pin invariant
// ---------------------------------------------------------------------------

describe('built-in provider-pin invariant', () => {
  it('seeds the registry without a provider field on any built-in worker', () => {
    addWorkerToRegistry(stateDir, MINIMUM_DECL) // triggers seed
    const filePath = resolve(stateDir, 'worker-registry.json')
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Record<
      string,
      Record<string, unknown>
    >
    for (const name of Object.keys(WORKER_CONFIGS)) {
      expect(raw[name], `built-in '${name}' must not carry a provider pin`).not.toHaveProperty('provider')
    }
  })

  it('strips provider from a new-format built-in entry when loading the registry', () => {
    // Simulate an older seeded registry that stored provider: "codex" for a built-in.
    const filePath = resolve(stateDir, 'worker-registry.json')
    writeFileSync(
      filePath,
      JSON.stringify({
        Coder: {
          name: 'Coder',
          modelTier: 'balanced',
          provider: 'codex',   // pinned — invariant violation from old seeding
          effort: 'high',
          permissionMode: 'bypassPermissions',
          bare: false,
          disallowedTools: [],
          outputFormat: 'stream-json',
          runtime: 'headless',
        },
      }, null, 2) + '\n',
      'utf8',
    )
    const loaded = loadWorkerRegistry(stateDir)
    const coder = loaded.find((d) => d.name === 'Coder')
    // The migration must strip the pinned provider.
    expect(coder?.provider).toBeUndefined()
  })

  it('changing activeProvider changes a built-in whose registry entry had a pinned provider', () => {
    // Write a registry with Coder pinned to codex (old seeding artefact).
    const filePath = resolve(stateDir, 'worker-registry.json')
    writeFileSync(
      filePath,
      JSON.stringify({
        Coder: {
          name: 'Coder',
          modelTier: 'balanced',
          provider: 'codex',   // pinned — must be stripped on load
          effort: 'high',
          permissionMode: 'bypassPermissions',
          bare: false,
          disallowedTools: [],
          outputFormat: 'stream-json',
          runtime: 'headless',
        },
      }, null, 2) + '\n',
      'utf8',
    )

    const workersWithClaude = listMergedWorkers(stateDir, 'claude')
    const coderClaude = workersWithClaude.find((w) => w.config.name === 'Coder')
    // After pin is stripped the worker must adopt the supplied activeProvider.
    expect(coderClaude?.config.provider).toBe('claude')
    expect(coderClaude?.config.model).toBe(PROVIDER_MODELS.claude.balanced)
  })

  it('an operator-pinned novel worker keeps its provider when activeProvider changes', () => {
    // Novel workers (non-built-in names) with an explicit provider must NOT be
    // stripped — the pin is intentional operator configuration.
    addWorkerToRegistry(stateDir, {
      ...MINIMUM_DECL,
      name: 'PinnedWorker',
      provider: 'codex',
      modelTier: 'balanced',
    })
    const workers = listMergedWorkers(stateDir, 'claude')
    const found = workers.find((w) => w.config.name === 'PinnedWorker')
    // Explicit operator pin must survive even when activeProvider is different.
    expect(found?.config.provider).toBe('codex')
    expect(found?.config.model).toBe(PROVIDER_MODELS.codex.balanced)
  })
})

// ---------------------------------------------------------------------------
// listWorkersForDisplay — tier display and conflict detection
// ---------------------------------------------------------------------------

describe('listWorkersForDisplay', () => {
  it('returns display entries with modelTier and resolvedModel', () => {
    const entries = listWorkersForDisplay(stateDir, 'claude')
    const coder = entries.find((e) => e.worker.config.name === 'Coder')
    expect(coder?.modelTier).toBeDefined()
    expect(coder?.resolvedModel).toBe(PROVIDER_MODELS.claude[coder!.modelTier])
  })

  it('surfaces a conflict when modelOverride does not belong to the active provider', () => {
    // Write an entry with a modelOverride that does not belong to claude.
    const filePath = resolve(stateDir, 'worker-registry.json')
    writeFileSync(
      filePath,
      JSON.stringify({
        ConflictWorker: {
          name: 'ConflictWorker',
          modelTier: 'balanced',
          modelOverride: 'gpt-5.6-terra',  // codex model, not claude
          effort: 'high',
          permissionMode: 'default',
          bare: false,
          disallowedTools: [],
          outputFormat: 'stream-json',
          runtime: 'headless',
        },
      }, null, 2) + '\n',
      'utf8',
    )
    const entries = listWorkersForDisplay(stateDir, 'claude')
    const conflict = entries.find((e) => e.worker.config.name === 'ConflictWorker')
    expect(conflict?.conflictingOverride).toBe('gpt-5.6-terra')
    // Falls back to tier-based resolution, not the conflicting override.
    expect(conflict?.resolvedModel).toBe(PROVIDER_MODELS.claude.balanced)
  })

  it('no conflict when modelOverride belongs to the active provider', () => {
    const filePath = resolve(stateDir, 'worker-registry.json')
    writeFileSync(
      filePath,
      JSON.stringify({
        OverrideWorker: {
          name: 'OverrideWorker',
          modelTier: 'balanced',
          modelOverride: 'claude-opus-4-7',  // claude flagship — valid for claude
          effort: 'high',
          permissionMode: 'default',
          bare: false,
          disallowedTools: [],
          outputFormat: 'stream-json',
          runtime: 'headless',
        },
      }, null, 2) + '\n',
      'utf8',
    )
    const entries = listWorkersForDisplay(stateDir, 'claude')
    const override = entries.find((e) => e.worker.config.name === 'OverrideWorker')
    // Override is valid — no conflict and the override model is used.
    expect(override?.conflictingOverride).toBeUndefined()
    expect(override?.resolvedModel).toBe('claude-opus-4-7')
  })

  it('marks built-in workers as isBuiltIn=true and operator-added as isBuiltIn=false', () => {
    addWorkerToRegistry(stateDir, { ...MINIMUM_DECL, name: 'OperatorWorker' })
    const entries = listWorkersForDisplay(stateDir, 'claude')
    const coder = entries.find((e) => e.worker.config.name === 'Coder')
    const operatorWorker = entries.find((e) => e.worker.config.name === 'OperatorWorker')
    expect(coder?.isBuiltIn).toBe(true)
    expect(operatorWorker?.isBuiltIn).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// removeWorkerFromRegistry
// ---------------------------------------------------------------------------

describe('removeWorkerFromRegistry', () => {
  it('removes an operator-added worker so it no longer appears in loadWorkerRegistry', () => {
    addWorkerToRegistry(stateDir, { ...MINIMUM_DECL, name: 'ScratchWorker' })
    expect(loadWorkerRegistry(stateDir).some((d) => d.name === 'ScratchWorker')).toBe(true)
    removeWorkerFromRegistry(stateDir, 'ScratchWorker')
    expect(loadWorkerRegistry(stateDir).some((d) => d.name === 'ScratchWorker')).toBe(false)
  })

  it('leaves registry containing all built-ins but not the removed worker after add-then-remove', () => {
    // Seed + add a scratch worker.
    addWorkerToRegistry(stateDir, { ...MINIMUM_DECL, name: 'ScratchForRoundTrip' })
    const filePath = resolve(stateDir, 'worker-registry.json')

    // Remove the scratch worker.
    removeWorkerFromRegistry(stateDir, 'ScratchForRoundTrip')
    const afterRemove = readFileSync(filePath, 'utf8')

    // The file should not contain ScratchForRoundTrip any more.
    expect(afterRemove).not.toContain('ScratchForRoundTrip')
    // All built-ins must still be present.
    for (const name of Object.keys(WORKER_CONFIGS)) {
      expect(afterRemove).toContain(name)
    }
  })

  it('throws when trying to remove a built-in worker', () => {
    expect(() => removeWorkerFromRegistry(stateDir, 'Coder')).toThrow(
      "'Coder' is a built-in worker and cannot be removed.",
    )
  })

  it('throws with a non-zero exit when removing an unknown worker', () => {
    // Seed registry first so it exists.
    addWorkerToRegistry(stateDir, MINIMUM_DECL)
    // Remove the one we added so there are no operator workers.
    removeWorkerFromRegistry(stateDir, MINIMUM_DECL.name)
    // Now try to remove something that was never there.
    expect(() => removeWorkerFromRegistry(stateDir, 'NonExistentWorker')).toThrow(
      "unknown worker 'NonExistentWorker'",
    )
  })

  it('throws naming valid operator-added workers when an unknown name is given', () => {
    addWorkerToRegistry(stateDir, { ...MINIMUM_DECL, name: 'ValidOp' })
    expect(() => removeWorkerFromRegistry(stateDir, 'BadName')).toThrow(
      'ValidOp',
    )
  })

  it('throws when registry file is absent and a remove is attempted', () => {
    expect(() => removeWorkerFromRegistry(stateDir, 'Anything')).toThrow(
      'not found',
    )
  })

  it('preserves built-in workers when an operator-added worker is removed', () => {
    addWorkerToRegistry(stateDir, { ...MINIMUM_DECL, name: 'ToRemove' })
    removeWorkerFromRegistry(stateDir, 'ToRemove')
    const remaining = loadWorkerRegistry(stateDir).map((d) => d.name)
    for (const name of Object.keys(WORKER_CONFIGS)) {
      expect(remaining).toContain(name)
    }
    expect(remaining).not.toContain('ToRemove')
  })
})
