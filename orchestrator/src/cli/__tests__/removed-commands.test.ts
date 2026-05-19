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

describe('mars blockers — removed verb', () => {
  it('exits 1 with unknown-command error when invoked', () => {
    const result = runCli(['blockers', 'some-task-id'], { MARS_REPO: '/tmp' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('unknown command: blockers')
  })
})

describe('mars --help — no question-listing verb', () => {
  it('does not reference a blockers question-listing verb in top-level help', () => {
    const result = runCli(['--help'])
    expect(result.status).toBe(0)
    // The old entry "  blockers <task-id>  list incomplete blockers on a task" must be gone
    expect(result.stdout).not.toMatch(/^\s*blockers <task-id>/m)
  })

  it('does not mention question-listing in triage description', () => {
    const result = runCli(['--help'])
    expect(result.status).toBe(0)
    // The triage line used to say "actionability + blockers"; it should no longer do so
    expect(result.stdout).not.toMatch(/actionability \+ blockers/)
  })
})
