/**
 * Integration tests for `mars chat-feedback list`.
 *
 * Exercises the CLI command by spawning the tsx entry point in a temporary
 * repo directory, following the same pattern as the other CLI command tests
 * in this directory.
 */

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
  const tmpDir = mkdtempSync(join(tmpdir(), 'mars-chat-feedback-cli-test-'))
  mkdirSync(join(tmpDir, '.mars'), { recursive: true })
  try {
    fn(tmpDir)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

describe('mars chat-feedback --help', () => {
  it('exits 0 and mentions the command', () => {
    const result = runCli(['chat-feedback', '--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/chat-feedback/i)
  })
})

describe('mars chat-feedback list --help', () => {
  it('exits 0 and documents --rating, --limit, --since', () => {
    const result = runCli(['chat-feedback', 'list', '--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('--rating')
    expect(result.stdout).toContain('--limit')
    expect(result.stdout).toContain('--since')
  })
})

describe('mars chat-feedback list — empty database', () => {
  it('exits 0 and prints a "no feedback" message when the table is empty', () => {
    withTempRepo((tmpDir) => {
      const result = runCli(['chat-feedback', 'list'], { MARS_REPO: tmpDir })
      expect(result.status).toBe(0)
      expect(result.stdout).toMatch(/no chat feedback|no.*feedback|not found/i)
    })
  })
})

describe('mars chat-feedback list — flag validation', () => {
  it('exits 1 with an error when --rating is not up or down', () => {
    withTempRepo((tmpDir) => {
      const result = runCli(['chat-feedback', 'list', '--rating', 'neutral'], {
        MARS_REPO: tmpDir,
      })
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/rating|up|down/i)
    })
  })

  it('exits 1 with an error when --limit is not a positive integer', () => {
    withTempRepo((tmpDir) => {
      const result = runCli(['chat-feedback', 'list', '--limit', '0'], {
        MARS_REPO: tmpDir,
      })
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/limit/i)
    })
  })
})

describe('mars chat-feedback list — --rating flag is honoured', () => {
  it('accepts --rating up without error', () => {
    withTempRepo((tmpDir) => {
      const result = runCli(['chat-feedback', 'list', '--rating', 'up'], {
        MARS_REPO: tmpDir,
      })
      // May be 0 (no entries) or non-zero if DB fails — but must not crash with
      // "unknown flag" or similar parse error.
      expect(result.stderr).not.toMatch(/unknown flag|invalid flag/i)
      expect(result.status).not.toBe(2) // 2 = usage error from dispatcher
    })
  })

  it('accepts --rating down without error', () => {
    withTempRepo((tmpDir) => {
      const result = runCli(['chat-feedback', 'list', '--rating', 'down'], {
        MARS_REPO: tmpDir,
      })
      expect(result.stderr).not.toMatch(/unknown flag|invalid flag/i)
      expect(result.status).not.toBe(2)
    })
  })
})
