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
  input?: string,
): SpawnSyncReturns<string> =>
  spawnSync(process.execPath, [tsxBin, cliEntry, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    input,
    timeout: 15_000,
  })

const withTempRepo = (fn: (tmpDir: string) => void): void => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'mars-arc-reflect-test-'))
  mkdirSync(join(tmpDir, '.mars'), { recursive: true })
  try {
    fn(tmpDir)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

describe('mars deep-reflect — removed verb', () => {
  it('exits non-zero with unknown-command error', () => {
    const result = runCli(['deep-reflect'], { MARS_REPO: '/tmp' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('unknown command: deep-reflect')
  })

  it('is not listed in top-level help', () => {
    const result = runCli(['--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).not.toMatch(/^\s*deep-reflect/m)
  })
})

describe('mars arc reflect --help', () => {
  it('exits 0 and prints arc subcommand help', () => {
    const result = runCli(['arc', 'reflect', '--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('arc')
  })

  it('documents the positional originId argument', () => {
    const result = runCli(['arc', 'reflect', '--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/originId|origin.id/i)
  })

  it('documents the --session escape hatch', () => {
    const result = runCli(['arc', 'reflect', '--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('--session')
  })
})

describe('mars arc reflect — interactive picker (no originId)', () => {
  it('prints the arc list header when no originId is given', () => {
    withTempRepo((tmpDir) => {
      // provide a newline as stdin so the readline prompt doesn't hang
      const result = runCli(['arc', 'reflect'], { MARS_REPO: tmpDir }, '\n')
      // Even with an empty DB the arc list header must appear
      expect(result.stdout).toContain('originId')
    })
  })

  it('exits non-zero when operator provides empty input', () => {
    withTempRepo((tmpDir) => {
      const result = runCli(['arc', 'reflect'], { MARS_REPO: tmpDir }, '\n')
      expect(result.status).not.toBe(0)
    })
  })
})

describe('mars arc reflect <originId>', () => {
  it('exits non-zero with a clear error for an unknown originId', () => {
    withTempRepo((tmpDir) => {
      const result = runCli(['arc', 'reflect', 'no-such-arc-id'], {
        MARS_REPO: tmpDir,
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('no-such-arc-id')
    })
  })

  it('error message does not suggest a different arc was silently chosen', () => {
    withTempRepo((tmpDir) => {
      const result = runCli(['arc', 'reflect', 'no-such-arc-id'], {
        MARS_REPO: tmpDir,
      })
      // The message should name the ID that was not found, not some other arc
      expect(result.stderr).toMatch(/no.*(arc|task|transcript).*found|not found/i)
    })
  })
})

describe('mars arc reflect --session <id>', () => {
  it('exits non-zero with a clear error when the session has no transcript', () => {
    withTempRepo((tmpDir) => {
      const result = runCli(['arc', 'reflect', '--session', 'no-such-session-id'], {
        MARS_REPO: tmpDir,
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('no-such-session-id')
    })
  })

  it('does not prompt for Arc selection when --session is given', () => {
    withTempRepo((tmpDir) => {
      const result = runCli(['arc', 'reflect', '--session', 'no-such-session-id'], {
        MARS_REPO: tmpDir,
      })
      // Should not print the arc picker header
      expect(result.stdout).not.toContain('originId\ttasks')
    })
  })
})
