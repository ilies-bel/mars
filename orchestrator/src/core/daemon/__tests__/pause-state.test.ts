/**
 * Unit tests for the daemon's single dispatch-pause state.
 *
 * The bug these lock down: `tripped` (durable, storm breaker) and `isPaused`
 * (in-memory, daemon) used to move independently, so `mars daemon status` could
 * report PAUSED with nothing on disk explaining it, and the legacy resume control
 * cleared one flag but not the other.
 */

import { describe, expect, it, vi } from 'vitest'
import { createPauseController, describePauseState } from '../pause-state'

describe('createPauseController', () => {
  it('starts unpaused with no reason', () => {
    const pause = createPauseController()
    expect(pause.isPaused()).toBe(false)
    expect(pause.get()).toEqual({
      paused: false,
      reason: null,
      since: null,
      detail: null,
    })
  })

  it('records WHY dispatch is paused', () => {
    const pause = createPauseController({
      now: () => new Date('2026-07-31T12:00:00.000Z'),
    })
    expect(pause.pause('storm', 'code/api-unreachable x3')).toBe(true)
    expect(pause.get()).toEqual({
      paused: true,
      reason: 'storm',
      since: '2026-07-31T12:00:00.000Z',
      detail: 'code/api-unreachable x3',
    })
  })

  it('first cause wins — a second pause neither overwrites the reason nor re-reports', () => {
    const pause = createPauseController()
    expect(pause.pause('storm', 'storm detail')).toBe(true)
    expect(pause.pause('operator')).toBe(false)
    expect(pause.pause('quota')).toBe(false)
    expect(pause.get().reason).toBe('storm')
    expect(pause.get().detail).toBe('storm detail')
  })

  it('resume returns the cleared state so the caller can release the right half', () => {
    const pause = createPauseController()
    pause.pause('storm', 'signature storm: verify:has-diff/no-commits-ahead x3')
    const cleared = pause.resume()
    expect(cleared.reason).toBe('storm')
    expect(pause.isPaused()).toBe(false)
    expect(pause.get().reason).toBeNull()
  })

  it('resume while running is a no-op that reports no cleared reason', () => {
    const pause = createPauseController()
    const cleared = pause.resume()
    expect(cleared.paused).toBe(false)
    expect(cleared.reason).toBeNull()
  })

  it('a quota pause then resume then a storm pause reads as storm, not stale quota', () => {
    const pause = createPauseController()
    pause.pause('quota')
    pause.resume()
    pause.pause('storm')
    expect(pause.get().reason).toBe('storm')
  })

  it('notifies onChange for both directions', () => {
    const onChange = vi.fn()
    const pause = createPauseController({ onChange })
    pause.pause('operator')
    pause.pause('storm') // no-op: already paused
    pause.resume()
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onChange.mock.calls[0]?.[0].reason).toBe('operator')
    expect(onChange.mock.calls[1]?.[0].paused).toBe(false)
  })

  it('snapshots are not mutated in place', () => {
    const pause = createPauseController()
    const running = pause.get()
    pause.pause('storm')
    expect(running.paused).toBe(false)
    expect(pause.get().paused).toBe(true)
  })
})

describe('describePauseState', () => {
  it('returns null while dispatch is running', () => {
    expect(describePauseState(createPauseController().get())).toBeNull()
  })

  it('names the reason so `mars daemon status` can say WHY', () => {
    const pause = createPauseController({
      now: () => new Date('2026-07-31T12:00:00.000Z'),
    })
    pause.pause('storm', 'signature storm: code/api-unreachable x3')
    expect(describePauseState(pause.get())).toBe(
      'reason: storm — signature storm: code/api-unreachable x3 (since 2026-07-31T12:00:00.000Z)',
    )
  })

  it('renders a detail-less pause', () => {
    const pause = createPauseController({
      now: () => new Date('2026-07-31T12:00:00.000Z'),
    })
    pause.pause('operator')
    expect(describePauseState(pause.get())).toBe(
      'reason: operator (since 2026-07-31T12:00:00.000Z)',
    )
  })
})
