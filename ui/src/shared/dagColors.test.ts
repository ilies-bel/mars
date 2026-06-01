/**
 * Unit tests for the shared DAG cluster-colour helpers.
 *
 * Each cluster ("In progress", "Blocked", "Failed", "Queued") and the
 * proposal pseudo-kind must return distinct style objects whose values
 * are CSS custom-property references (so the token lives in @theme, not
 * scattered as hex literals across component files).
 */
import { describe, expect, it } from 'bun:test'
import { dagClusterStyle, DAG_EDGE_BLOCKER, DAG_EDGE_PROVENANCE } from './dagColors'

describe('dagClusterStyle – token references', () => {
  it('returns CSS var() references for all three style fields', () => {
    const s = dagClusterStyle('proposal', undefined)
    expect(s.fill).toMatch(/^var\(--color-dag-/)
    expect(s.stroke).toMatch(/^var\(--color-dag-/)
    expect(s.text).toMatch(/^var\(--color-dag-/)
  })

  it('returns proposal style for kind="proposal"', () => {
    const s = dagClusterStyle('proposal', undefined)
    expect(s.fill).toContain('proposal')
    expect(s.stroke).toContain('proposal')
    expect(s.text).toContain('proposal')
  })

  it('returns the full proposal palette for kind="proposal"', () => {
    const s = dagClusterStyle('proposal', undefined)
    expect(s.fill).toContain('proposal')
    expect(s.stroke).toContain('proposal')
    expect(s.text).toContain('proposal')
  })

  it('returns distinct styles for proposal vs task kinds', () => {
    const prop = dagClusterStyle('proposal', undefined)
    const taskQueued = dagClusterStyle('task', 'Queued')
    expect(prop.fill).not.toBe(taskQueued.fill)
  })

  it('returns in-progress style for "In progress" cluster', () => {
    const s = dagClusterStyle('task', 'In progress')
    expect(s.fill).toContain('in-progress')
    expect(s.stroke).toContain('in-progress')
    expect(s.text).toContain('in-progress')
  })

  it('returns blocked style for "Blocked" cluster', () => {
    const s = dagClusterStyle('task', 'Blocked')
    expect(s.fill).toContain('blocked')
  })

  it('returns failed style for "Failed" cluster', () => {
    const s = dagClusterStyle('task', 'Failed')
    expect(s.fill).toContain('failed')
  })

  it('returns queued style for "Queued" cluster', () => {
    const s = dagClusterStyle('task', 'Queued')
    expect(s.fill).toContain('queued')
  })

  it('falls back to queued style for unknown / undefined cluster', () => {
    const unknown = dagClusterStyle('task', undefined)
    const queued = dagClusterStyle('task', 'Queued')
    expect(unknown.fill).toBe(queued.fill)
    expect(unknown.stroke).toBe(queued.stroke)
    expect(unknown.text).toBe(queued.text)
  })

  it('returns distinct styles for each cluster', () => {
    const fills = [
      dagClusterStyle('proposal', undefined).fill,
      dagClusterStyle('task', 'In progress').fill,
      dagClusterStyle('task', 'Blocked').fill,
      dagClusterStyle('task', 'Failed').fill,
      dagClusterStyle('task', 'Queued').fill,
    ]
    const unique = new Set(fills)
    expect(unique.size).toBe(5)
  })
})

describe('DAG edge colour constants', () => {
  it('DAG_EDGE_PROVENANCE is a CSS var() reference', () => {
    expect(DAG_EDGE_PROVENANCE).toMatch(/^var\(--color-dag-/)
  })

  it('DAG_EDGE_BLOCKER is a CSS var() reference', () => {
    expect(DAG_EDGE_BLOCKER).toMatch(/^var\(--color-dag-/)
  })

  it('provenance and blocker colours are distinct', () => {
    expect(DAG_EDGE_PROVENANCE).not.toBe(DAG_EDGE_BLOCKER)
  })
})
