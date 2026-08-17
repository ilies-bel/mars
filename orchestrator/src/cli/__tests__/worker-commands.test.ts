// CLI acceptance tests for `mars worker list` and `mars worker add`.
// These verify observable behaviour: stdout/exit code/file artifacts.

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
// Use claude as the active provider so model-id tests can use claude model ids.
const ENV_CLAUDE = (): Record<string, string> => ({
  MARS_REPO: tmpRepo,
  MARS_WORKER_PROVIDER: 'claude',
})

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

  it('names the active provider in the output', () => {
    const result = runCli(['worker', 'list'], ENV_CLAUDE())
    expect(result.stdout).toContain('Provider: claude')
  })

  it('shows tier names in the output', () => {
    const result = runCli(['worker', 'list'], ENV_CLAUDE())
    // Planner and Slicer use flagship; Coder, Fixer use balanced; Triager uses fast.
    expect(result.stdout).toContain('flagship')
    expect(result.stdout).toContain('balanced')
    expect(result.stdout).toContain('fast')
  })

  it('shows resolved model identifiers under the active claude provider', () => {
    const result = runCli(['worker', 'list'], ENV_CLAUDE())
    // Claude models should appear in the resolved model column.
    expect(result.stdout).toContain('claude-sonnet-5')
    expect(result.stdout).toContain('claude-opus-5')
  })

  it('shows a newly added worker after mars worker add', () => {
    runCli(
      ['worker', 'add', 'ScaffoldWorker', '--model', 'balanced'],
      ENV(),
    )
    const result = runCli(['worker', 'list'], ENV())
    expect(result.stdout).toContain('ScaffoldWorker')
  })

  it('reads defaultProvider from daemon.json when MARS_WORKER_PROVIDER is unset', () => {
    // Write a daemon.json that persists 'claude' as the default provider.
    mkdirSync(resolve(tmpRepo, '.mars'), { recursive: true })
    writeFileSync(
      resolve(tmpRepo, '.mars', 'daemon.json'),
      JSON.stringify({ defaultProvider: 'claude' }),
      'utf8',
    )
    // Run without MARS_WORKER_PROVIDER so resolveProviderName() falls through to
    // daemon.json — this is the fix for the "wrong provider" operator false trail.
    const result = runCli(['worker', 'list'], ENV())
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Provider: claude')
  })

  it('MARS_WORKER_PROVIDER overrides the persisted defaultProvider', () => {
    // Persist 'claude' but override back to 'codex' via the env var.
    mkdirSync(resolve(tmpRepo, '.mars'), { recursive: true })
    writeFileSync(
      resolve(tmpRepo, '.mars', 'daemon.json'),
      JSON.stringify({ defaultProvider: 'claude' }),
      'utf8',
    )
    const result = runCli(['worker', 'list'], {
      MARS_REPO: tmpRepo,
      MARS_WORKER_PROVIDER: 'codex',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Provider: codex')
  })
})

// ---------------------------------------------------------------------------
// mars worker add
// ---------------------------------------------------------------------------

describe('mars worker add', () => {
  it('exits 0 when name and model tier are supplied', () => {
    const result = runCli(
      ['worker', 'add', 'MyWorker', '--model', 'balanced'],
      ENV(),
    )
    expect(result.status).toBe(0)
  })

  it('exits 0 when --model is a concrete model id belonging to the active provider', () => {
    const result = runCli(
      ['worker', 'add', 'ModelIdWorker', '--model', 'claude-opus-5'],
      ENV_CLAUDE(),
    )
    expect(result.status).toBe(0)
  })

  it('prints confirmation that the worker was added', () => {
    const result = runCli(
      ['worker', 'add', 'ConfirmedWorker', '--model', 'balanced'],
      ENV(),
    )
    expect(result.stdout).toContain('ConfirmedWorker')
  })

  it('creates the registry file on first write', () => {
    runCli(
      ['worker', 'add', 'FirstWorker', '--model', 'balanced'],
      ENV(),
    )
    expect(
      existsSync(resolve(tmpRepo, '.mars', 'worker-registry.json')),
    ).toBe(true)
  })

  it('seeds the registry with hard-coded defaults on first write', () => {
    runCli(
      ['worker', 'add', 'SeedCheck', '--model', 'balanced'],
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

  it('stores the supplied tier in the registry when given a tier name', () => {
    runCli(
      ['worker', 'add', 'TierCheck', '--model', 'flagship'],
      ENV(),
    )
    const content = readFileSync(
      resolve(tmpRepo, '.mars', 'worker-registry.json'),
      'utf8',
    )
    const registry = JSON.parse(content) as Record<string, { modelTier: string }>
    expect(registry['TierCheck']?.modelTier).toBe('flagship')
  })

  it('maps a concrete model id to its tier when the model belongs to the active provider', () => {
    // claude-opus-5 is the flagship tier for the claude provider.
    runCli(
      ['worker', 'add', 'ModelCheck', '--model', 'claude-opus-5'],
      ENV_CLAUDE(),
    )
    const content = readFileSync(
      resolve(tmpRepo, '.mars', 'worker-registry.json'),
      'utf8',
    )
    const registry = JSON.parse(content) as Record<string, { modelTier: string }>
    expect(registry['ModelCheck']?.modelTier).toBe('flagship')
  })

  it('exits 2 with usage message when --model is omitted', () => {
    const result = runCli(['worker', 'add', 'NoModel'], ENV())
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('usage:')
  })

  it('exits 2 with usage message when name and --model are both omitted', () => {
    const result = runCli(['worker', 'add'], ENV())
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('usage:')
  })

  it('exits 2 with an error when --model is a concrete model id not in the active provider', () => {
    // gpt-5.6-terra belongs to codex, not claude.
    const result = runCli(
      ['worker', 'add', 'Mismatch', '--model', 'gpt-5.6-terra'],
      ENV_CLAUDE(),
    )
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('not in provider')
  })

  it('respects --effort flag', () => {
    runCli(
      [
        'worker',
        'add',
        'EffortWorker',
        '--model',
        'balanced',
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

  it('exits 2 and names every allowed value when --effort has an invalid value', () => {
    const result = runCli(
      ['worker', 'add', 'BadEffort', '--model', 'balanced', '--effort', 'turbo'],
      ENV(),
    )
    expect(result.status).toBe(2)
    // The bad value should be named.
    expect(result.stderr).toContain('turbo')
    // Every allowed value must be present so the user knows what to type.
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(result.stderr).toContain(level)
    }
  })

  it('exits 2 and names every allowed value when --permission-mode has an invalid value', () => {
    const result = runCli(
      ['worker', 'add', 'BadPerm', '--model', 'balanced', '--permission-mode', 'superuser'],
      ENV(),
    )
    expect(result.status).toBe(2)
    // The bad value should be named.
    expect(result.stderr).toContain('superuser')
    // Every allowed value must be present so the user knows what to type.
    for (const mode of ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan']) {
      expect(result.stderr).toContain(mode)
    }
  })

  it('stores a single --tag in the registry', () => {
    runCli(
      ['worker', 'add', 'TaggedWorker', '--model', 'balanced', '--tag', 'scaffold'],
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
        '--model', 'balanced',
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
      ['worker', 'add', 'NoTagWorker', '--model', 'balanced'],
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
      ['worker', 'add', 'TriggerSeed', '--model', 'balanced'],
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
