/**
 * Unit tests for `pauseResumeHint` — the reason-aware dispatch-pause hint.
 *
 * Key invariant: the `baseline` hint MUST NOT recommend
 * 'mars operator set dispatch on', and MUST name the failing gate.
 * All other reasons MUST include 'set dispatch on'.
 */

import { describe, it, expect } from 'vitest'
import { pauseResumeHint } from '../pause-state'
import type { DispatchPauseState } from '../pause-state'

function makePaused(
  reason: DispatchPauseState['reason'],
  detail: string | null = null,
): DispatchPauseState {
  return { paused: true, reason, since: '2026-01-01T00:00:00.000Z', detail }
}

describe('pauseResumeHint', () => {
  describe('baseline reason', () => {
    it('does NOT recommend "set dispatch on"', () => {
      const hint = pauseResumeHint(makePaused('baseline', 'gate "test" fails on integration branch'))
      expect(hint).not.toContain('set dispatch on')
    })

    it('names the failing gate from detail', () => {
      const hint = pauseResumeHint(makePaused('baseline', 'gate "typecheck" fails on integration branch'))
      expect(hint).toContain('typecheck')
    })

    it('explains dispatch resumes automatically', () => {
      const hint = pauseResumeHint(makePaused('baseline', 'gate "test" fails on integration branch'))
      expect(hint).toContain('resumes automatically')
    })

    it('warns that clearing the pause manually is ineffective', () => {
      const hint = pauseResumeHint(makePaused('baseline', 'gate "test" fails on integration branch'))
      expect(hint).toMatch(/ineffective|re-asserts/i)
    })

    it('falls back gracefully when detail is null', () => {
      const hint = pauseResumeHint(makePaused('baseline', null))
      expect(hint).not.toContain('set dispatch on')
      expect(hint).toContain('resumes automatically')
    })
  })

  describe('operator reason', () => {
    it('recommends "set dispatch on"', () => {
      const hint = pauseResumeHint(makePaused('operator'))
      expect(hint).toContain('set dispatch on')
    })

    it('does not mention baseline-specific guidance', () => {
      const hint = pauseResumeHint(makePaused('operator'))
      expect(hint).not.toContain('re-asserts')
    })
  })

  describe('storm reason', () => {
    it('recommends "set dispatch on"', () => {
      const hint = pauseResumeHint(makePaused('storm'))
      expect(hint).toContain('set dispatch on')
    })

    it('also mentions "reset-breaker" as the targeted verb', () => {
      const hint = pauseResumeHint(makePaused('storm'))
      expect(hint).toContain('reset-breaker')
    })
  })

  describe('quota reason', () => {
    it('recommends "set dispatch on"', () => {
      const hint = pauseResumeHint(makePaused('quota'))
      expect(hint).toContain('set dispatch on')
    })
  })
})
