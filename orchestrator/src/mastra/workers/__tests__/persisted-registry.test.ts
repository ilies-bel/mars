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
  loadWorkerRegistry,
  type WorkerDeclaration,
} from '../persisted-registry'
import { WORKER_CONFIGS } from '..'

const MINIMUM_DECL: WorkerDeclaration = {
  name: 'TestWorker',
  model: 'claude-sonnet-4-6',
  effort: 'high',
  permissionMode: 'default',
  bare: false,
  disallowedTools: [],
  outputFormat: 'stream-json',
  maxMessages: 0,
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

  it('round-trips the model field correctly', () => {
    addWorkerToRegistry(stateDir, {
      ...MINIMUM_DECL,
      name: 'RoundTripWorker',
      model: 'claude-opus-4-7',
    })
    const loaded = loadWorkerRegistry(stateDir)
    const found = loaded.find((d) => d.name === 'RoundTripWorker')
    expect(found?.model).toBe('claude-opus-4-7')
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
      model: 'claude-opus-4-7',
      maxMessages: 50,
    }
    addWorkerToRegistry(stateDir, decl)
    const loaded = loadWorkerRegistry(stateDir)
    const found = loaded.find((d) => d.name === 'NewlyAddedWorker')
    expect(found?.model).toBe('claude-opus-4-7')
    expect(found?.maxMessages).toBe(50)
  })

  it('overwrites an existing entry when called again with the same name', () => {
    addWorkerToRegistry(stateDir, { ...MINIMUM_DECL, name: 'Mutable' })
    addWorkerToRegistry(stateDir, {
      ...MINIMUM_DECL,
      name: 'Mutable',
      model: 'claude-opus-4-7',
    })
    const loaded = loadWorkerRegistry(stateDir)
    const found = loaded.filter((d) => d.name === 'Mutable')
    // Exactly one entry — no duplicates.
    expect(found).toHaveLength(1)
    expect(found[0]?.model).toBe('claude-opus-4-7')
  })

  it('does not re-seed defaults on the second write when file already exists', () => {
    addWorkerToRegistry(stateDir, { ...MINIMUM_DECL, name: 'First' })
    // Manually tweak the Coder model in the file after first seed.
    const filePath = resolve(stateDir, 'worker-registry.json')
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Record<
      string,
      WorkerDeclaration
    >
    raw['Coder'] = {
      ...(raw['Coder'] as WorkerDeclaration),
      model: 'custom-coder-model',
    }
    writeFileSync(filePath, JSON.stringify(raw, null, 2) + '\n', 'utf8')

    // Second add should NOT re-seed (would overwrite our custom-coder-model).
    addWorkerToRegistry(stateDir, { ...MINIMUM_DECL, name: 'Second' })
    const loaded = loadWorkerRegistry(stateDir)
    const coder = loaded.find((d) => d.name === 'Coder')
    expect(coder?.model).toBe('custom-coder-model')
  })
})

// ---------------------------------------------------------------------------
// listMergedWorkers
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
    const coder = workers.find((w) => w.name === 'Coder')
    const planner = workers.find((w) => w.name === 'Planner')
    const slicer = workers.find((w) => w.name === 'Slicer')
    const triager = workers.find((w) => w.name === 'Triager')
    const fixer = workers.find((w) => w.name === 'Fixer')
    expect(coder?.tags).toContain('coder')
    expect(planner?.tags).toContain('planner')
    expect(slicer?.tags).toContain('slicer')
    expect(triager?.tags).toContain('triager')
    expect(fixer?.tags).toContain('fixer')
  })
})

describe('listMergedWorkers', () => {
  it('returns exactly the five default workers when no registry file exists', () => {
    const workers = listMergedWorkers(stateDir)
    const names = workers.map((w) => w.name)
    expect(names).toContain('Coder')
    expect(names).toContain('Planner')
    expect(names).toContain('Slicer')
    expect(names).toContain('Triager')
    expect(names).toContain('Fixer')
    expect(workers).toHaveLength(5)
  })

  it('includes a novel registry worker alongside the defaults', () => {
    addWorkerToRegistry(stateDir, {
      ...MINIMUM_DECL,
      name: 'NovelWorker',
    })
    const workers = listMergedWorkers(stateDir)
    expect(workers.some((w) => w.name === 'NovelWorker')).toBe(true)
    // All five defaults still present.
    expect(workers.some((w) => w.name === 'Coder')).toBe(true)
    expect(workers.length).toBeGreaterThan(5)
  })

  it('a registry entry for a default name overrides the default', () => {
    // Seed first so Coder is in the registry, then overwrite it.
    addWorkerToRegistry(stateDir, MINIMUM_DECL) // triggers seed
    addWorkerToRegistry(stateDir, {
      ...MINIMUM_DECL,
      name: 'Coder',
      model: 'registry-overridden-model',
    })
    const workers = listMergedWorkers(stateDir)
    const coder = workers.find((w) => w.name === 'Coder')
    expect(coder?.model).toBe('registry-overridden-model')
  })

  it('does not duplicate the default when the registry contains a matching entry', () => {
    addWorkerToRegistry(stateDir, { ...MINIMUM_DECL, name: 'Coder' })
    const workers = listMergedWorkers(stateDir)
    const coderEntries = workers.filter((w) => w.name === 'Coder')
    expect(coderEntries).toHaveLength(1)
  })
})
