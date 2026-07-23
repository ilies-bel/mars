/**
 * Tests for the DB busy-storm watchdog.
 *
 * Covers two layers:
 *  1. The lib-level sliding-window counter (`lib/db-busy-watchdog`).
 *  2. The daemon-level escalation function (`daemon/db-busy-watchdog`).
 *
 * Both layers are tested through their public interfaces only.
 * Module-level state is reset in `afterEach` via the `__reset*` test helpers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  recordDbBusyError,
  getDbBusyStatus,
  __resetDbBusyStateForTests,
} from '../../lib/db-busy-watchdog'
import {
  checkAndEscalateDbBusyStorm,
  type BusyEscalationStage,
} from '../db-busy-watchdog'

// ── Helper: fill the window with N errors at a given timestamp ────────────────

function seedErrors(count: number, nowMs: number): void {
  for (let i = 0; i < count; i += 1) {
    recordDbBusyError('test', nowMs + i)
  }
}

// ── lib/db-busy-watchdog ──────────────────────────────────────────────────────

describe('db busy-error tracker (lib/db-busy-watchdog)', () => {
  const T0 = 1_000_000

  beforeEach(() => {
    // Ensure a known threshold so tests aren't coupled to the default (10).
    process.env.MARS_BUSY_STORM_THRESHOLD = '5'
    process.env.MARS_BUSY_STORM_WINDOW_MS = '60000'
  })

  afterEach(() => {
    __resetDbBusyStateForTests()
    delete process.env.MARS_BUSY_STORM_THRESHOLD
    delete process.env.MARS_BUSY_STORM_WINDOW_MS
  })

  it('reports no storm when error count is below the threshold', () => {
    seedErrors(4, T0)
    const status = getDbBusyStatus(T0 + 100)
    expect(status.stormDetected).toBe(false)
    expect(status.errorCount).toBe(4)
  })

  it('reports a storm when error count reaches the threshold', () => {
    seedErrors(5, T0)
    const status = getDbBusyStatus(T0 + 100)
    expect(status.stormDetected).toBe(true)
    expect(status.errorCount).toBe(5)
  })

  it('errors older than the window are excluded from the count', () => {
    // 5 errors in the past (outside the 60s window)
    seedErrors(5, T0)
    // 4 errors in the present (inside the window)
    const nowMs = T0 + 70_000 // 70 s later
    seedErrors(4, nowMs)
    const status = getDbBusyStatus(nowMs + 100)
    // Only the 4 recent errors should count; the 5 old ones have expired.
    expect(status.stormDetected).toBe(false)
    expect(status.errorCount).toBe(4)
  })

  it('errors exactly at the window boundary are included', () => {
    const windowMs = 60_000
    // An error at exactly `now - windowMs` is still within the window.
    const errorTime = T0
    recordDbBusyError('test', errorTime)
    const nowMs = T0 + windowMs
    const status = getDbBusyStatus(nowMs)
    expect(status.errorCount).toBe(1)
  })

  it('returns window metadata alongside the count', () => {
    const status = getDbBusyStatus(T0)
    expect(status.windowMs).toBe(60_000)
  })
})

// ── daemon/db-busy-watchdog — escalation stages ───────────────────────────────

describe('checkAndEscalateDbBusyStorm (daemon escalation)', () => {
  const DB_TARGET = '/fake/mars.db'
  const T0 = 2_000_000

  const makeHandlers = (): {
    log: ReturnType<typeof vi.fn>
    recyclePool: ReturnType<typeof vi.fn>
    triggerRestart: ReturnType<typeof vi.fn>
  } => ({
    log: vi.fn(),
    recyclePool: vi.fn().mockResolvedValue(undefined),
    triggerRestart: vi.fn(),
  })

  beforeEach(() => {
    process.env.MARS_BUSY_STORM_THRESHOLD = '5'
    process.env.MARS_BUSY_STORM_WINDOW_MS = '60000'
  })

  afterEach(() => {
    __resetDbBusyStateForTests()
    delete process.env.MARS_BUSY_STORM_THRESHOLD
    delete process.env.MARS_BUSY_STORM_WINDOW_MS
    delete process.env.MARS_DB_BUSY_STORM_RESTART
    vi.restoreAllMocks()
  })

  it('returns action:none and nextStage:null when no storm is active', async () => {
    // Only 3 errors — below threshold of 5.
    seedErrors(3, T0)
    const h = makeHandlers()
    const result = await checkAndEscalateDbBusyStorm(DB_TARGET, h.log, h.recyclePool, h.triggerRestart, null, T0 + 100)
    expect(result.action).toBe('none')
    expect(result.nextStage).toBeNull()
    expect(h.log).not.toHaveBeenCalled()
  })

  it('logs loudly (stage 1) on the first tick where storm is detected', async () => {
    seedErrors(5, T0)
    const h = makeHandlers()
    const result = await checkAndEscalateDbBusyStorm(DB_TARGET, h.log, h.recyclePool, h.triggerRestart, null, T0 + 100)
    expect(result.action).toBe('logged')
    expect(result.nextStage).toBe('warn')
    expect(h.log).toHaveBeenCalledOnce()
    expect(h.log.mock.calls[0][0]).toContain('STORM DETECTED')
    expect(h.recyclePool).not.toHaveBeenCalled()
    expect(h.triggerRestart).not.toHaveBeenCalled()
  })

  it('attempts pool recycle (stage 2) when storm persists after warn stage', async () => {
    seedErrors(5, T0)
    const h = makeHandlers()
    const result = await checkAndEscalateDbBusyStorm(
      DB_TARGET, h.log, h.recyclePool, h.triggerRestart,
      'warn' satisfies BusyEscalationStage,
      T0 + 100,
    )
    expect(result.action).toBe('recycled')
    expect(result.nextStage).toBe('recycle')
    expect(h.recyclePool).toHaveBeenCalledOnce()
    expect(h.recyclePool).toHaveBeenCalledWith(DB_TARGET)
    expect(h.triggerRestart).not.toHaveBeenCalled()
  })

  it('logs the recycle attempt (stage 2)', async () => {
    seedErrors(5, T0)
    const h = makeHandlers()
    await checkAndEscalateDbBusyStorm(DB_TARGET, h.log, h.recyclePool, h.triggerRestart, 'warn', T0 + 100)
    expect(h.log).toHaveBeenCalledOnce()
    expect(h.log.mock.calls[0][0]).toContain('pool recycle')
  })

  it('triggers daemon restart (stage 3) when storm persists after recycle stage', async () => {
    seedErrors(5, T0)
    const h = makeHandlers()
    const result = await checkAndEscalateDbBusyStorm(
      DB_TARGET, h.log, h.recyclePool, h.triggerRestart,
      'recycle' satisfies BusyEscalationStage,
      T0 + 100,
    )
    expect(result.action).toBe('restarted')
    expect(result.nextStage).toBe('restart')
    expect(h.triggerRestart).toHaveBeenCalledOnce()
  })

  it('does NOT restart when MARS_DB_BUSY_STORM_RESTART=false (safety gate)', async () => {
    process.env.MARS_DB_BUSY_STORM_RESTART = 'false'
    seedErrors(5, T0)
    const h = makeHandlers()
    const result = await checkAndEscalateDbBusyStorm(
      DB_TARGET, h.log, h.recyclePool, h.triggerRestart,
      'recycle' satisfies BusyEscalationStage,
      T0 + 100,
    )
    expect(result.action).toBe('none')
    // Stage stays at 'recycle' — not advanced (restart suppressed)
    expect(result.nextStage).toBe('recycle')
    expect(h.triggerRestart).not.toHaveBeenCalled()
    expect(h.log).toHaveBeenCalledOnce()
    expect(h.log.mock.calls[0][0]).toContain('suppressed')
  })

  it('resets nextStage to null when storm clears at any escalation level', async () => {
    // Start with warn stage but only 3 errors (below threshold)
    seedErrors(3, T0)
    const h = makeHandlers()
    const result = await checkAndEscalateDbBusyStorm(
      DB_TARGET, h.log, h.recyclePool, h.triggerRestart,
      'warn' satisfies BusyEscalationStage,
      T0 + 100,
    )
    expect(result.nextStage).toBeNull()
    expect(result.action).toBe('none')
    expect(h.recyclePool).not.toHaveBeenCalled()
    expect(h.triggerRestart).not.toHaveBeenCalled()
  })

  it('stays at restart stage without re-triggering restart on subsequent ticks', async () => {
    seedErrors(5, T0)
    const h = makeHandlers()
    const result = await checkAndEscalateDbBusyStorm(
      DB_TARGET, h.log, h.recyclePool, h.triggerRestart,
      'restart' satisfies BusyEscalationStage,
      T0 + 100,
    )
    expect(result.action).toBe('none')
    expect(result.nextStage).toBe('restart')
    expect(h.triggerRestart).not.toHaveBeenCalled()
  })

  it('logs a warning but still returns recycled even when recyclePool rejects', async () => {
    seedErrors(5, T0)
    const h = makeHandlers()
    h.recyclePool.mockRejectedValue(new Error('pool already closed'))
    const result = await checkAndEscalateDbBusyStorm(
      DB_TARGET, h.log, h.recyclePool, h.triggerRestart,
      'warn' satisfies BusyEscalationStage,
      T0 + 100,
    )
    // The watchdog must not propagate the recycle error
    expect(result.action).toBe('recycled')
    expect(result.nextStage).toBe('recycle')
    expect(h.log).toHaveBeenCalled()
    // At least one log message should mention the error
    const logMessages: string[] = h.log.mock.calls.map((c: unknown[]) => String(c[0]))
    expect(logMessages.some((m) => m.includes('pool already closed') || m.includes('recycle'))).toBe(true)
  })
})
