import { describe, it, expect } from 'vitest'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// src/cli/__tests__ -> src/cli -> src -> orchestrator
const projectRoot = resolve(here, '..', '..', '..')
const cliEntry = resolve(projectRoot, 'src', 'cli.ts')
const tsxBin = resolve(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')

const pkg = JSON.parse(
  readFileSync(resolve(projectRoot, 'package.json'), 'utf8'),
) as { version: string }

const runCli = (args: readonly string[]): SpawnSyncReturns<string> =>
  spawnSync(process.execPath, [tsxBin, cliEntry, ...args], {
    encoding: 'utf8',
    env: { ...process.env },
  })

describe('mars --version', () => {
  it('prints the package.json version and exits 0', () => {
    const result = runCli(['--version'])
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(pkg.version)
  })

  it('-v behaves identically to --version', () => {
    const longForm = runCli(['--version'])
    const shortForm = runCli(['-v'])
    expect(shortForm.status).toBe(0)
    expect(shortForm.stdout).toBe(longForm.stdout)
  })

  it('short-circuits before any subcommand is dispatched', () => {
    // 'definitely-not-a-real-command' would normally fail or hit
    // resolveContext()/help logic. With --version present anywhere in
    // argv, the CLI must print the version and exit 0 without touching
    // subcommand parsing or repo resolution.
    const result = runCli(['--version', 'definitely-not-a-real-command'])
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(pkg.version)
    expect(result.stderr).toBe('')
  })
})

describe('MARS_VERSION constant', () => {
  it('matches the orchestrator package.json version', async () => {
    const mod = (await import('../../version')) as { MARS_VERSION: string }
    expect(mod.MARS_VERSION).toBe(pkg.version)
  })
})
