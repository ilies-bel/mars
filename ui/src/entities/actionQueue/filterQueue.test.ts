/**
 * Tests for filterQueue — the triage search box and kind filter.
 *
 * The bug these exist for: both controls were applied to the flat item list
 * only, while `serverGroups` — the daemon's pre-grouped cause rows — went
 * straight through untouched. Measured on a live queue, typing `zzzzqqq` left
 * three cluster rows sitting above an otherwise empty page, and the header
 * still read 38. A search that returns confident-looking rows unrelated to the
 * query is worse than one that returns nothing: the reader concludes those
 * rows ARE the matches.
 */
import { describe, expect, it } from 'vitest'
import { filterQueue, itemMatchesQuery } from './filterQueue'
import type { ActionQueueItem, ActionQueueGroupRow } from '@/shared/schemas'
import { buildRenderedRows, countRenderedItems } from './clusterRows'

const item = (over: Partial<ActionQueueItem> & { id: string }): ActionQueueItem =>
  ({
    kind: 'failed',
    entityId: `entity-${over.id}`,
    priority: 'normal',
    title: `Title ${over.id}`,
    body: '',
    at: '2026-01-01T00:00:00Z',
    dag: null,
    errorKind: 'failed',
    actions: [],
    decisions: [],
    verbs: [],
    ...over,
  }) as unknown as ActionQueueItem

const group = (over: Partial<ActionQueueGroupRow> = {}): ActionQueueGroupRow =>
  ({
    kind: 'slice-failed',
    signature: '__cause__:slice workflow failed',
    causeLabel: 'slice workflow failed — provider worker exited',
    count: 2,
    priority: 'high',
    members: [item({ id: 'm1', kind: 'slice-failed' }), item({ id: 'm2', kind: 'slice-failed' })],
    ...over,
  }) as unknown as ActionQueueGroupRow

describe('filterQueue — the controls reach the grouped rows too', () => {
  it('passes everything through when neither control is set', () => {
    const r = filterQueue([item({ id: 'a' })], [group()], { kind: '', query: '' })
    expect(r.active).toBe(false)
    expect(r.items).toHaveLength(1)
    expect(r.groups).toHaveLength(1)
  })

  it('narrows a group to its matching members, and the page can count them', () => {
    // The header renders "Showing {matchedTasks} of {needsYouCount}" and
    // needsYouCount is a task count, so both sides must be tasks. Counting
    // rows here made a two-member group contribute 1 instead of 2, and the
    // sentence compared rows to tasks across the word "of".
    const r = filterQueue(
      [item({ id: 'a' }), item({ id: 'b' })],
      [group()], // 2 members, drawn as ONE row
      { kind: '', query: '' },
    )
    expect(r.groups).toHaveLength(1)
    expect(countRenderedItems(buildRenderedRows(r.items, r.groups))).toBe(4)
  })

  it('counts a narrowed group by its surviving members', () => {
    const g = group({
      count: 2,
      members: [
        item({ id: 'm1', kind: 'slice-failed', title: 'keeper zebra' }),
        item({ id: 'm2', kind: 'slice-failed', title: 'other' }),
      ],
    })
    const r = filterQueue([], [g], { kind: '', query: 'zebra' })
    expect(r.groups).toHaveLength(1)
    expect(countRenderedItems(buildRenderedRows(r.items, r.groups))).toBe(1)
  })

  it('drops a group whose cause and members match nothing', () => {
    const r = filterQueue([item({ id: 'a' })], [group()], { kind: '', query: 'zzzzqqq' })
    expect(r.items).toEqual([])
    expect(r.groups).toEqual([])
    expect(countRenderedItems(buildRenderedRows(r.items, r.groups))).toBe(0)
  })

  it('keeps a group whose cause sentence matches', () => {
    // The cause sentence is the text the row actually shows, so it is what the
    // reader is searching against.
    const r = filterQueue([], [group()], { kind: '', query: 'provider worker' })
    expect(r.groups).toHaveLength(1)
    expect(r.groups![0].count).toBe(2)
  })

  it('narrows a group to its matching members, and its count with it', () => {
    // A group that kept saying "17 tasks" while showing two matches would be a
    // second way of lying about what was found.
    const g = group({
      causeLabel: 'nothing here matches',
      signature: '__cause__:nothing here matches',
      members: [
        item({ id: 'm1', kind: 'slice-failed', title: 'Queue-position ordering' }),
        item({ id: 'm2', kind: 'slice-failed', title: 'Merge trains' }),
        item({ id: 'm3', kind: 'slice-failed', title: 'Merge queue depth' }),
      ],
      count: 3,
    })
    const r = filterQueue([], [g], { kind: '', query: 'merge' })
    expect(r.groups).toHaveLength(1)
    expect(r.groups![0].count).toBe(2)
    expect(r.groups![0].members.map((m) => m.id)).toEqual(['m2', 'm3'])
  })

  it('applies the kind filter to groups', () => {
    // Setting the filter to a decision kind used to leave every failure
    // cluster in place.
    const r = filterQueue([item({ id: 'a', kind: 'draft-proposal' })], [group()], {
      kind: 'draft-proposal',
      query: '',
    })
    expect(r.items).toHaveLength(1)
    expect(r.groups).toEqual([])
  })

  it('does not mutate the group it narrows', () => {
    const g = group()
    filterQueue([], [g], { kind: '', query: 'm1' })
    expect(g.count).toBe(2)
    expect(g.members).toHaveLength(2)
  })
})

describe('itemMatchesQuery — only fields a reader can see', () => {
  it('matches the title, the summary, the goal and the entity id', () => {
    expect(itemMatchesQuery(item({ id: 'a', title: 'Merge trains' }), 'merge')).toBe(true)
    expect(itemMatchesQuery(item({ id: 'a', humanSummary: 'Could not merge' }), 'merge')).toBe(true)
    expect(itemMatchesQuery(item({ id: 'a', operatorGoal: 'Fix the merge' }), 'merge')).toBe(true)
    // An id is the one machine string an operator pastes in verbatim.
    expect(itemMatchesQuery(item({ id: 'a', entityId: 'mars-3176234e' }), '3176234e')).toBe(true)
  })

  it('does not match on the raw body, which the row does not show', () => {
    expect(
      itemMatchesQuery(item({ id: 'a', title: 'x', body: 'ConnectionRefused' }), 'connectionrefused'),
    ).toBe(false)
  })
})
