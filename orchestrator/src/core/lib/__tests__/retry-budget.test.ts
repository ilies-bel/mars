import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SELF_HEAL_BUDGET,
  getRetryBudget,
  retryBudgetBySignature,
} from '../retry-budget'

describe('getRetryBudget', () => {
  it('returns 3 for the daemon-killed signature', () => {
    expect(getRetryBudget('daemon-killed')).toBe(3)
  })

  it('returns the default budget of 1 for an unknown signature', () => {
    expect(getRetryBudget('verify:has-diff/no-commits-ahead')).toBe(
      DEFAULT_SELF_HEAL_BUDGET,
    )
    expect(DEFAULT_SELF_HEAL_BUDGET).toBe(1)
  })

  it('returns the default for arbitrary previously-unseen signatures', () => {
    expect(getRetryBudget('totally-made-up-signature')).toBe(1)
    expect(getRetryBudget('')).toBe(1)
  })
})

describe('retryBudgetBySignature', () => {
  it('exposes the daemon-killed override', () => {
    expect(retryBudgetBySignature['daemon-killed']).toBe(3)
  })

  it('is exposed as read-only so callers cannot mutate it', () => {
    expect(() => {
      // @ts-expect-error — assignment to a Readonly<Record<...>> entry must fail typecheck
      retryBudgetBySignature['daemon-killed'] = 99
    }).toThrow()
    expect(() => {
      // @ts-expect-error — adding new keys must also fail typecheck
      retryBudgetBySignature['something-new'] = 5
    }).toThrow()
    expect(retryBudgetBySignature['daemon-killed']).toBe(3)
    expect(
      (retryBudgetBySignature as Record<string, number>)['something-new'],
    ).toBeUndefined()
  })
})
