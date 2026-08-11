import { describe, it, expect } from 'vitest'
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
