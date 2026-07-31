import { describe, expect, it } from 'vitest'
import { verificationOutcome } from '../../../scripts/verify-provider-output'

describe('verify-provider output', () => {
  it('reports failure when a task is done but its commit is absent from main', () => {
    expect(verificationOutcome('done', 'none')).toBe('FAIL')
  })

  it('reports success only after a completed task commit reaches main', () => {
    expect(verificationOutcome('done', '4cf252bdba39e84d98e905e6ab8c4047e33ee153')).toBe('PASS')
  })
})
