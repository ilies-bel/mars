/**
 * Tests for the recency slider's pure model functions.
 *
 * The component itself (RecencySlider.tsx) is a controlled presentational
 * widget — the parent owns value + onChange. The observable behaviour we pin
 * here is the `recencyStopToMs` mapping that drives the ?failedWindow API
 * parameter: if it returns wrong values the server returns wrong data.
 *
 * Imports from the `.ts` model file so the server tsconfig can compile these
 * tests without requiring JSX support.
 */
import { describe, expect, it } from 'bun:test'
import {
  RECENCY_STOP_DEFAULT,
  RECENCY_STOPS,
  recencyStopToMs,
} from '../shared/recencyStop'

describe('recencyStopToMs', () => {
  it('maps 1h to 3 600 000 ms', () => {
    expect(recencyStopToMs('1h')).toBe(3_600_000)
  })

  it('maps 6h to 21 600 000 ms', () => {
    expect(recencyStopToMs('6h')).toBe(21_600_000)
  })

  it('maps 24h to 86 400 000 ms', () => {
    expect(recencyStopToMs('24h')).toBe(86_400_000)
  })

  it('maps 7d to 604 800 000 ms', () => {
    expect(recencyStopToMs('7d')).toBe(604_800_000)
  })

  it('maps 30d to 2 592 000 000 ms', () => {
    expect(recencyStopToMs('30d')).toBe(2_592_000_000)
  })

  it('maps all to null (no recency cutoff)', () => {
    expect(recencyStopToMs('all')).toBeNull()
  })
})

describe('RECENCY_STOPS', () => {
  it('has exactly six stops', () => {
    expect(RECENCY_STOPS.length).toBe(6)
  })

  it('contains all six expected labels in order', () => {
    expect([...RECENCY_STOPS]).toEqual(['1h', '6h', '24h', '7d', '30d', 'all'])
  })
})

describe('RECENCY_STOP_DEFAULT', () => {
  it('defaults to 24h', () => {
    expect(RECENCY_STOP_DEFAULT).toBe('24h')
  })

  it('maps to the standard 24h window (86 400 000 ms)', () => {
    expect(recencyStopToMs(RECENCY_STOP_DEFAULT)).toBe(86_400_000)
  })
})
