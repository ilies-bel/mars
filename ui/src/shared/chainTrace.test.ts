import { describe, expect, it } from 'bun:test'

import {
  blockerKey,
  chainForProposal,
  chainForTask,
  deepestPendingLeaf,
  provKey,
  type ChainGraph,
} from './chainTrace.ts'

type Cluster = 'Queued' | 'In progress' | 'Blocked' | 'Failed'

interface TaskOpts {
  cluster?: Cluster
  blockedBy?: string[]
  parentProposalId?: string | null
}

const task = (
  id: string,
  { cluster = 'Queued', blockedBy = [], parentProposalId = null }: TaskOpts = {},
): ChainGraph['tasks'][number] => ({ id, cluster, blockedBy, parentProposalId })

const graph = (...tasks: ChainGraph['tasks'][number][]): ChainGraph => ({ tasks })

describe('chainForTask', () => {
  it('lights a full linear chain plus its proposal', () => {
    // a -> b -> c (all in proposal P)
    const g = graph(
      task('a', { parentProposalId: 'P' }),
      task('b', { parentProposalId: 'P', blockedBy: ['a'] }),
      task('c', { parentProposalId: 'P', blockedBy: ['b'] }),
    )
    const r = chainForTask(g, 'b')
    expect(r.nodes).toEqual(new Set(['a', 'b', 'c']))
    expect(r.proposals).toEqual(new Set(['P']))
    // blocker edges both directions from the hover
    expect(r.edges.has(blockerKey('a', 'b'))).toBe(true)
    expect(r.edges.has(blockerKey('b', 'c'))).toBe(true)
    // provenance hop for every lit task
    expect(r.edges.has(provKey('P', 'a'))).toBe(true)
    expect(r.edges.has(provKey('P', 'b'))).toBe(true)
    expect(r.edges.has(provKey('P', 'c'))).toBe(true)
  })

  it('lights ALL paths of a diamond without duplicate-handling errors', () => {
    //   root
    //   /  \
    //  l    r
    //   \  /
    //   sink
    const g = graph(
      task('root', { parentProposalId: 'P' }),
      task('l', { parentProposalId: 'P', blockedBy: ['root'] }),
      task('r', { parentProposalId: 'P', blockedBy: ['root'] }),
      task('sink', { parentProposalId: 'P', blockedBy: ['l', 'r'] }),
    )
    // hover the sink: every upstream parent on both arms must light
    const fromSink = chainForTask(g, 'sink')
    expect(fromSink.nodes).toEqual(new Set(['root', 'l', 'r', 'sink']))
    // hover the root: both downstream arms + the join must light
    const fromRoot = chainForTask(g, 'root')
    expect(fromRoot.nodes).toEqual(new Set(['root', 'l', 'r', 'sink']))
    // each blocker edge appears exactly once (Set dedupes)
    expect(fromRoot.edges.has(blockerKey('root', 'l'))).toBe(true)
    expect(fromRoot.edges.has(blockerKey('root', 'r'))).toBe(true)
    expect(fromRoot.edges.has(blockerKey('l', 'sink'))).toBe(true)
    expect(fromRoot.edges.has(blockerKey('r', 'sink'))).toBe(true)
  })

  it('follows a cross-proposal blocker edge and lights both proposals', () => {
    // P1: up   ->  P2: waiter  (waiter blockedBy a task in the OTHER proposal)
    const g = graph(
      task('up', { parentProposalId: 'P1' }),
      task('waiter', { parentProposalId: 'P2', cluster: 'Blocked', blockedBy: ['up'] }),
    )
    // hover upstream: the dependent in the OTHER proposal lights
    const r = chainForTask(g, 'up')
    expect(r.nodes.has('waiter')).toBe(true)
    expect(r.proposals.has('P1')).toBe(true)
    expect(r.proposals.has('P2')).toBe(true)
    expect(r.edges.has(blockerKey('up', 'waiter'))).toBe(true)
    expect(r.edges.has(provKey('P2', 'waiter'))).toBe(true)
  })

  it('keeps a non-pending mid-chain task lit (cluster decides only the tip)', () => {
    // a(done-ish) -> mid(In progress) -> tail; hover the tail, everything lights
    const g = graph(
      task('a', { parentProposalId: 'P', cluster: 'In progress' }),
      task('mid', { parentProposalId: 'P', cluster: 'In progress', blockedBy: ['a'] }),
      task('tail', { parentProposalId: 'P', cluster: 'Queued', blockedBy: ['mid'] }),
    )
    const r = chainForTask(g, 'tail')
    expect(r.nodes.has('mid')).toBe(true)
    expect(r.nodes.has('a')).toBe(true)
    expect(r.nodes).toEqual(new Set(['a', 'mid', 'tail']))
  })

  it('attaches the originating proposal of every lit task in a cross-proposal chain', () => {
    const g = graph(
      task('a', { parentProposalId: 'P1' }),
      task('b', { parentProposalId: 'P2', blockedBy: ['a'] }),
      task('c', { parentProposalId: 'P3', blockedBy: ['b'] }),
    )
    const r = chainForTask(g, 'b')
    expect(r.proposals).toEqual(new Set(['P1', 'P2', 'P3']))
    expect(r.edges.has(provKey('P1', 'a'))).toBe(true)
    expect(r.edges.has(provKey('P2', 'b'))).toBe(true)
    expect(r.edges.has(provKey('P3', 'c'))).toBe(true)
  })

  it('does not attach a proposal hop for tasks with no parentProposalId', () => {
    const g = graph(task('lone', { parentProposalId: null }))
    const r = chainForTask(g, 'lone')
    expect(r.nodes).toEqual(new Set(['lone']))
    expect(r.proposals.size).toBe(0)
    expect(r.edges.size).toBe(0)
  })
})

