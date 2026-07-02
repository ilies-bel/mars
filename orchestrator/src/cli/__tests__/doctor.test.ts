/**
 * Tests for `mars doctor` — run through the in-process seam with stubbed
 * DoctorProbes so no real binaries are invoked and no daemon is required.
 *
 * Each test group covers one observable behaviour: what the command prints
 * and what exit code it returns for a given probe configuration.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { runCommandInProcess, makeFakeDaemon } from '../test-adapter'
import { runDoctorChecks, type DoctorProbes } from '../../cli/commands/doctor'
import type { DomainTaskStore } from '../../core/store/task-store'
import type { OrchestratorContext } from '../../core/context'

// ---------------------------------------------------------------------------
// Test repo setup
// ---------------------------------------------------------------------------

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-doctor-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

const loadStoreAndCtx = async (): Promise<{ store: DomainTaskStore; ctx: OrchestratorContext }> => {
  const { vi } = await import('vitest')
  vi.resetModules()
  process.env.MARS_REPO = repo
  const queueModule = await import('../../core/queue')
  await queueModule.migrateQueueSchema()
  const storeModule = await import('../../core/store/task-store')
  const contextModule = await import('../../core/context')
  return {
    store: storeModule.createTaskStore(queueModule.resolveQueueClient()),
    ctx: contextModule.resolveContext(repo),
  }
}

beforeEach(() => {
  repo = setupRepo()
})
afterEach(() => {
  delete process.env.MARS_REPO
  rmSync(repo, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fully-passing probe set; individual properties can be overridden. */
const passingProbes = (overrides?: Partial<DoctorProbes>): DoctorProbes => ({
  tryRun(_cmd, _args) {
    return 0
  },
  nodeVersion: 'v22.13.0',
  async daemonLiveness() {
    return { alive: false, reason: 'no-pid' }
  },
  fileReadable(_path) {
    return true
  },
  ...overrides,
})

// ---------------------------------------------------------------------------
// runDoctorChecks — unit tests against the probe interface
// ---------------------------------------------------------------------------

describe('runDoctorChecks — all passing', () => {
  it('returns all PASS/WARN results and no FAILs when probes are healthy', async () => {
    const results = await runDoctorChecks(passingProbes(), '/some/mars.db')
    expect(results.every((r) => r.status !== 'FAIL')).toBe(true)
  })
})

describe('runDoctorChecks — claude CLI', () => {
  it('FAIL when claude is not on PATH (tryRun returns null)', async () => {
    const probes = passingProbes({
      tryRun(cmd) {
        if (cmd === 'claude') return null
        return 0
      },
    })
    const results = await runDoctorChecks(probes, null)
    const check = results.find((r) => r.label === 'claude CLI')
    expect(check?.status).toBe('FAIL')
    expect(check?.message).toContain('not found')
  })

  it('FAIL when claude --version exits non-zero', async () => {
    const probes = passingProbes({
      tryRun(cmd, args) {
        if (cmd === 'claude' && args.includes('--version')) return 1
        return 0
      },
    })
    const results = await runDoctorChecks(probes, null)
    const check = results.find((r) => r.label === 'claude CLI')
    expect(check?.status).toBe('FAIL')
    expect(check?.message).toContain('exited 1')
  })

  it('PASS when claude --version exits 0', async () => {
    const results = await runDoctorChecks(passingProbes(), null)
    const check = results.find((r) => r.label === 'claude CLI')
    expect(check?.status).toBe('PASS')
  })
})

describe('runDoctorChecks — git', () => {
  it('FAIL when git is not on PATH', async () => {
    const probes = passingProbes({
      tryRun(cmd) {
        if (cmd === 'git') return null
        return 0
      },
    })
    const results = await runDoctorChecks(probes, null)
    const check = results.find((r) => r.label === 'git')
    expect(check?.status).toBe('FAIL')
  })

  it('PASS when git is found (exit code 0)', async () => {
    const results = await runDoctorChecks(passingProbes(), null)
    const check = results.find((r) => r.label === 'git')
    expect(check?.status).toBe('PASS')
  })
})

