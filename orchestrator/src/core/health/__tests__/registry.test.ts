import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  createHealthRegistry,
  type HealthCheck,
  type HealthCheckDescriptor,
  type HealthCheckResult,
} from '../index.js'

// ─── helpers ──────────────────────────────────────────────────────────────────

const makeCheck = (
  id: string,
  result: HealthCheckResult = { status: 'pass' },
): HealthCheck => ({
  descriptor: {
    id,
    label: `Check ${id}`,
    findingRoute: 'action-queue',
  } satisfies HealthCheckDescriptor,
  run: async () => result,
})

// ─── tests ────────────────────────────────────────────────────────────────────

describe('createHealthRegistry', () => {
  it('starts empty', () => {
    const registry = createHealthRegistry()
    expect(registry.all()).toEqual([])
  })

  it('registers a check and returns it via all()', () => {
    const registry = createHealthRegistry()
    const check = makeCheck('baseline-broken')
    registry.register(check)
    expect(registry.all()).toHaveLength(1)
    expect(registry.all()[0]).toBe(check)
  })

  it('retrieves a registered check by id', () => {
    const registry = createHealthRegistry()
    const check = makeCheck('baseline-broken')
    registry.register(check)
    expect(registry.get('baseline-broken')).toBe(check)
  })

  it('returns undefined for an unknown id', () => {
    const registry = createHealthRegistry()
    expect(registry.get('nonexistent')).toBeUndefined()
  })

  it('preserves registration order across multiple checks', () => {
    const registry = createHealthRegistry()
    const a = makeCheck('a')
    const b = makeCheck('b')
    const c = makeCheck('c')
    registry.register(a)
    registry.register(b)
    registry.register(c)
    expect(registry.all().map((ch) => ch.descriptor.id)).toEqual(['a', 'b', 'c'])
  })

  it('replaces a prior registration when the same id is registered twice', () => {
    const registry = createHealthRegistry()
    const original = makeCheck('baseline-broken')
    const replacement = makeCheck('baseline-broken')
    registry.register(original)
    registry.register(replacement)
    expect(registry.all()).toHaveLength(1)
    expect(registry.get('baseline-broken')).toBe(replacement)
  })

  it('a registered check runs and returns its result', async () => {
    const registry = createHealthRegistry()
    const failResult: HealthCheckResult = {
      status: 'fail',
      detail: 'gate typecheck fails on integration branch',
      payload: { failingGateName: 'typecheck', output: 'Type error' },
    }
    const check = makeCheck('baseline-broken', failResult)
    registry.register(check)

    const result = await registry.get('baseline-broken')!.run()
    expect(result.status).toBe('fail')
    if (result.status === 'fail') {
      expect(result.detail).toContain('typecheck')
      expect(result.payload['failingGateName']).toBe('typecheck')
    }
  })

  it('a fix-route check has findingRoute fix-task', () => {
    const registry = createHealthRegistry()
    const check: HealthCheck = {
      descriptor: {
        id: 'fragmented-repo-layout',
        label: 'Repo layout: node_modules boundary',
        findingRoute: 'fix-task',
      },
      run: async () => ({ status: 'pass' }),
    }
    registry.register(check)
    expect(registry.get('fragmented-repo-layout')?.descriptor.findingRoute).toBe('fix-task')
  })
})

// ─── singleton registry (registerCheck / listChecks / runChecks) ──────────────
//
// The module-level registry is reset between tests via vi.resetModules() so
// each test gets a clean slate.  All imports are dynamic (after the reset).

describe('singleton health-check registry', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('listChecks returns every registered check with id, description, requires, and route', async () => {
    const { registerCheck, listChecks } = await import('../registry.js')

    registerCheck({
      id: 'test.list',
      description: 'List test check',
      requires: ['fs'],
      route: 'notice',
      run: async () => ({ ok: true }),
    })

    const checks = listChecks()
    expect(checks).toHaveLength(1)
    expect(checks[0]).toMatchObject({
      id: 'test.list',
      description: 'List test check',
      requires: ['fs'],
      route: 'notice',
    })
  })

  it('runChecks executes a check when all its prereqs are satisfied', async () => {
    const { registerCheck, runChecks } = await import('../registry.js')

    let ran = false
    registerCheck({
      id: 'test.run',
      description: 'Run test check',
      requires: ['fs', 'git'],
      route: 'notice',
      run: async () => {
        ran = true
        return { ok: true }
      },
    })

    const results = await runChecks({ prereqs: new Set(['fs', 'git', 'daemon', 'db']) })
    expect(ran).toBe(true)
    const r = results.find((x) => x.id === 'test.run')
    expect(r?.status).toBe('ok')
  })

  it('runChecks skips a check with a missing prereq and names the reason', async () => {
    const { registerCheck, runChecks } = await import('../registry.js')

    registerCheck({
      id: 'test.skip',
      description: 'Skip test check',
      requires: ['daemon'],
      route: 'alert',
      run: async () => ({ ok: true }),
    })

    // No prereqs satisfied — daemon is missing
    const results = await runChecks({ prereqs: new Set([]) })
    const skipped = results.find((x) => x.id === 'test.skip')
    expect(skipped?.status).toBe('skipped')
    expect(skipped?.reason).toBe('prereq:daemon')
  })

  it('runChecks records status=finding when a check returns ok=false', async () => {
    const { registerCheck, runChecks } = await import('../registry.js')

    registerCheck({
      id: 'test.finding',
      description: 'Finding test check',
      requires: [],
      route: 'alert',
      run: async () => ({ ok: false, findingKey: 'test.broken', detail: 'broken' }),
    })

    const results = await runChecks({ prereqs: new Set([]) })
    const r = results.find((x) => x.id === 'test.finding')
    expect(r?.status).toBe('finding')
    expect(r?.outcome?.findingKey).toBe('test.broken')
  })

  it('registerCheck throws when the same id is registered twice', async () => {
    const { registerCheck } = await import('../registry.js')

    const def: import('../registry.js').CheckDef = {
      id: 'dup.check',
      description: 'Dup',
      requires: [],
      route: 'notice',
      run: async () => ({ ok: true }),
    }
    registerCheck(def)
    expect(() => registerCheck({ ...def })).toThrow("'dup.check' is already registered")
  })

  it("daemon.reachable appears in listChecks() after importing the index module", async () => {
    // Importing index.js triggers the daemon-reachable side-effect registration.
    await import('../index.js')
    const { listChecks } = await import('../registry.js')

    const ids = listChecks().map((c) => c.id)
    expect(ids).toContain('daemon.reachable')
  })
})
