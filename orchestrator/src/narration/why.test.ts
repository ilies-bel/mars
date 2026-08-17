import { describe, it, expect } from 'vitest'
import { explainParkReason, explainVerifyFailure, explainMergeBlock } from './why.js'

describe('explainParkReason', () => {
  it('explains a known code', () => {
    expect(explainParkReason('live-step')).toMatch(/human to look at something visual/)
  })

  it('falls back to a generic sentence for an unknown code', () => {
    expect(explainParkReason('some-new-code')).toBe(
      "Parked (reason: some new code) — awaiting operator input.",
    )
  })

  it('handles a missing reason', () => {
    expect(explainParkReason(null)).toBe('this task is parked awaiting operator input.')
    expect(explainParkReason(undefined)).toBe('this task is parked awaiting operator input.')
  })
})

describe('explainVerifyFailure', () => {
  it('names the gate and what it guards', () => {
    expect(explainVerifyFailure('typecheck')).toBe(
      "Verify failed at the 'typecheck' gate — it exists to confirm the code compiles under the project's type checker.",
    )
  })

  it('appends a detail when provided', () => {
    const text = explainVerifyFailure('test', 'src/foo.test.ts: 2 failing')
    expect(text).toContain("Verify failed at the 'test' gate")
    expect(text).toContain('src/foo.test.ts: 2 failing')
  })

  it('falls back for an unknown gate', () => {
    expect(explainVerifyFailure('custom-gate')).toBe(
      "Verify failed at the 'custom-gate' gate.",
    )
  })

  it('handles a missing gate name', () => {
    expect(explainVerifyFailure(null)).toBe('Verify failed at a verify gate.')
  })
})

describe('explainMergeBlock', () => {
  it('explains a known code', () => {
    expect(explainMergeBlock('verify-failed')).toMatch(/verify gate did not pass/)
  })

  it('falls back for an unknown code', () => {
    expect(explainMergeBlock('weird-reason')).toBe('Merge blocked (reason: weird reason).')
  })

  it('handles a missing reason', () => {
    expect(explainMergeBlock(null)).toBe(
      'Merge blocked — the orchestrator did not record a specific reason.',
    )
  })
})
