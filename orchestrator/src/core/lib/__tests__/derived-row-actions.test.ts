import { describe, expect, it } from 'vitest'
import { derivedRowActions } from '../derived-row-actions'

describe('derivedRowActions — stale-worktree', () => {
  it('returns investigate and prune-worktree actions', () => {
    const actions = derivedRowActions('stale-worktree')
    const ops = actions.map((a) => a.op)
    expect(ops).toContain('investigate')
    expect(ops).toContain('prune-worktree')
  })

  it('prune-worktree action requires confirmation', () => {
    const actions = derivedRowActions('stale-worktree')
    const prune = actions.find((a) => a.op === 'prune-worktree')
    expect(prune?.needsConfirm).toBe(true)
  })
})

describe('derivedRowActions — draft-proposal', () => {
  it('returns copy (move-forward) and dismiss actions', () => {
    const actions = derivedRowActions('draft-proposal', 'prop-abc123')
    const ops = actions.map((a) => a.op)
    expect(ops).toContain('copy')
    expect(ops).toContain('dismiss')
  })

  it('copy action hint includes the entity id', () => {
    const actions = derivedRowActions('draft-proposal', 'abc123-migrate-timestamp')
    const copy = actions.find((a) => a.op === 'copy')
    expect(copy).toBeDefined()
    expect(copy!.hint).toContain('abc123-migrate-timestamp')
    expect(copy!.hint).toMatch(/^\/mars:grill /)
  })

  it('dismiss action requires confirmation', () => {
    const actions = derivedRowActions('draft-proposal', 'prop-1')
    const dismiss = actions.find((a) => a.op === 'dismiss')
    expect(dismiss?.needsConfirm).toBe(true)
  })

  it('copy action label is "Move forward"', () => {
    const actions = derivedRowActions('draft-proposal', 'prop-1')
    const copy = actions.find((a) => a.op === 'copy')
    expect(copy?.label).toBe('Move forward')
  })

  it('dismiss action label is "Dismiss"', () => {
    const actions = derivedRowActions('draft-proposal', 'prop-1')
    const dismiss = actions.find((a) => a.op === 'dismiss')
    expect(dismiss?.label).toBe('Dismiss')
  })

  it('copy action id is "move-forward"', () => {
    const actions = derivedRowActions('draft-proposal', 'prop-1')
    const copy = actions.find((a) => a.op === 'copy')
    expect(copy?.id).toBe('move-forward')
  })

  it('works without an entityId (graceful fallback)', () => {
    const actions = derivedRowActions('draft-proposal')
    const copy = actions.find((a) => a.op === 'copy')
    expect(copy).toBeDefined()
    expect(copy!.hint).toBe('/mars:grill')
  })

  it('returns exactly two actions', () => {
    const actions = derivedRowActions('draft-proposal', 'some-id')
    expect(actions).toHaveLength(2)
  })
})

describe('derivedRowActions — unknown kind', () => {
  it('returns an empty array', () => {
    expect(derivedRowActions('failed-task')).toEqual([])
    expect(derivedRowActions('unknown-kind')).toEqual([])
  })
})
