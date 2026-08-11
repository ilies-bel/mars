/**
 * Tests for the shared pass.ts contract.
 *
 * These tests verify the observable behaviour of the three primitives that
 * every health-pass route consumer depends on:
 *   1. runPass — drives a pass over a set of checks, respects posture='off'
 *   2. createInMemoryNoticeStore — notice-route deduplication (stateable-once,
 *      silenceable)
 *   3. createInMemoryAlertStore  — alert-route condition-keyed deduplication
 */

import { describe, it, expect } from 'vitest'
import {
  runPass,
  createInMemoryNoticeStore,
  createInMemoryAlertStore,
  type PassDeps,
  type HealthCheckPosture,
} from '../pass.js'
import type { HealthCheck, HealthCheckResult } from '../index.js'

// ─── helpers ──────────────────────────────────────────────────────────────────

const makeCheck = (
  id: string,
  result: HealthCheckResult = { status: 'pass' },
): HealthCheck => ({
  descriptor: { id, label: `Check ${id}`, findingRoute: 'notice' },
  run: async () => result,
})

const failCheck = (id: string): HealthCheck =>
  makeCheck(id, { status: 'fail', detail: `${id} failed`, payload: { checkId: id } })

const deps = (overrides: Record<string, HealthCheckPosture> = {}): PassDeps => ({
  getPosture: (id) => overrides[id] ?? 'automatic',
})

// ─── runPass ──────────────────────────────────────────────────────────────────

describe('runPass', () => {
  it('returns empty findings when all checks pass', async () => {
    const result = await runPass([makeCheck('a'), makeCheck('b')], deps())
    expect(result.findings).toHaveLength(0)
    expect(result.skipped).toHaveLength(0)
  })

  it('includes a failing check in findings with posture automatic by default', async () => {
    const result = await runPass([failCheck('a')], deps())
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]!.check.descriptor.id).toBe('a')
    expect(result.findings[0]!.posture).toBe('automatic')
  })

  it('skips a check with posture off without running it', async () => {
    let ran = false
    const check: HealthCheck = {
      descriptor: { id: 'x', label: 'X', findingRoute: 'action-queue' },
      run: async () => {
        ran = true
        return { status: 'fail', detail: 'x failed', payload: {} }
      },
    }
    const result = await runPass([check], deps({ x: 'off' }))
    expect(result.skipped).toContain('x')
    expect(result.findings).toHaveLength(0)
    expect(ran).toBe(false)
  })

  it('carries posture manual through to the finding', async () => {
    const result = await runPass([failCheck('m')], deps({ m: 'manual' }))
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]!.posture).toBe('manual')
  })

  it('includes only failing checks — passing checks do not appear in findings', async () => {
    const result = await runPass([makeCheck('pass'), failCheck('fail')], deps())
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]!.check.descriptor.id).toBe('fail')
  })

  it('preserves the fail result detail and payload on the finding', async () => {
    const result = await runPass([failCheck('chk')], deps())
    const finding = result.findings[0]!
    expect(finding.result.detail).toBe('chk failed')
    expect(finding.result.payload).toEqual({ checkId: 'chk' })
  })

  it('mixes skipped and findings in the same pass', async () => {
    const result = await runPass(
      [failCheck('a'), makeCheck('b'), failCheck('c')],
      deps({ b: 'off' }),
    )
    expect(result.skipped).toEqual(['b'])
    expect(result.findings.map((f) => f.check.descriptor.id)).toEqual(['a', 'c'])
  })
})

// ─── createInMemoryNoticeStore ───────────────────────────────────────────────

describe('createInMemoryNoticeStore', () => {
  it('reports not stated initially', async () => {
    const store = createInMemoryNoticeStore()
    expect(await store.hasBeenStated('check-1')).toBe(false)
  })

  it('reports stated after markStated', async () => {
    const store = createInMemoryNoticeStore()
    await store.markStated('check-1')
    expect(await store.hasBeenStated('check-1')).toBe(true)
  })

  it('resets stated flag via resetStated', async () => {
    const store = createInMemoryNoticeStore()
    await store.markStated('check-1')
    await store.resetStated('check-1')
    expect(await store.hasBeenStated('check-1')).toBe(false)
  })

  it('resetStated is a no-op when not stated', async () => {
    const store = createInMemoryNoticeStore()
    await store.resetStated('check-1')
    expect(await store.hasBeenStated('check-1')).toBe(false)
  })

  it('reports not silenced initially', async () => {
    const store = createInMemoryNoticeStore()
    expect(await store.isSilenced('check-1')).toBe(false)
  })

  it('reports silenced after silence', async () => {
    const store = createInMemoryNoticeStore()
    await store.silence('check-1')
    expect(await store.isSilenced('check-1')).toBe(true)
  })

  it('silence is idempotent', async () => {
    const store = createInMemoryNoticeStore()
    await store.silence('check-1')
    await store.silence('check-1')
    expect(await store.isSilenced('check-1')).toBe(true)
  })

  it('isolates state per check id', async () => {
    const store = createInMemoryNoticeStore()
    await store.markStated('a')
    await store.silence('b')
    expect(await store.hasBeenStated('b')).toBe(false)
    expect(await store.isSilenced('a')).toBe(false)
  })
})

// ─── createInMemoryAlertStore ─────────────────────────────────────────────────

describe('createInMemoryAlertStore', () => {
  it('returns null for an unknown check id', async () => {
    const store = createInMemoryAlertStore()
    expect(await store.getOpenAlertId('x')).toBeNull()
  })

  it('stores and retrieves the alert id', async () => {
    const store = createInMemoryAlertStore()
    await store.setOpenAlertId('x', 'aq-item-123')
    expect(await store.getOpenAlertId('x')).toBe('aq-item-123')
  })

  it('clears the alert id', async () => {
    const store = createInMemoryAlertStore()
    await store.setOpenAlertId('x', 'aq-item-123')
    await store.clearAlert('x')
    expect(await store.getOpenAlertId('x')).toBeNull()
  })

  it('clearAlert is a no-op when no alert is open', async () => {
    const store = createInMemoryAlertStore()
    await store.clearAlert('x')
    expect(await store.getOpenAlertId('x')).toBeNull()
  })

  it('replaces a prior alert id on setOpenAlertId', async () => {
    const store = createInMemoryAlertStore()
    await store.setOpenAlertId('x', 'first')
    await store.setOpenAlertId('x', 'second')
    expect(await store.getOpenAlertId('x')).toBe('second')
  })

  it('isolates alert state per check id', async () => {
    const store = createInMemoryAlertStore()
    await store.setOpenAlertId('a', 'aq-a')
    expect(await store.getOpenAlertId('b')).toBeNull()
  })
})
