import { describe, it, expect } from 'vitest'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// src/cli/__tests__ -> src/cli -> src -> orchestrator
const projectRoot = resolve(here, '..', '..', '..')
const cliEntry = resolve(projectRoot, 'src', 'cli.ts')
const tsxBin = resolve(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')

const runCli = (args: readonly string[], env?: Record<string, string>): SpawnSyncReturns<string> =>
  spawnSync(process.execPath, [tsxBin, cliEntry, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 15_000,
  })

describe('mars --help — continue verb', () => {
  it('lists continue alongside restart in top-level help', () => {
    const result = runCli(['--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/^\s*continue\s+<id>/m)
  })

  it('continue description contrasts with restart (mentions restart as the alternative)', () => {
    const result = runCli(['--help'])
    expect(result.status).toBe(0)
    // The continue entry should reference restart as the alternative for full re-run
    expect(result.stdout).toMatch(/continue[\s\S]*?restart/m)
  })

  it('restart is still present alongside continue', () => {
    const result = runCli(['--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/^\s*restart\s+<id>/m)
  })
})

describe('mars continue --help', () => {
  it('prints command-specific usage and exits 0', () => {
    const result = runCli(['continue', '--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('mars continue')
  })

  it('mentions that there are no flags in v1', () => {
    const result = runCli(['continue', '--help'])
    expect(result.status).toBe(0)
    // The help must note that v1 has no flags
    expect(result.stdout).toMatch(/no flags?|v1|flags? in v1/i)
  })

  it('contrasts with restart as the full re-run alternative', () => {
    const result = runCli(['continue', '--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('restart')
  })
})

describe('mars continue — no task id', () => {
  it('exits non-zero when no task id is provided', () => {
    const result = runCli(['continue'])
    expect(result.status).not.toBe(0)
  })

  it('prints a usage message to stderr when no task id is provided', () => {
    const result = runCli(['continue'])
    expect(result.stderr).toContain('usage')
    expect(result.stderr).toContain('continue')
  })
})
