/**
 * Unit tests for the pure diff core of the alert notifier. The DOM/React parts
 * (the `useEffect`, the `Notification` construction) are exercised manually per
 * the plan's verification steps; here we prove the seed/kind-filter/prune logic
 * that decides *which* alerts notify, free of any browser dependency.
 */

import { describe, it, expect } from 'vitest'
import { diffNotifiable, NOTIFY_KINDS } from './alertNotifier'
import type { ActionQueueItem } from '@/shared/schemas'

// Minimal item builder. The diff core only reads `id` and `kind`; the rest of
// the discriminated-union shape is irrelevant to it, so we cast a partial.
const item = (id: string, kind: ActionQueueItem['kind']): ActionQueueItem =>
  ({ id, kind, entityId: id, title: `title-${id}` } as unknown as ActionQueueItem)

describe('diffNotifiable', () => {
  it('notifies nothing on the seed pass but records every id', () => {
    const items = [item('a', 'failed'), item('b', 'stale-worktree')]
    const { toNotify, nextSeen } = diffNotifiable(new Set(), items, true)
    expect(toNotify).toEqual([])
    expect(nextSeen).toEqual(new Set(['a', 'b']))
  })

  it('fires for a newly-appearing notifiable item', () => {
    const prev = new Set(['a'])
    const items = [item('a', 'failed'), item('b', 'stale-worktree')]
    const { toNotify } = diffNotifiable(prev, items, false)
    expect(toNotify.map((i) => i.id)).toEqual(['b'])
  })

  it('does not fire for non-notifiable kinds', () => {
    const items = [item('p', 'draft-proposal'), item('v', 'awaiting-validation')]
    const { toNotify } = diffNotifiable(new Set(), items, false)
    expect(toNotify).toEqual([])
  })

  it('fires for arc-failed (a failed arc)', () => {
    const { toNotify } = diffNotifiable(new Set(), [item('x', 'arc-failed')], false)
    expect(toNotify.map((i) => i.id)).toEqual(['x'])
  })

  it('does not re-fire an already-seen item', () => {
    const items = [item('a', 'failed')]
    const { toNotify } = diffNotifiable(new Set(['a']), items, false)
    expect(toNotify).toEqual([])
  })

  it('prunes resolved ids so the same id can notify again if re-raised', () => {
    // 'a' resolved (gone from the list) -> dropped from nextSeen.
    const { nextSeen } = diffNotifiable(new Set(['a']), [item('b', 'failed')], false)
    expect(nextSeen.has('a')).toBe(false)
    // It re-appears later: with 'a' no longer in the seen-set, it notifies.
    const second = diffNotifiable(nextSeen, [item('a', 'failed')], false)
    expect(second.toNotify.map((i) => i.id)).toEqual(['a'])
  })

  it('exposes the expected notifiable kind set', () => {
    expect([...NOTIFY_KINDS].sort()).toEqual(['arc-failed', 'stale-worktree'])
  })
})
