/**
 * Tests for `mars doctor` — run through the in-process seam with stubbed
 * DoctorProbes so no real binaries are invoked and no daemon is required.
 *
 * Each test group covers one observable behaviour: what the command prints
 * and what exit code it returns for a given probe configuration.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { runCommandInProcess, makeFakeDaemon } from '../test-adapter'
import { runDoctorChecks, type DoctorProbes } from '../../cli/commands/doctor'
import type { ProviderProbeDeps } from '../../cli/commands/provider-probe'
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
  await queueModule.ensureQueueSchema()
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
  fileReadable(_path) {
    return true
  },
  readTextFile(_path) {
    return JSON.stringify({ tokens: { access_token: 'test-access-token' } })
  },
  async baselineGates() {
    return [] // empty → WARN (no gates configured), but not FAIL
  },
  runGate(_cmd, _args, _cwd) {
    return { passed: true, output: '' }
  },
  freeDiskBytes(_path) {
    return 10 * 1024 * 1024 * 1024 // 10 GiB → PASS
  },
  systemLoad() {
    return { loadAvg1: 1.0, cpuCount: 4 } // 0.25× per core → PASS
  },
  async installSites(_root) {
    return [] // 0 sites → no H7 row; safe default for tests not targeting H7
  },
  ...overrides,
})

const providerProbeDeps = (): ProviderProbeDeps => ({
  tryRun: () => 0,
  fileReadable: () => false,
  env: {},
  homeDir: '/tmp/mars-doctor-provider-test',
})

// ---------------------------------------------------------------------------
// runDoctorChecks — unit tests against the probe interface
// ---------------------------------------------------------------------------

describe('runDoctorChecks — all passing', () => {
  it('returns all PASS/WARN results and no FAILs when probes are healthy', async () => {
    const results = await runDoctorChecks(passingProbes(), '/some/.mars/pg.dsn')
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
    const check = results.find((r) => r.label === 'claude worker CLI')
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
    const check = results.find((r) => r.label === 'claude worker CLI')
    expect(check?.status).toBe('FAIL')
    expect(check?.message).toContain('exited 1')
  })

  it('PASS when claude --version exits 0', async () => {
    const results = await runDoctorChecks(passingProbes(), null)
    const check = results.find((r) => r.label === 'claude worker CLI')
    expect(check?.status).toBe('PASS')
  })
})

describe('runDoctorChecks — selected Codex provider', () => {
  it('checks the configured worker binary independently of valid chat credentials', async () => {
    const results = await runDoctorChecks(
      passingProbes({
        tryRun(cmd) {
          return cmd === '/custom/codex-worker' ? null : 0
        },
      }),
      null,
      {
        ...providerProbeDeps(),
        env: { MARS_CODEX_BIN: '/custom/codex-worker' },
      },
      'codex',
    )

    expect(results.find((r) => r.label === 'codex worker CLI')).toMatchObject({
      status: 'FAIL',
    })
    expect(results.find((r) => r.label === 'chat credentials')).toMatchObject({
      status: 'PASS',
    })
  })

  it('does not require Claude when Codex is selected and authenticated', async () => {
    const probes = passingProbes({
      tryRun(cmd) {
        if (cmd === 'claude') return null
        return 0
      },
    })
    const results = await runDoctorChecks(
      probes,
      null,
      providerProbeDeps(),
      'codex',
    )

    expect(results.find((r) => r.label === 'codex worker CLI')?.status).toBe('PASS')
    expect(results.find((r) => r.label === 'claude worker CLI')?.status).toBe('WARN')
    expect(results.some((r) => r.status === 'FAIL')).toBe(false)
  })

  it("fails with an actionable OAuth message when 'codex login status' fails", async () => {
    const probes = passingProbes({
      tryRun(cmd, args) {
        if (cmd === 'codex' && args[0] === 'login') return 1
        return 0
      },
    })
    const results = await runDoctorChecks(
      probes,
      null,
      providerProbeDeps(),
      'codex',
    )

    const check = results.find((r) => r.label === 'codex worker CLI')
    expect(check?.status).toBe('FAIL')
    expect(check?.message).toContain('codex login')
  })
})

describe('runDoctorChecks — chat credentials', () => {
  it('PASSes for a readable auth.json with a non-empty access token', async () => {
    const readPaths: string[] = []
    const results = await runDoctorChecks(
      passingProbes({
        readTextFile(path) {
          readPaths.push(path)
          return JSON.stringify({ tokens: { access_token: 'secret-token' } })
        },
      }),
      null,
      { ...providerProbeDeps(), env: { CODEX_HOME: '/custom/codex-home' } },
    )

    const check = results.find((r) => r.label === 'chat credentials')
    expect(check).toMatchObject({ status: 'PASS' })
    expect(readPaths).toEqual(['/custom/codex-home/auth.json'])
    expect(check?.message).not.toContain('secret-token')
  })

  it.each([
    ['missing', null],
    ['malformed', '{not-json'],
    ['missing token', JSON.stringify({ tokens: {} })],
    ['empty token', JSON.stringify({ tokens: { access_token: '' } })],
  ])('FAILs with the login remedy for a %s auth file', async (_state, authFile) => {
    const results = await runDoctorChecks(
      passingProbes({ readTextFile: () => authFile }),
      null,
    )

    expect(results.find((r) => r.label === 'chat credentials')).toMatchObject({
      status: 'FAIL',
      message: expect.stringContaining('run codex login'),
    })
  })

  it('uses the injected home directory when CODEX_HOME is not set', async () => {
    const readPaths: string[] = []
    await runDoctorChecks(
      passingProbes({
        readTextFile(path) {
          readPaths.push(path)
          return JSON.stringify({ tokens: { access_token: 'token' } })
        },
      }),
      null,
      providerProbeDeps(),
    )

    expect(readPaths).toEqual(['/tmp/mars-doctor-provider-test/.codex/auth.json'])
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

describe('runDoctorChecks — database', () => {
  it('WARN when pgDsnPath is provided but the DSN file does not exist', async () => {
    const probes = passingProbes({ fileReadable: () => false })
    const results = await runDoctorChecks(probes, '/some/.mars/pg.dsn')
    const check = results.find((r) => r.label === 'database')
    expect(check?.status).toBe('WARN')
    expect(check?.message).toContain('mars daemon start')
  })

  it('PASS when pgDsnPath is provided and the DSN file exists', async () => {
    const probes = passingProbes({ fileReadable: () => true })
    const results = await runDoctorChecks(probes, '/some/.mars/pg.dsn')
    const check = results.find((r) => r.label === 'database')
    expect(check?.status).toBe('PASS')
  })

  it('skips the database check when pgDsnPath is null', async () => {
    const results = await runDoctorChecks(passingProbes(), null)
    expect(results.find((r) => r.label === 'database')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Health checks — baseline verify gates
// ---------------------------------------------------------------------------

describe('runDoctorChecks — baseline health', () => {
  it('WARN when baselineGates returns null (DB unavailable)', async () => {
    const probes = passingProbes({ async baselineGates() { return null } })
    const results = await runDoctorChecks(probes, null)
    const check = results.find((r) => r.label === 'baseline')
    expect(check?.status).toBe('WARN')
    expect(check?.message).toContain('DB not running')
  })

  it('WARN when baselineGates returns [] (no gates configured)', async () => {
    const probes = passingProbes({ async baselineGates() { return [] } })
    const results = await runDoctorChecks(probes, null)
    const check = results.find((r) => r.label === 'baseline')
    expect(check?.status).toBe('WARN')
    expect(check?.message).toContain('no task-tier verify gates')
  })

  it('WARN when gates are present but repoRoot is null', async () => {
    const probes = passingProbes({
      async baselineGates() {
        return [{ name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'], dir: '.' }]
      },
    })
    const results = await runDoctorChecks(probes, null, undefined, 'claude', null)
    const check = results.find((r) => r.label === 'baseline')
    expect(check?.status).toBe('WARN')
    expect(check?.message).toContain('no repo root')
  })

  it('PASS when gate passes', async () => {
    const probes = passingProbes({
      async baselineGates() {
        return [{ name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'], dir: '.' }]
      },
      runGate(_cmd, _args, _cwd) { return { passed: true, output: '' } },
    })
    const results = await runDoctorChecks(probes, null, undefined, 'claude', '/repo')
    const check = results.find((r) => r.label === 'baseline: typecheck')
    expect(check?.status).toBe('PASS')
  })

  it('FAIL when gate fails and names the gate and scope in the label and message', async () => {
    const probes = passingProbes({
      async baselineGates() {
        return [{ name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'], dir: 'orchestrator' }]
      },
      runGate(_cmd, _args, _cwd) { return { passed: false, output: 'TS2345: error' } },
    })
    const results = await runDoctorChecks(probes, null, undefined, 'claude', '/repo')
    // A scoped gate (dir != '.') must include the scope in its label.
    const check = results.find((r) => r.label === 'baseline: typecheck (orchestrator)')
    expect(check?.status).toBe('FAIL')
    expect(check?.message).toContain('typecheck')
    expect(check?.message).toContain('tsc')
  })

  it('runs each gate and reports one result per gate', async () => {
    const probes = passingProbes({
      async baselineGates() {
        return [
          { name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'], dir: '.' },
          { name: 'test', cmd: 'npm', args: ['test'], dir: '.' },
        ]
      },
      runGate(cmd) {
        return { passed: cmd === 'npx', output: '' }
      },
    })
    const results = await runDoctorChecks(probes, null, undefined, 'claude', '/repo')
    expect(results.find((r) => r.label === 'baseline: typecheck')?.status).toBe('PASS')
    expect(results.find((r) => r.label === 'baseline: test')?.status).toBe('FAIL')
  })

  it('runs each distinct gate exactly once even when names collide across scopes', async () => {
    const runGateCalls: string[] = []
    const probes = passingProbes({
      async baselineGates() {
        return [
          { name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'], dir: '.' },
          { name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'], dir: 'orchestrator' },
          { name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'], dir: 'ui' },
        ]
      },
      runGate(_cmd, _args, cwd) {
        runGateCalls.push(cwd)
        return { passed: true, output: '' }
      },
    })
    const results = await runDoctorChecks(probes, null, undefined, 'claude', '/repo')
    // Each gate must be executed exactly once
    expect(runGateCalls).toHaveLength(3)
    // All baseline typecheck labels must be distinct (no duplicates)
    const baselineLabels = results
      .filter((r) => r.label.startsWith('baseline: typecheck'))
      .map((r) => r.label)
    expect(baselineLabels).toHaveLength(3)
    expect(new Set(baselineLabels).size).toBe(3)
  })

  it('produces distinguishable labels when two gates share a name but differ in scope', async () => {
    const probes = passingProbes({
      async baselineGates() {
        return [
          { name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'], dir: 'orchestrator' },
          { name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'], dir: 'ui' },
        ]
      },
      runGate() { return { passed: true, output: '' } },
    })
    const results = await runDoctorChecks(probes, null, undefined, 'claude', '/repo')
    const labels = results
      .filter((r) => r.section === 'health' && r.label.startsWith('baseline: typecheck'))
      .map((r) => r.label)
    expect(labels).toHaveLength(2)
    expect(labels[0]).not.toBe(labels[1])
    expect(labels[0]).toContain('orchestrator')
    expect(labels[1]).toContain('ui')
  })
})

// ---------------------------------------------------------------------------
// Health checks — disk capacity
// ---------------------------------------------------------------------------

describe('runDoctorChecks — disk capacity', () => {
  it('PASS when free disk >= 5 GiB', async () => {
    const probes = passingProbes({ freeDiskBytes: () => 10 * 1024 * 1024 * 1024 })
    const results = await runDoctorChecks(probes, null, undefined, 'claude', '/repo')
    expect(results.find((r) => r.label === 'disk')?.status).toBe('PASS')
  })

  it('WARN when free disk is between 1 GiB and 5 GiB', async () => {
    const probes = passingProbes({ freeDiskBytes: () => 2 * 1024 * 1024 * 1024 })
    const results = await runDoctorChecks(probes, null, undefined, 'claude', '/repo')
    const check = results.find((r) => r.label === 'disk')
    expect(check?.status).toBe('WARN')
  })

  it('FAIL when free disk < 1 GiB', async () => {
    const probes = passingProbes({ freeDiskBytes: () => 500 * 1024 * 1024 })
    const results = await runDoctorChecks(probes, null, undefined, 'claude', '/repo')
    const check = results.find((r) => r.label === 'disk')
    expect(check?.status).toBe('FAIL')
    expect(check?.message).toContain('mars purge')
  })

  it('skips disk check when freeDiskBytes returns null', async () => {
    const probes = passingProbes({ freeDiskBytes: () => null })
    const results = await runDoctorChecks(probes, null, undefined, 'claude', '/repo')
    expect(results.find((r) => r.label === 'disk')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Health checks — system load
// ---------------------------------------------------------------------------

describe('runDoctorChecks — system load', () => {
  it('PASS when load per core <= 4', async () => {
    const probes = passingProbes({ systemLoad: () => ({ loadAvg1: 2.0, cpuCount: 4 }) })
    const results = await runDoctorChecks(probes, null)
    expect(results.find((r) => r.label === 'load')?.status).toBe('PASS')
  })

  it('WARN when load per core is between 4 and 8', async () => {
    const probes = passingProbes({ systemLoad: () => ({ loadAvg1: 20.0, cpuCount: 4 }) })
    const results = await runDoctorChecks(probes, null)
    const check = results.find((r) => r.label === 'load')
    expect(check?.status).toBe('WARN')
  })

  it('FAIL when load per core > 8', async () => {
    const probes = passingProbes({ systemLoad: () => ({ loadAvg1: 36.0, cpuCount: 4 }) })
    const results = await runDoctorChecks(probes, null)
    const check = results.find((r) => r.label === 'load')
    expect(check?.status).toBe('FAIL')
    expect(check?.message).toContain('verify timeouts')
  })

  it('omits load check when systemLoad returns null', async () => {
    const probes = passingProbes({ systemLoad: () => null })
    const results = await runDoctorChecks(probes, null)
    expect(results.find((r) => r.label === 'load')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Health checks — config coherence
// ---------------------------------------------------------------------------

describe('runDoctorChecks — config coherence (defaultProvider vs registry)', () => {
  const makeConfigProbes = (daemonJson: object, registryJson: object): DoctorProbes =>
    passingProbes({
      readTextFile(path) {
        if (path.endsWith('daemon.json')) return JSON.stringify(daemonJson)
        if (path.endsWith('worker-registry.json')) return JSON.stringify(registryJson)
        return JSON.stringify({ tokens: { access_token: 'tok' } })
      },
    })

  it('PASS when all registry workers agree with defaultProvider', async () => {
    const probes = makeConfigProbes(
      { defaultProvider: 'claude' },
      { worker1: { provider: 'claude' }, worker2: { provider: 'claude' } },
    )
    const results = await runDoctorChecks(probes, null, undefined, 'claude', '/repo')
    expect(results.find((r) => r.label === 'config: provider')?.status).toBe('PASS')
  })

  it('FAIL when registry workers pin a different provider than defaultProvider', async () => {
    const probes = makeConfigProbes(
      { defaultProvider: 'claude' },
      { worker1: { provider: 'codex' }, worker2: { provider: 'claude' } },
    )
    const results = await runDoctorChecks(probes, null, undefined, 'claude', '/repo')
    const check = results.find((r) => r.label === 'config: provider')
    expect(check?.status).toBe('FAIL')
    expect(check?.message).toContain("defaultProvider='claude'")
    // The old gesture 'mars operator set provider' does not exist — must not appear.
    expect(check?.message).not.toContain('mars operator set provider')
  })

  it('config coherence FAIL gesture comes from the lever registry, not a hardcoded string', async () => {
    const probes = makeConfigProbes(
      { defaultProvider: 'claude' },
      { worker1: { provider: 'codex' } },
    )
    const results = await runDoctorChecks(probes, null, undefined, 'claude', '/repo')
    const check = results.find((r) => r.label === 'config: provider')
    expect(check?.status).toBe('FAIL')

    // Read the gesture from the lever registry — the same source doctor uses.
    const { loadLeverRegistry } = await import('../../core/lib/lever-registry')
    const providerLever = loadLeverRegistry().find((e) => e.id === 'provider.default')
    expect(providerLever?.gesture).toBeDefined()

    // The gesture base (prefix before the placeholder) must appear in the message.
    // This ensures doctor reads from the registry rather than embedding a separate copy.
    const gestureBase = (providerLever!.gesture as string).replace('<claude|codex|gemini>', 'codex')
    expect(check?.message).toContain(gestureBase)
  })

  it('config coherence FAIL message offers both directions and does not pick a side', async () => {
    const probes = makeConfigProbes(
      { defaultProvider: 'claude' },
      {
        worker1: { provider: 'codex' },
        worker2: { provider: 'codex' },
        worker3: { provider: 'codex' },
      },
    )
    const results = await runDoctorChecks(probes, null, undefined, 'claude', '/repo')
    const check = results.find((r) => r.label === 'config: provider')
    expect(check?.status).toBe('FAIL')
    // Must offer the "align daemon.json to registry" direction with the correct command.
    expect(check?.message).toContain('mars lever set provider.default codex')
    // Must acknowledge the re-seed direction rather than silently omitting it.
    expect(check?.message).toContain("re-seed the registry to 'claude'")
  })

  it('skips coherence check when repoRoot is null', async () => {
    const probes = makeConfigProbes({ defaultProvider: 'claude' }, { worker1: { provider: 'codex' } })
    const results = await runDoctorChecks(probes, null, undefined, 'claude', null)
    expect(results.find((r) => r.label === 'config: provider')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Health checks — unknown daemon.json keys
// ---------------------------------------------------------------------------

describe('runDoctorChecks — unknown daemon.json keys', () => {
  it('WARN when daemon.json has unknown top-level keys', async () => {
    const probes = passingProbes({
      readTextFile(path) {
        if (path.endsWith('daemon.json')) {
          return JSON.stringify({ defaultProvider: 'claude', legacyFeatureFlag: true })
        }
        if (path.endsWith('worker-registry.json')) return JSON.stringify({})
        return JSON.stringify({ tokens: { access_token: 'tok' } })
      },
    })
    const results = await runDoctorChecks(probes, null, undefined, 'claude', '/repo')
    const check = results.find((r) => r.label === 'config: daemon.json keys')
    expect(check?.status).toBe('WARN')
    expect(check?.message).toContain("'legacyFeatureFlag'")
  })

  it('no unknown-key result when all keys are known', async () => {
    const probes = passingProbes({
      readTextFile(path) {
        if (path.endsWith('daemon.json')) {
          return JSON.stringify({ defaultProvider: 'claude', paused: false })
        }
        if (path.endsWith('worker-registry.json')) return JSON.stringify({})
        return JSON.stringify({ tokens: { access_token: 'tok' } })
      },
    })
    const results = await runDoctorChecks(probes, null, undefined, 'claude', '/repo')
    expect(results.find((r) => r.label === 'config: daemon.json keys')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Exit code gate
// ---------------------------------------------------------------------------

describe('runDoctorChecks — exit code gate', () => {
  it('exits non-zero when any check FAILs', async () => {
    // Simulate git missing → FAIL
    const probes = passingProbes({
      tryRun(cmd) {
        if (cmd === 'git') return null
        return 0
      },
    })
    const results = await runDoctorChecks(probes, null)
    expect(results.some((r) => r.status === 'FAIL')).toBe(true)
    // The command should exit 1 when there are FAILs
  })

  it('exits zero when worst status is WARN', async () => {
    // All probes healthy → daemon WARN is expected (not running)
    const results = await runDoctorChecks(passingProbes(), null)
    expect(results.some((r) => r.status === 'FAIL')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// doctor command via in-process seam
// ---------------------------------------------------------------------------

describe('mars doctor command (in-process)', () => {
  it('exits 0 or 2 and prints PASS/WARN lines when no FAILs', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['doctor'], {
      store,
      ctx,
      daemon: makeFakeDaemon(),
    })
    // Doctor uses realProbes, so it will actually exec 'claude --version',
    // 'git --version', etc. The test asserts the exit code is consistent with
    // the output: FAIL lines go to err (code 1), skipped registry checks go to
    // out (code 2 — normal in a test env that lacks daemon/db), and a
    // fully-passing run returns code 0.
    const hasFail = r.err.some((line) => line.startsWith('FAIL'))
    const hasSkipped = r.out.some((line) => line.startsWith('skipped'))
    expect(r.code).toBe(hasFail ? 1 : hasSkipped ? 2 : 0)
  })

  it('section headers appear in output when results have sections', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['doctor'], {
      store,
      ctx,
      daemon: makeFakeDaemon(),
    })
    const allLines = [...r.out, ...r.err]
    const hasToolsHeader = allLines.some((l) => l.includes('── Tools'))
    const hasHealthHeader = allLines.some((l) => l.includes('── Health'))
    // Both sections should appear since realProbes always runs both groups
    expect(hasToolsHeader).toBe(true)
    expect(hasHealthHeader).toBe(true)
  })

  it('writes a daemon.json with an orphan key to the test repo and verifies the WARN surfaces', async () => {
    // Write a daemon.json with an unknown key to the test repo
    writeFileSync(
      resolve(repo, '.mars', 'daemon.json'),
      JSON.stringify({ defaultProvider: 'claude', orphanKey: 'oops' }),
    )
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['doctor'], {
      store,
      ctx,
      daemon: makeFakeDaemon(),
    })
    const allLines = [...r.out, ...r.err]
    expect(allLines.some((l) => l.includes("'orphanKey'"))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Doctor registry walk — registry checks appear as ok/finding/skipped lines
// ---------------------------------------------------------------------------

describe('doctor registry walk', () => {
  it('runChecks returns skipped with prereq reason when fs prereq is absent', async () => {
    // After vi.resetModules(), importing health/index triggers daemon-reachable
    // registration in a fresh registry.  Calling runChecks with no prereqs
    // causes daemon-reachable (requires ['fs']) to be skipped.
    const { vi } = await import('vitest')
    vi.resetModules()
    const { runChecks: freshRunChecks } = await import('../../core/health/index.js')
    const results = await freshRunChecks({ prereqs: new Set() })
    const check = results.find((r) => r.id === 'daemon.reachable')
    expect(check?.status).toBe('skipped')
    expect(check?.reason).toBe('prereq:fs')
  })

  it('skipped lines carry a prereq: reason', async () => {
    const { vi } = await import('vitest')
    vi.resetModules()
    const { runChecks: freshRunChecks } = await import('../../core/health/index.js')
    const results = await freshRunChecks({ prereqs: new Set() })
    const skipped = results.filter((r) => r.status === 'skipped')
    expect(skipped.length).toBeGreaterThan(0)
    for (const s of skipped) {
      expect(s.reason).toMatch(/^prereq:/)
    }
  })

  it('doctor command output includes a Checks section with one line per registered check', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['doctor'], { store, ctx, daemon: makeFakeDaemon() })
    const allLines = [...r.out, ...r.err]
    // The Checks section header must appear
    expect(allLines.some((l) => l.includes('── Checks'))).toBe(true)
    // daemon.reachable must have exactly one line
    const daemonLines = allLines.filter((l) => l.includes('daemon.reachable'))
    expect(daemonLines).toHaveLength(1)
    // That line must start with ok, finding, or skipped
    expect(daemonLines[0]).toMatch(/^(?:ok|finding|skipped)\s/)
  })

  it('doctor output marks daemon.reachable as finding when daemon is not running', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['doctor'], { store, ctx, daemon: makeFakeDaemon() })
    const allLines = [...r.out, ...r.err]
    const daemonLine = allLines.find((l) => l.includes('daemon.reachable'))
    // Daemon is not running in tests, so finding (not ok, not skipped)
    expect(daemonLine).toMatch(/^finding\s/)
    expect(daemonLine).toContain('daemon.reachable')
  })
})

// ---------------------------------------------------------------------------
// Gesture validity — every 'mars X Y' command in doctor messages is a known
// CLI path. This prevents a class of defect where a FAIL message names a
// command that does not exist.
// ---------------------------------------------------------------------------

describe("doctor gestures — every 'mars ...' command in FAIL/WARN messages is a known CLI path", () => {
  it('all mars commands mentioned in check messages resolve to registered command paths', async () => {
    // Exercise every probe configuration that produces FAIL/WARN messages with
    // 'mars ...' remediation strings so we catch gesture drift.
    const configs: Array<{ label: string; probes: DoctorProbes; pgDsnPath: string | null; repoRoot: string | null }> = [
      {
        label: 'git missing',
        probes: passingProbes({ tryRun: (cmd) => (cmd === 'git' ? null : 0) }),
        pgDsnPath: null,
        repoRoot: null,
      },
      {
        label: 'db dsn missing',
        probes: passingProbes({ fileReadable: () => false }),
        pgDsnPath: '/some/.mars/pg.dsn',
        repoRoot: null,
      },
      {
        label: 'low disk (< 1 GiB)',
        probes: passingProbes({ freeDiskBytes: () => 500 * 1024 * 1024 }),
        pgDsnPath: null,
        repoRoot: '/repo',
      },
      {
        label: 'low disk (1–5 GiB)',
        probes: passingProbes({ freeDiskBytes: () => 2 * 1024 * 1024 * 1024 }),
        pgDsnPath: null,
        repoRoot: '/repo',
      },
      {
        label: 'baseline gates db unavailable',
        probes: passingProbes({ baselineGates: async () => null }),
        pgDsnPath: null,
        repoRoot: '/repo',
      },
      {
        label: 'no verify gates configured',
        probes: passingProbes({ baselineGates: async () => [] }),
        pgDsnPath: null,
        repoRoot: '/repo',
      },
      {
        label: 'config provider mismatch',
        probes: passingProbes({
          readTextFile(path) {
            if (path.endsWith('daemon.json')) return JSON.stringify({ defaultProvider: 'claude' })
            if (path.endsWith('worker-registry.json')) return JSON.stringify({ w1: { provider: 'codex' } })
            return JSON.stringify({ tokens: { access_token: 'tok' } })
          },
        }),
        pgDsnPath: null,
        repoRoot: '/repo',
      },
    ]

    // Build the set of known registered command paths (e.g. "daemon restart",
    // "lever set", "worktree reclaim") so we can validate extracted gestures.
    const { allCommands } = await import('../commands/index')
    const knownPaths = new Set(allCommands.map((c) => c.path))

    // Extract every 'mars X ...' occurrence from a message string.
    const extractMarsCommands = (msg: string): string[] => {
      const matches: string[] = []
      // Match single-quoted 'mars ...' and backtick-quoted `mars ...` spans.
      for (const pattern of [/'(mars [^']+)'/g, /`(mars [^`]+)`/g]) {
        for (const m of msg.matchAll(pattern)) {
          matches.push(m[1]!)
        }
      }
      return matches
    }

    // Resolve a "mars X Y Z ..." invocation to its command path by trying
    // prefixes from longest to shortest (commands have 1–3 token paths).
    const resolveGesture = (invocation: string): string | null => {
      // Strip leading "mars " and any trailing arguments / placeholders.
      const afterMars = invocation.replace(/^mars\s+/, '').trim()
      const tokens = afterMars.split(/\s+/)
      for (let len = Math.min(tokens.length, 3); len >= 1; len--) {
        const candidate = tokens.slice(0, len).join(' ')
        if (knownPaths.has(candidate)) return candidate
      }
      return null
    }

    const failures: string[] = []

    for (const config of configs) {
      const results = await runDoctorChecks(
        config.probes,
        config.pgDsnPath,
        providerProbeDeps(),
        'claude',
        config.repoRoot,
      )
      for (const r of results) {
        for (const marsCmd of extractMarsCommands(r.message)) {
          const resolved = resolveGesture(marsCmd)
          if (resolved === null) {
            failures.push(`[${config.label}] check '${r.label}' (${r.status}): '${marsCmd}' does not resolve to a known command path`)
          }
        }
      }
    }

    if (failures.length > 0) {
      throw new Error('Doctor messages reference non-existent commands:\n' + failures.join('\n'))
    }
  })
})

// ---------------------------------------------------------------------------
// Health checks — node_modules boundary (H6)
// ---------------------------------------------------------------------------

describe('runDoctorChecks — node_modules boundary', () => {
  /** Build probes where .modules.yaml for a given workspace returns the supplied content. */
  const makeBoundaryProbes = (
    workspace: 'orchestrator' | 'ui',
    modulesYamlContent: string | null,
  ): DoctorProbes =>
    passingProbes({
      readTextFile(path) {
        if (path.endsWith(`${workspace}/node_modules/.modules.yaml`)) {
          return modulesYamlContent
        }
        return JSON.stringify({ tokens: { access_token: 'tok' } })
      },
    })

  it('skips all boundary checks when repoRoot is null', async () => {
    const probes = makeBoundaryProbes('orchestrator', 'virtualStoreDir: .pnpm\n')
    const results = await runDoctorChecks(probes, null, undefined, 'claude', null)
    const boundaryResults = results.filter((r) => r.label.startsWith('node_modules boundary'))
    expect(boundaryResults).toHaveLength(0)
  })

  it('skips a workspace whose .modules.yaml does not exist (null readTextFile)', async () => {
    // .modules.yaml doesn't exist → no check result for that workspace.
    const probes = makeBoundaryProbes('orchestrator', null)
    const results = await runDoctorChecks(probes, null, undefined, 'claude', '/repo')
    expect(results.find((r) => r.label === 'node_modules boundary: orchestrator')).toBeUndefined()
  })

  it('skips a workspace whose .modules.yaml has no virtualStoreDir field', async () => {
    const probes = makeBoundaryProbes('orchestrator', 'hoistedDependencies: {}\n')
    const results = await runDoctorChecks(probes, null, undefined, 'claude', '/repo')
    expect(results.find((r) => r.label === 'node_modules boundary: orchestrator')).toBeUndefined()
  })

  it('PASS when virtualStoreDir resolves inside the checkout', async () => {
    // ".pnpm" relative to "/repo/orchestrator/node_modules/" resolves to
    // "/repo/orchestrator/node_modules/.pnpm", which is inside "/repo".
    const probes = makeBoundaryProbes('orchestrator', 'virtualStoreDir: .pnpm\n')
    const results = await runDoctorChecks(probes, null, undefined, 'claude', '/repo')
    const check = results.find((r) => r.label === 'node_modules boundary: orchestrator')
    expect(check?.status).toBe('PASS')
  })

  it('FAIL when virtualStoreDir resolves outside the checkout', async () => {
    // "../../../../worktrees/task-id/orchestrator/node_modules/.pnpm" relative to
    // "/repo/orchestrator/node_modules/" escapes "/repo".
    const probes = makeBoundaryProbes(
      'orchestrator',
      'virtualStoreDir: ../../../../worktrees/task-id/orchestrator/node_modules/.pnpm\n',
    )
    const results = await runDoctorChecks(probes, null, undefined, 'claude', '/repo')
    const check = results.find((r) => r.label === 'node_modules boundary: orchestrator')
    expect(check?.status).toBe('FAIL')
    expect(check?.message).toContain('leaked into the main checkout')
    expect(check?.message).toContain('CI=true pnpm install --frozen-lockfile')
  })

  it('FAIL message includes the escaped resolved path for diagnostics', async () => {
    const probes = makeBoundaryProbes(
      'ui',
      'virtualStoreDir: ../../../../.mars/worktrees/mars-abc/ui/node_modules/.pnpm\n',
    )
    const results = await runDoctorChecks(probes, null, undefined, 'claude', '/repo')
    const check = results.find((r) => r.label === 'node_modules boundary: ui')
    expect(check?.status).toBe('FAIL')
    // The resolved path must appear so operators know exactly where the store is.
    expect(check?.message).toMatch(/mars-abc/)
  })

  it('checks both orchestrator and ui independently', async () => {
    const probes = passingProbes({
      readTextFile(path) {
        if (path.endsWith('orchestrator/node_modules/.modules.yaml')) {
          return 'virtualStoreDir: .pnpm\n'
        }
        if (path.endsWith('ui/node_modules/.modules.yaml')) {
          return 'virtualStoreDir: ../../../../escaped/node_modules/.pnpm\n'
        }
        return JSON.stringify({ tokens: { access_token: 'tok' } })
      },
    })
    const results = await runDoctorChecks(probes, null, undefined, 'claude', '/repo')
    expect(results.find((r) => r.label === 'node_modules boundary: orchestrator')?.status).toBe('PASS')
    expect(results.find((r) => r.label === 'node_modules boundary: ui')?.status).toBe('FAIL')
  })

  // Workspace root checks (single-root pnpm workspace: virtual store lives in
  // the root node_modules/.pnpm, so the root must also be validated).

  it('PASS when workspace root virtualStoreDir resolves inside the checkout', async () => {
    // After a single-root pnpm workspace install, pnpm writes the virtual
    // store at <root>/node_modules/.pnpm. The boundary check should confirm
    // the store is self-contained.
    const probes = passingProbes({
      readTextFile(path) {
        // Match the root node_modules/.modules.yaml (not under a sub-package).
        if (path.match(/\/node_modules\/\.modules\.yaml$/) && !path.match(/\/(orchestrator|ui)\/node_modules/)) {
          return 'virtualStoreDir: .pnpm\n'
        }
        return null
      },
    })
    const results = await runDoctorChecks(probes, null, undefined, 'claude', '/repo')
    const check = results.find((r) => r.label === 'node_modules boundary: workspace root')
    expect(check?.status).toBe('PASS')
    expect(check?.message).toContain('workspace root/node_modules is self-contained')
  })

  it('FAIL when workspace root virtualStoreDir resolves outside the checkout', async () => {
    // The virtual store in the root node_modules points back into a worktree —
    // the classic "install escaped" corruption scenario for a workspace setup.
    const probes = passingProbes({
      readTextFile(path) {
        if (path.match(/\/node_modules\/\.modules\.yaml$/) && !path.match(/\/(orchestrator|ui)\/node_modules/)) {
          return 'virtualStoreDir: ../../../.mars/worktrees/mars-abc/node_modules/.pnpm\n'
        }
        return null
      },
    })
    const results = await runDoctorChecks(probes, null, undefined, 'claude', '/repo')
    const check = results.find((r) => r.label === 'node_modules boundary: workspace root')
    expect(check?.status).toBe('FAIL')
    expect(check?.message).toContain('leaked into the main checkout')
    expect(check?.message).toContain('CI=true pnpm install --frozen-lockfile')
    expect(check?.message).toMatch(/mars-abc/)
  })
})

