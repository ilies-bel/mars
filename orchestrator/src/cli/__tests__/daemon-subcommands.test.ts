// CLI integration tests for `mars daemon` subcommands.
//
// ISOLATION INVARIANT: every runCli call that can reach the daemon-startup
// code path (ensureProjectRegistered in server.ts startDaemon) MUST pass
// ENV(). ENV() includes MARS_PROJECTS_FILE so writes go to tmpRepo/projects.json
// instead of the user's real ~/.mars/projects.json.
//
// `daemon --help` is safe without ENV() — it exits before daemon startup.
// `daemon status` / `daemon stop` are also safe when no daemon is running
// (they call sendRequest with autoSpawn:false and exit 1 on "not running").
// `daemon start` / `--detach` fork a real daemon that calls
// ensureProjectRegistered — these MUST use ENV().

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
  tmpRepo = mkdtempSync(resolve(tmpdir(), 'mars-daemon-subcmd-test-'))
})

afterEach(() => {
  // Best-effort: kill any daemon that may have been started during the test.
  // Uses ENV() so the kill targets the daemon bound to tmpRepo's socket, and
  // MARS_PROJECTS_FILE keeps the call scoped to the temp registry.
  // We ignore the exit code — daemon may have already exited or never started.
  runCli(['daemon', 'kill'], ENV())
  rmSync(tmpRepo, { recursive: true, force: true })
})

/**
 * ENV() always includes both MARS_REPO and MARS_PROJECTS_FILE.
 *
 * MARS_PROJECTS_FILE is the isolation key: when `daemon start --foreground`
 * runs inside the spawned child process, it calls ensureProjectRegistered()
 * which reads registryPath() → process.env.MARS_PROJECTS_FILE. Because the
 * parent CLI spawns the child with `{ ...process.env, MARS_REPO }`, and
 * process.env in the CLI already contains MARS_PROJECTS_FILE (inherited from
 * our spawnSync env), the child writes to tmpRepo/projects.json rather than
 * ~/.mars/projects.json.
 *
 * afterAll cleans up tmpRepo (and everything inside it, including
 * projects.json), so no temp entries survive beyond the test run.
 */
const ENV = (): Record<string, string> => ({
  MARS_REPO: tmpRepo,
  MARS_PROJECTS_FILE: resolve(tmpRepo, 'projects.json'),
})

// ---------------------------------------------------------------------------
// mars daemon --help  (safe: exits before any daemon startup)
// ---------------------------------------------------------------------------

describe('mars daemon --help', () => {
  it('exits 0', () => {
    const result = runCli(['daemon', '--help'])
    expect(result.status).toBe(0)
  })

  it('prints daemon subcommand usage', () => {
    const result = runCli(['daemon', '--help'])
    expect(result.stdout).toContain('daemon')
    expect(result.stdout).toContain('start')
  })
})

// ---------------------------------------------------------------------------
// mars daemon status  (no daemon running)
// ---------------------------------------------------------------------------

describe('mars daemon status (no daemon running)', () => {
  it('exits nonzero', () => {
    const result = runCli(['daemon', 'status'], ENV())
    expect(result.status).not.toBe(0)
  })

  it('reports daemon not running on stderr', () => {
    const result = runCli(['daemon', 'status'], ENV())
    expect(result.stderr).toMatch(/daemon not running/i)
  })
})

// ---------------------------------------------------------------------------
// mars daemon stop  (no daemon running)
// ---------------------------------------------------------------------------

describe('mars daemon stop (no daemon running)', () => {
  it('exits nonzero', () => {
    const result = runCli(['daemon', 'stop'], ENV())
    expect(result.status).not.toBe(0)
  })

  it('reports daemon not running on stderr', () => {
    const result = runCli(['daemon', 'stop'], ENV())
    expect(result.stderr).toMatch(/daemon not running/i)
  })
})

// ---------------------------------------------------------------------------
// mars daemon start / --detach
//
// These fork a real daemon child.  The parent exits immediately (detached +
// stdio:ignore + unref), so the test checks the parent's exit code and
// output only — not the child's full startup.  ENV() ensures the child
// inherits MARS_PROJECTS_FILE and any registry write lands in tmpRepo.
// ---------------------------------------------------------------------------

describe('mars daemon start', () => {
  it('exits 0 and prints daemon detached', () => {
    const result = runCli(['daemon', 'start'], ENV())
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('daemon detached')
  })
})

describe('mars daemon --detach (alias for start)', () => {
  it('exits 0', () => {
    const result = runCli(['daemon', '--detach'], ENV())
    expect(result.status).toBe(0)
  })
})
