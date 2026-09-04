/**
 * Unit tests for the pure diff core of the alert notifier. The DOM/React parts
 * (the `useEffect`, the `Notification` construction) are exercised manually per
 * the plan's verification steps; here we prove the seed/class-filter/prune logic
 * that decides *which* alerts notify, free of any browser dependency.
 */

import { describe, it, expect } from 'vitest'
import { diffNotifiable } from './alertNotifier'
import type { ActionQueueItem } from '@/shared/schemas'

// Minimal item builder. The diff core reads `id`, `class`, and `humanSummary`;
// the rest of the discriminated-union shape is irrelevant, so we cast a partial.
const item = (
  id: string,
  kind: ActionQueueItem['kind'],
  cls: 'alert' | 'notice' | 'decision' = 'alert',
): ActionQueueItem =>
  ({
    id,
    kind,
    entityId: id,
    title: `title-${id}`,
    humanSummary: `summary-${id}`,
    class: cls,
  } as unknown as ActionQueueItem)

describe('diffNotifiable', () => {
  it('notifies nothing on the seed pass but records every id', () => {
    const items = [item('a', 'arc-failed', 'alert'), item('b', 'stale-worktree', 'alert')]
    const { toNotify, nextSeen } = diffNotifiable(new Set(), items, true)
    expect(toNotify).toEqual([])
    expect(nextSeen).toEqual(new Set(['a', 'b']))
  })

  it('fires for a newly-appearing alert-class item', () => {
    const prev = new Set(['a'])
    const items = [item('a', 'arc-failed', 'alert'), item('b', 'stale-worktree', 'alert')]
    const { toNotify } = diffNotifiable(prev, items, false)
    expect(toNotify.map((i) => i.id)).toEqual(['b'])
  })

  it('does not fire for notice-class items', () => {
    const items = [
      item('p', 'spend-control-notice', 'notice'),
      item('q', 'scheduling-decision', 'notice'),
    ]
    const { toNotify } = diffNotifiable(new Set(), items, false)
    expect(toNotify).toEqual([])
  })

  it('does not fire for decision-class items', () => {
    const items = [
      item('p', 'draft-proposal', 'decision'),
      item('v', 'awaiting-validation', 'decision'),
    ]
    const { toNotify } = diffNotifiable(new Set(), items, false)
    expect(toNotify).toEqual([])
  })

  it('fires for any alert-class item regardless of kind', () => {
    const { toNotify } = diffNotifiable(new Set(), [item('x', 'arc-failed', 'alert')], false)
    expect(toNotify.map((i) => i.id)).toEqual(['x'])
  })

  it('fires for a failed task carrying class alert', () => {
    const { toNotify } = diffNotifiable(new Set(), [item('f', 'failed', 'alert')], false)
    expect(toNotify.map((i) => i.id)).toEqual(['f'])
  })

  it('does not fire for a failed task carrying class notice (recovery in-flight)', () => {
    const { toNotify } = diffNotifiable(new Set(), [item('f', 'failed', 'notice')], false)
    expect(toNotify).toEqual([])
  })

  it('does not re-fire an already-seen item', () => {
    const items = [item('a', 'arc-failed', 'alert')]
    const { toNotify } = diffNotifiable(new Set(['a']), items, false)
    expect(toNotify).toEqual([])
  })

  it('prunes resolved ids so the same id can notify again if re-raised', () => {
    // 'a' resolved (gone from the list) -> dropped from nextSeen.
    const { nextSeen } = diffNotifiable(
      new Set(['a']),
      [item('b', 'arc-failed', 'alert')],
      false,
    )
    expect(nextSeen.has('a')).toBe(false)
    // It re-appears later: with 'a' no longer in the seen-set, it notifies.
    const second = diffNotifiable(nextSeen, [item('a', 'arc-failed', 'alert')], false)
    expect(second.toNotify.map((i) => i.id)).toEqual(['a'])
  })
})