// ---------------------------------------------------------------------------
// Health checks — install-site fragmentation (H7)
// ---------------------------------------------------------------------------

describe('runDoctorChecks — install-site fragmentation', () => {
  it('emits no row when the repo has no lockfile', async () => {
    const probes = passingProbes({
      installSites: async () => [],
    })
    const results = await runDoctorChecks(probes, null, undefined, 'claude', '/repo')
    expect(results.find((r) => r.label === 'install-site fragmentation')).toBeUndefined()
  })

  it('skips the check entirely when repoRoot is null', async () => {
    const probes = passingProbes({
      installSites: async () => [
        { dir: '/repo', manager: 'pnpm', lockfile: 'pnpm-lock.yaml' },
        { dir: '/repo/sub', manager: 'pnpm', lockfile: 'pnpm-lock.yaml' },
      ],
    })
    const results = await runDoctorChecks(probes, null, undefined, 'claude', null)
    expect(results.find((r) => r.label === 'install-site fragmentation')).toBeUndefined()
  })

  it('PASS for a single install site', async () => {
    const probes = passingProbes({
      installSites: async () => [
        { dir: '/repo', manager: 'pnpm', lockfile: 'pnpm-lock.yaml' },
      ],
    })
    const results = await runDoctorChecks(probes, null, undefined, 'claude', '/repo')
    const check = results.find((r) => r.label === 'install-site fragmentation')
    expect(check?.status).toBe('PASS')
    expect(check?.message).toContain('1 install site')
  })

  it('PASS for multiple lockfiles unified by a root pnpm-workspace.yaml', async () => {
    const probes = passingProbes({
      installSites: async () => [
        { dir: '/repo', manager: 'pnpm', lockfile: 'pnpm-lock.yaml' },
        { dir: '/repo/packages/foo', manager: 'pnpm', lockfile: 'pnpm-lock.yaml' },
        { dir: '/repo/packages/bar', manager: 'pnpm', lockfile: 'pnpm-lock.yaml' },
      ],
      readTextFile(path) {
        if (path.endsWith('pnpm-workspace.yaml')) return 'packages:\n  - packages/*\n'
        return JSON.stringify({ tokens: { access_token: 'tok' } })
      },
    })
    const results = await runDoctorChecks(probes, null, undefined, 'claude', '/repo')
    const check = results.find((r) => r.label === 'install-site fragmentation')
    expect(check?.status).toBe('PASS')
    expect(check?.message).toContain('unified under a workspace')
  })

  it('PASS for multiple lockfiles unified by workspaces field in package.json', async () => {
    const probes = passingProbes({
      installSites: async () => [
        { dir: '/repo', manager: 'npm', lockfile: 'package-lock.json' },
        { dir: '/repo/packages/bar', manager: 'npm', lockfile: 'package-lock.json' },
      ],
      readTextFile(path) {
        if (path.endsWith('pnpm-workspace.yaml')) return null
        if (path.endsWith('package.json')) return JSON.stringify({ workspaces: ['packages/*'] })
        return JSON.stringify({ tokens: { access_token: 'tok' } })
      },
    })
    const results = await runDoctorChecks(probes, null, undefined, 'claude', '/repo')
    const check = results.find((r) => r.label === 'install-site fragmentation')
    expect(check?.status).toBe('PASS')
    expect(check?.message).toContain('unified under a workspace')
  })

  it('WARN for multiple independent pnpm lockfiles with no workspace config', async () => {
    const probes = passingProbes({
      installSites: async () => [
        { dir: '/repo', manager: 'pnpm', lockfile: 'pnpm-lock.yaml' },
        { dir: '/repo/sub', manager: 'pnpm', lockfile: 'pnpm-lock.yaml' },
        { dir: '/repo/other', manager: 'pnpm', lockfile: 'pnpm-lock.yaml' },
      ],
      readTextFile(path) {
        if (path.endsWith('pnpm-workspace.yaml')) return null
        if (path.endsWith('package.json')) return null
        return JSON.stringify({ tokens: { access_token: 'tok' } })
      },
    })
    const results = await runDoctorChecks(probes, null, undefined, 'claude', '/repo')
    const check = results.find((r) => r.label === 'install-site fragmentation')
    expect(check?.status).toBe('WARN')
    expect(check?.message).toContain('3')
    expect(check?.message).toContain('pnpm')
    expect(check?.message).toContain('pnpm-workspace.yaml')
  })

  it('WARN message names the manager and fix gesture for npm', async () => {
    const probes = passingProbes({
      installSites: async () => [
        { dir: '/repo', manager: 'npm', lockfile: 'package-lock.json' },
        { dir: '/repo/backend', manager: 'npm', lockfile: 'package-lock.json' },
      ],
      readTextFile(path) {
        if (path.endsWith('pnpm-workspace.yaml')) return null
        // package.json exists but has no workspaces field
        if (path.endsWith('package.json')) return JSON.stringify({ name: 'root' })
        return JSON.stringify({ tokens: { access_token: 'tok' } })
      },
    })
    const results = await runDoctorChecks(probes, null, undefined, 'claude', '/repo')
    const check = results.find((r) => r.label === 'install-site fragmentation')
    expect(check?.status).toBe('WARN')
    expect(check?.message).toContain('2')
    expect(check?.message).toContain('npm')
    expect(check?.message).toContain('workspaces')
  })

  it('WARN message mentions mixed managers when lockfiles use different package managers', async () => {
    const probes = passingProbes({
      installSites: async () => [
        { dir: '/repo', manager: 'pnpm', lockfile: 'pnpm-lock.yaml' },
        { dir: '/repo/sub', manager: 'npm', lockfile: 'package-lock.json' },
      ],
      readTextFile(path) {
        if (path.endsWith('pnpm-workspace.yaml')) return null
        if (path.endsWith('package.json')) return null
        return JSON.stringify({ tokens: { access_token: 'tok' } })
      },
    })
    const results = await runDoctorChecks(probes, null, undefined, 'claude', '/repo')
    const check = results.find((r) => r.label === 'install-site fragmentation')
    expect(check?.status).toBe('WARN')
    expect(check?.message).toContain('mixed')
  })

  it('mars doctor exits 0 when the only finding is this WARN', async () => {
    // This test verifies the WARN does not cause a non-zero exit by confirming
    // no FAIL is returned from runDoctorChecks alongside the WARN.
    const probes = passingProbes({
      installSites: async () => [
        { dir: '/repo', manager: 'pnpm', lockfile: 'pnpm-lock.yaml' },
        { dir: '/repo/sub', manager: 'pnpm', lockfile: 'pnpm-lock.yaml' },
      ],
      readTextFile(path) {
        if (path.endsWith('pnpm-workspace.yaml')) return null
        if (path.endsWith('package.json')) return null
        return JSON.stringify({ tokens: { access_token: 'tok' } })
      },
    })
    const results = await runDoctorChecks(probes, null, undefined, 'claude', '/repo')
    const fragCheck = results.find((r) => r.label === 'install-site fragmentation')
    expect(fragCheck?.status).toBe('WARN')
    // The WARN must not be the only FAIL — the command exits 0 when hasFail is false.
    expect(results.filter((r) => r.status === 'FAIL')).toHaveLength(0)
  })
})
