import { describe, it, expect } from 'vitest'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

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

const withTempRepo = (fn: (tmpDir: string) => void): void => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'mars-reflect-session-test-'))
  mkdirSync(join(tmpDir, '.mars'), { recursive: true })
  try {
    fn(tmpDir)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

describe('mars reflect session --help', () => {
  it('exits 0 and prints session subcommand help', () => {
    const result = runCli(['reflect', 'session', '--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('session')
  })

  it('documents the optional sessionId/originId argument', () => {
    const result = runCli(['reflect', 'session', '--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/sessionId|originId|session[-_]?id/i)
  })
})

describe('mars reflect session — disabled', () => {
  it('exits 0 with disabled message when MARS_REFLECT_DISABLED=1', () => {
    withTempRepo((tmpDir) => {
      const result = runCli(['reflect', 'session'], {
        MARS_REPO: tmpDir,
        MARS_REFLECT_DISABLED: '1',
      })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('disabled')
    })
  })
})

describe('mars reflect session <sessionId>', () => {
  it('exits non-zero with a clear error for an unknown session UUID', () => {
    withTempRepo((tmpDir) => {
      const result = runCli(
        ['reflect', 'session', '00000000-0000-0000-0000-000000000000'],
        { MARS_REPO: tmpDir },
      )
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/no (task|arc|session)|not found/i)
    })
  })

  it('exits non-zero with a clear error for an unknown origin ID', () => {
    withTempRepo((tmpDir) => {
      const result = runCli(
        ['reflect', 'session', 'mars-no-such-arc'],
        { MARS_REPO: tmpDir },
      )
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/no (task|arc|session)|not found/i)
    })
  })
})

describe('mars reflect session — no argument, no session env', () => {
  it('exits non-zero with a clear error when no session can be resolved', () => {
    withTempRepo((tmpDir) => {
      const result = runCli(['reflect', 'session'], {
        MARS_REPO: tmpDir,
        CLAUDE_CODE_SESSION_ID: '',
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/no session/i)
    })
  })
})