describe('chainForProposal', () => {
  it('includes every sliced task and its full downstream reach', () => {
    const g = graph(
      task('a', { parentProposalId: 'P' }),
      task('b', { parentProposalId: 'P', blockedBy: ['a'] }),
      task('c', { parentProposalId: 'P', blockedBy: ['b'] }),
    )
    const r = chainForProposal(g, 'P')
    expect(r.nodes).toEqual(new Set(['a', 'b', 'c']))
    expect(r.proposals.has('P')).toBe(true)
    // provenance hop for the directly-sliced tasks
    expect(r.edges.has(provKey('P', 'a'))).toBe(true)
    expect(r.edges.has(provKey('P', 'b'))).toBe(true)
    expect(r.edges.has(provKey('P', 'c'))).toBe(true)
    expect(r.edges.has(blockerKey('a', 'b'))).toBe(true)
  })

  it('marks every reached proposal when the forest crosses into another proposal', () => {
    // P1 slices `up`; `dep` lives in P2 but is blockedBy `up`.
    const g = graph(
      task('up', { parentProposalId: 'P1' }),
      task('dep', { parentProposalId: 'P2', cluster: 'Blocked', blockedBy: ['up'] }),
    )
    const r = chainForProposal(g, 'P1')
    // reaches its cross-combo dependent task
    expect(r.nodes.has('dep')).toBe(true)
    // both proposals are marked active (the headline fix)
    expect(r.proposals.has('P1')).toBe(true)
    expect(r.proposals.has('P2')).toBe(true)
    // only the directly-sliced task gets a provenance hop from P1
    expect(r.edges.has(provKey('P1', 'up'))).toBe(true)
    expect(r.edges.has(provKey('P1', 'dep'))).toBe(false)
    expect(r.edges.has(blockerKey('up', 'dep'))).toBe(true)
  })

  it('still marks the hovered proposal even when it sliced nothing', () => {
    const g = graph(task('a', { parentProposalId: 'P1' }))
    const r = chainForProposal(g, 'EMPTY')
    expect(r.proposals).toEqual(new Set(['EMPTY']))
    expect(r.nodes.size).toBe(0)
  })
})

describe('deepestPendingLeaf', () => {
  it('picks the deepest Queued/Blocked leaf', () => {
    // a -> b -> c (c is the deepest, Queued, no dependents)
    const g = graph(
      task('a', { cluster: 'In progress' }),
      task('b', { cluster: 'Blocked', blockedBy: ['a'] }),
      task('c', { cluster: 'Queued', blockedBy: ['b'] }),
    )
    expect(deepestPendingLeaf(g, 'a')).toBe('c')
  })

  it('prefers the deeper leaf across branches', () => {
    //        root
    //       /    \
    //   shallow   m1 -> m2 (deepest pending leaf)
    const g = graph(
      task('root', { cluster: 'In progress' }),
      task('shallow', { cluster: 'Queued', blockedBy: ['root'] }),
      task('m1', { cluster: 'Blocked', blockedBy: ['root'] }),
      task('m2', { cluster: 'Queued', blockedBy: ['m1'] }),
    )
    expect(deepestPendingLeaf(g, 'root')).toBe('m2')
  })

  it('returns null when no downstream leaf is pending', () => {
    // every downstream node is non-pending OR still has dependents
    const g = graph(
      task('a', { cluster: 'In progress' }),
      task('b', { cluster: 'Failed', blockedBy: ['a'] }),
      task('c', { cluster: 'In progress', blockedBy: ['b'] }),
    )
    expect(deepestPendingLeaf(g, 'a')).toBeNull()
  })

  it('does not count a pending node that still has dependents', () => {
    // mid is Queued but has a dependent, so it is not a leaf; tail is the leaf
    // but is non-pending -> result is null
    const g = graph(
      task('mid', { cluster: 'Queued' }),
      task('tail', { cluster: 'Failed', blockedBy: ['mid'] }),
    )
    expect(deepestPendingLeaf(g, 'mid')).toBeNull()
  })
})

describe('edge key formats', () => {
  it('blockerKey and provKey use the exact b:/p: prefix format', () => {
    expect(blockerKey('x', 'y')).toBe('b:x->y')
    expect(provKey('P', 'x')).toBe('p:P->x')
  })
})
