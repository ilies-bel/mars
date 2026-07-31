import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UsageSnapshotRow } from '../usage-snapshot-store.js'
import {
  computeBudgetPressure,
  getBudgetPressureConfig,
  type BudgetPressureConfig,
} from '../budget-pressure.js'

const config: BudgetPressureConfig = { tightPct: 70, criticalPct: 90 }
const now = new Date('2026-07-31T12:00:00.000Z')

const snapshot = (usedPct: number, nextResetAt: string | null): UsageSnapshotRow => ({
  id: 1,
  capturedAt: now.toISOString(),
  inputTokens: 0,
  outputTokens: 0,
  windowKind: 'rolling',
  rawJson: { usedPct, nextResetAt },
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('computeBudgetPressure', () => {
  it('returns critical once usage reaches the critical threshold', () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)

    expect(
      computeBudgetPressure(snapshot(90, '2026-07-31T13:00:00.000Z'), config),
    ).toBe('critical')

  })

  it.each([
    ['ok below the tight threshold', 69, '2026-07-31T15:00:01.000Z', 'ok'],
    ['tight at its threshold with more than two hours left', 70, '2026-07-31T14:00:01.000Z', 'tight'],
    ['ok at the tight threshold with exactly two hours left', 70, '2026-07-31T14:00:00.000Z', 'ok'],
    ['ok below critical when the reset is imminent', 89, '2026-07-31T13:00:00.000Z', 'ok'],
    ['ok when no reset time is available', 99, null, 'ok'],
    ['ok when the reported reset time has passed', 99, '2026-07-31T11:59:59.000Z', 'ok'],
  ])('returns %s', (_description, usedPct, nextResetAt, expected) => {
    vi.useFakeTimers()
    vi.setSystemTime(now)

    expect(computeBudgetPressure(snapshot(usedPct, nextResetAt), config)).toBe(expected)
  })
})

describe('getBudgetPressureConfig', () => {
  it('uses the default thresholds', () => {
    expect(getBudgetPressureConfig()).toEqual({ tightPct: 70, criticalPct: 90 })
  })

  it('uses valid environment overrides', () => {
    vi.stubEnv('MARS_BUDGET_TIGHT_PCT', '65')
    vi.stubEnv('MARS_BUDGET_CRITICAL_PCT', '85')

    expect(getBudgetPressureConfig()).toEqual({ tightPct: 65, criticalPct: 85 })
  })

  it('falls back to defaults for invalid environment overrides', () => {
    vi.stubEnv('MARS_BUDGET_TIGHT_PCT', 'not-a-number')
    vi.stubEnv('MARS_BUDGET_CRITICAL_PCT', '101')

    expect(getBudgetPressureConfig()).toEqual({ tightPct: 70, criticalPct: 90 })
  })
})
