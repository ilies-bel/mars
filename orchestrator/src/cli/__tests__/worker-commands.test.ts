// CLI acceptance tests for `mars worker list` and `mars worker add`.
// These verify observable behaviour: stdout/exit code/file artifacts.

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// src/cli/__tests__ -> src/cli -> src -> orchestrator
const projectRoot = resolve(here, '..', '..', '..')
const cliEntry = resolve(projectRoot, 'src', 'cli.ts')
const tsxBin = resolve(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')

const runCli = (
  args: readonly string[],
  env?: Record<string, string>,
): SpawnSyncReturns<string> =>
  spawnSync(process.execPath, [tsxBin, cliEntry, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 15_000,
  })

let tmpRepo: string

beforeEach(() => {
  tmpRepo = mkdtempSync(resolve(tmpdir(), 'mars-worker-cmd-test-'))
})
afterEach(() => {
  rmSync(tmpRepo, { recursive: true, force: true })
})

const ENV = (): Record<string, string> => ({ MARS_REPO: tmpRepo })

// ---------------------------------------------------------------------------
// mars worker list
// ---------------------------------------------------------------------------

describe('mars worker list', () => {
  it('exits 0', () => {
    const result = runCli(['worker', 'list'], ENV())
    expect(result.status).toBe(0)
  })

  it('prints the five built-in worker names', () => {
    const result = runCli(['worker', 'list'], ENV())
    expect(result.stdout).toContain('Coder')
    expect(result.stdout).toContain('Planner')
    expect(result.stdout).toContain('Slicer')
    expect(result.stdout).toContain('Triager')
    expect(result.stdout).toContain('Fixer')
  })

  it('prints model identifiers for the built-in workers', () => {
    const result = runCli(['worker', 'list'], ENV())
    expect(result.stdout).toContain('claude-sonnet-4-6')
    expect(result.stdout).toContain('claude-opus-4-8')
  })

  it('shows a newly added worker after mars worker add', () => {
    runCli(
      ['worker', 'add', 'ScaffoldWorker', '--model', 'claude-sonnet-4-6'],
      ENV(),
    )
    const result = runCli(['worker', 'list'], ENV())
    expect(result.stdout).toContain('ScaffoldWorker')
  })
})

// ---------------------------------------------------------------------------
// mars worker add
// ---------------------------------------------------------------------------

describe('mars worker add', () => {
  it('exits 0 when name and model are supplied', () => {
    const result = runCli(
      ['worker', 'add', 'MyWorker', '--model', 'claude-sonnet-4-6'],
      ENV(),
    )
    expect(result.status).toBe(0)
  })

  it('prints confirmation that the worker was added', () => {
    const result = runCli(
      ['worker', 'add', 'ConfirmedWorker', '--model', 'claude-sonnet-4-6'],
      ENV(),
    )
    expect(result.stdout).toContain('ConfirmedWorker')
  })

  it('creates the registry file on first write', () => {
    runCli(
      ['worker', 'add', 'FirstWorker', '--model', 'claude-sonnet-4-6'],
      ENV(),
    )
    expect(
      existsSync(resolve(tmpRepo, '.mars', 'worker-registry.json')),
    ).toBe(true)
  })

  it('seeds the registry with hard-coded defaults on first write', () => {
    runCli(
      ['worker', 'add', 'SeedCheck', '--model', 'claude-sonnet-4-6'],
      ENV(),
    )
    const content = readFileSync(
      resolve(tmpRepo, '.mars', 'worker-registry.json'),
      'utf8',
    )
    const registry = JSON.parse(content) as Record<string, unknown>
    expect(registry).toHaveProperty('Coder')
    expect(registry).toHaveProperty('Planner')
    expect(registry).toHaveProperty('Slicer')
    expect(registry).toHaveProperty('Triager')
    expect(registry).toHaveProperty('Fixer')
  })

  it('stores the supplied model in the registry', () => {
    runCli(
      ['worker', 'add', 'ModelCheck', '--model', 'claude-opus-4-7'],
      ENV(),
    )
    const content = readFileSync(
      resolve(tmpRepo, '.mars', 'worker-registry.json'),
      'utf8',
    )
    const registry = JSON.parse(content) as Record<string, { model: string }>
    expect(registry['ModelCheck']?.model).toBe('claude-opus-4-7')
  })

  it('exits 1 with usage message when --model is omitted', () => {
    const result = runCli(['worker', 'add', 'NoModel'], ENV())
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('usage:')
  })

  it('exits 1 with usage message when name and --model are both omitted', () => {
    const result = runCli(['worker', 'add'], ENV())
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('usage:')
  })

  it('respects --effort flag', () => {
    runCli(
      [
        'worker',
        'add',
        'EffortWorker',
        '--model',
        'claude-sonnet-4-6',
        '--effort',
        'medium',
      ],
      ENV(),
    )
    const content = readFileSync(
      resolve(tmpRepo, '.mars', 'worker-registry.json'),
      'utf8',
    )
    const registry = JSON.parse(content) as Record<string, { effort: string }>
    expect(registry['EffortWorker']?.effort).toBe('medium')
  })

  it('exits 1 with error when --effort has an invalid value', () => {
    const result = runCli(
      [
        'worker',
        'add',
        'BadEffort',
        '--model',
        'claude-sonnet-4-6',
        '--effort',
        'bogus',
      ],
      ENV(),
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('effort')
  })

  it('stores a single --tag in the registry', () => {
    runCli(
      ['worker', 'add', 'TaggedWorker', '--model', 'claude-sonnet-4-6', '--tag', 'scaffold'],
      ENV(),
    )
    const content = readFileSync(
      resolve(tmpRepo, '.mars', 'worker-registry.json'),
      'utf8',
    )
    const registry = JSON.parse(content) as Record<string, { tags?: string[] }>
    expect(registry['TaggedWorker']?.tags).toEqual(['scaffold'])
  })

  it('stores multiple --tag flags as an array in the registry', () => {
    runCli(
      [
        'worker', 'add', 'MultiTagWorker',
        '--model', 'claude-sonnet-4-6',
        '--tag', 'scaffold',
        '--tag', 'docs',
      ],
      ENV(),
    )
    const content = readFileSync(
      resolve(tmpRepo, '.mars', 'worker-registry.json'),
      'utf8',
    )
    const registry = JSON.parse(content) as Record<string, { tags?: string[] }>
    expect(registry['MultiTagWorker']?.tags).toEqual(['scaffold', 'docs'])
  })

  it('omits the tags field when no --tag is supplied', () => {
    runCli(
      ['worker', 'add', 'NoTagWorker', '--model', 'claude-sonnet-4-6'],
      ENV(),
    )
    const content = readFileSync(
      resolve(tmpRepo, '.mars', 'worker-registry.json'),
      'utf8',
    )
    const registry = JSON.parse(content) as Record<string, { tags?: unknown }>
    // tags key should be absent (or undefined) when no --tag was passed.
    expect('tags' in (registry['NoTagWorker'] ?? {})).toBe(false)
  })

  it('seeded built-in Workers carry tag sets matching their role names', () => {
    runCli(
      ['worker', 'add', 'TriggerSeed', '--model', 'claude-sonnet-4-6'],
      ENV(),
    )
    const content = readFileSync(
      resolve(tmpRepo, '.mars', 'worker-registry.json'),
      'utf8',
    )
    const registry = JSON.parse(content) as Record<string, { tags?: string[] }>
    expect(registry['Coder']?.tags).toContain('coder')
    expect(registry['Planner']?.tags).toContain('planner')
    expect(registry['Slicer']?.tags).toContain('slicer')
    expect(registry['Triager']?.tags).toContain('triager')
    expect(registry['Fixer']?.tags).toContain('fixer')
  })
})

// ---------------------------------------------------------------------------
// mars worker — unknown subcommand
// ---------------------------------------------------------------------------

describe('mars worker — unknown subcommand', () => {
  it('exits 2 with usage error', () => {
    const result = runCli(['worker', 'bogus'], ENV())
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('usage: mars worker')
  })
})