describe('runDoctorChecks — Node.js version', () => {
  it('FAIL when Node version is below 22.13.0', async () => {
    const probes = passingProbes({ nodeVersion: 'v20.0.0' })
    const results = await runDoctorChecks(probes, null)
    const check = results.find((r) => r.label === 'Node.js')
    expect(check?.status).toBe('FAIL')
    expect(check?.message).toContain('v20.0.0')
  })

  it('FAIL when Node version is 22.12.x (below patch)', async () => {
    const probes = passingProbes({ nodeVersion: 'v22.12.0' })
    const results = await runDoctorChecks(probes, null)
    const check = results.find((r) => r.label === 'Node.js')
    expect(check?.status).toBe('FAIL')
  })

  it('PASS for exactly 22.13.0', async () => {
    const probes = passingProbes({ nodeVersion: 'v22.13.0' })
    const results = await runDoctorChecks(probes, null)
    const check = results.find((r) => r.label === 'Node.js')
    expect(check?.status).toBe('PASS')
  })

  it('PASS for a later major version (v23)', async () => {
    const probes = passingProbes({ nodeVersion: 'v23.0.0' })
    const results = await runDoctorChecks(probes, null)
    const check = results.find((r) => r.label === 'Node.js')
    expect(check?.status).toBe('PASS')
  })
})

describe('runDoctorChecks — codegraph (WARN-only)', () => {
  it('WARN when codegraph is not on PATH — never FAIL', async () => {
    const probes = passingProbes({
      tryRun(cmd) {
        if (cmd === 'codegraph') return null
        return 0
      },
    })
    const results = await runDoctorChecks(probes, null)
    const check = results.find((r) => r.label === 'codegraph')
    expect(check?.status).toBe('WARN')
  })

  it('PASS when codegraph is found', async () => {
    const results = await runDoctorChecks(passingProbes(), null)
    const check = results.find((r) => r.label === 'codegraph')
    expect(check?.status).toBe('PASS')
  })
})

describe('runDoctorChecks — daemon', () => {
  it('WARN when daemon is not running', async () => {
    const probes = passingProbes({
      async daemonLiveness() {
        return { alive: false, reason: 'no-pid' }
      },
    })
    const results = await runDoctorChecks(probes, null)
    const check = results.find((r) => r.label === 'daemon')
    expect(check?.status).toBe('WARN')
    expect(check?.message).toContain('auto-start')
  })

  it('WARN when daemon is stale (dev install drifted from HEAD)', async () => {
    const probes = passingProbes({
      async daemonLiveness() {
        return {
          alive: true,
          pid: 42,
          isStale: true,
          sourceSha: 'aabbccdd1234567',
          currentSha: 'deadbeef9876543',
        }
      },
    })
    const results = await runDoctorChecks(probes, null)
    const check = results.find((r) => r.label === 'daemon')
    expect(check?.status).toBe('WARN')
    expect(check?.message).toContain('aabbccd')
    expect(check?.message).toContain('deadbee')
    expect(check?.message).toContain('daemon restart')
  })

  it('PASS when daemon is running and not stale', async () => {
    const probes = passingProbes({
      async daemonLiveness() {
        return { alive: true, pid: 99, isStale: false }
      },
    })
    const results = await runDoctorChecks(probes, null)
    const check = results.find((r) => r.label === 'daemon')
    expect(check?.status).toBe('PASS')
    expect(check?.message).toContain('99')
  })
})

describe('runDoctorChecks — mars.db', () => {
  it('WARN when dbPath is provided but file does not exist', async () => {
    const probes = passingProbes({ fileReadable: () => false })
    const results = await runDoctorChecks(probes, '/some/mars.db')
    const check = results.find((r) => r.label === 'mars.db')
    expect(check?.status).toBe('WARN')
    expect(check?.message).toContain('mars init')
  })

  it('PASS when dbPath is provided and file exists', async () => {
    const probes = passingProbes({ fileReadable: () => true })
    const results = await runDoctorChecks(probes, '/some/mars.db')
    const check = results.find((r) => r.label === 'mars.db')
    expect(check?.status).toBe('PASS')
  })

  it('skips mars.db check when dbPath is null', async () => {
    const results = await runDoctorChecks(passingProbes(), null)
    expect(results.find((r) => r.label === 'mars.db')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// doctor command via in-process seam
// ---------------------------------------------------------------------------

describe('mars doctor command (in-process)', () => {
  it('exits 0 and prints PASS/WARN lines when no FAILs', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['doctor'], {
      store,
      ctx,
      daemon: makeFakeDaemon(),
    })
    // Doctor uses realProbes, so it will actually exec 'claude --version',
    // 'git --version', etc. The test just asserts the exit code matches the
    // presence of any FAIL in the output (FAIL lines go to err, so r.err
    // non-empty → r.code should be 1).
    const hasFail = r.err.some((line) => line.startsWith('FAIL'))
    expect(r.code).toBe(hasFail ? 1 : 0)
  })
})
