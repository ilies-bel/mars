/**
 * Integration tests for `mars daemon` subcommand routing.
 *
 * These tests verify the CLI's routing layer: that each documented subcommand
 * dispatches correctly and that legacy flag-form aliases produce the same
 * observable behaviour as the canonical subcommand form.
 *
 * Tests that would spawn an actual daemon (start, restart) are intentionally
 * absent — they require infrastructure (writable .mars/ dir, valid DB setup)
 * that belongs in a separate integration harness.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

// Use a fresh temp dir so these tests never hit a real running daemon or
// leave state behind in a shared location like /tmp.
let tmpRepo: string
beforeAll(() => {
  tmpRepo = mkdtempSync(resolve(tmpdir(), 'mars-daemon-subcmd-test-'))
})
afterAll(() => {
  rmSync(tmpRepo, { recursive: true, force: true })
})

const ENV = (): Record<string, string> => ({ MARS_REPO: tmpRepo })

describe('mars daemon — unknown subcommand', () => {
  it('exits 2 with usage error for an unrecognised subcommand', () => {
    const result = runCli(['daemon', 'bogus'], ENV())
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('usage: mars daemon')
  })

  it('the usage error lists start, stop, restart, kill, status', () => {
    const result = runCli(['daemon', 'bogus'], ENV())
    expect(result.stderr).toContain('start')
    expect(result.stderr).toContain('stop')
    expect(result.stderr).toContain('restart')
    expect(result.stderr).toContain('kill')
    expect(result.stderr).toContain('status')
  })
})

describe('mars daemon --help', () => {
  it('lists all four user-facing subcommands', () => {
    const result = runCli(['daemon', '--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('start')
    expect(result.stdout).toContain('stop')
    expect(result.stdout).toContain('restart')
    expect(result.stdout).toContain('status')
  })

  it('documents restart subcommand behaviour', () => {
    const result = runCli(['daemon', '--help'])
    // The restart description should mention stop+start semantics
    expect(result.stdout).toContain('restart')
    expect(result.stdout).toContain('stop')
  })
})

describe('mars daemon status — when daemon is not running', () => {
  it('exits 1 with "daemon not running" (not an unknown-command error)', () => {
    const result = runCli(['daemon', 'status'], ENV())
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/daemon not running/)
    // Must NOT fall through to the generic usage error
    expect(result.stderr).not.toContain('usage: mars daemon')
  })
})

describe('mars daemon stop — when daemon is not running', () => {
  it('exits 1 with "daemon not running" (not an unknown-command error)', () => {
    const result = runCli(['daemon', 'stop'], ENV())
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/daemon not running/)
    expect(result.stderr).not.toContain('usage: mars daemon')
  })
})

describe('legacy flag-form aliases', () => {
  // Note: --status cannot be a daemon subcommand alias because '--status' is in
  // FLAGS_WITH_VALUES (used by `proposal list --status <value>`) and is
  // consumed by the top-level parser. Use `mars daemon status` instead.

  it('mars daemon --stop produces the same exit code as mars daemon stop', () => {
    const canonical = runCli(['daemon', 'stop'], ENV())
    const alias = runCli(['daemon', '--stop'], ENV())
    expect(alias.status).toBe(canonical.status)
  })

  it('mars daemon --stop produces the same stderr as mars daemon stop', () => {
    const canonical = runCli(['daemon', 'stop'], ENV())
    const alias = runCli(['daemon', '--stop'], ENV())
    expect(alias.stderr).toBe(canonical.stderr)
  })

  it('mars daemon --detach does not produce an unknown-command error', () => {
    // --detach is a legacy alias for 'start'; it forks the daemon to background.
    // We only verify it does NOT fall through to the routing error.
    const result = runCli(['daemon', '--detach'], ENV())
    // Must not be the generic usage error exit code
    expect(result.stderr).not.toContain('usage: mars daemon')
  })
})
