import { describe, expect, it } from 'bun:test'

import { blockerKey, type ChainResult } from '@/shared/chainTrace'
import type { ProgressProposalNode, ProgressTask } from '@/shared/schemas'
import {
  UNATTACHED_COMBO_ID,
  buildG6Data,
  CLUSTER_STYLE,
  clusterSignature,
  computeStateMap,
  dataSignature,
  dominant,
  type ElementSnapshot,
  proposalIdFromComboId,
  rollupByProposal,
  type Rollup,
  structuralSignature,
} from './topologyGraphModel'

const task = (
  overrides: Partial<ProgressTask> & { id: string; cluster: ProgressTask['cluster'] },
): ProgressTask => ({
  id: overrides.id,
  prompt: overrides.prompt ?? `Task ${overrides.id}`,
  status: overrides.status ?? 'running',
  plan: null,
  branch: null,
  worktreePath: null,
  error: null,
  dropReason: null,
  retryCount: 0,
  blockerTaskId: null,
  blockedBy: overrides.blockedBy ?? [],
  spec: null,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  cluster: overrides.cluster,
  parentProposalId: overrides.parentProposalId ?? null,
  ...overrides,
})

const proposal = (id: string, title = `Goal ${id}`): ProgressProposalNode => ({
  id,
  title,
  source: 'human',
  status: 'draft',
})

const rollup = (counts: Partial<Rollup['counts']>): Rollup => {
  const full = { Queued: 0, 'In progress': 0, Blocked: 0, Failed: 0, ...counts }
  return { total: full.Queued + full['In progress'] + full.Blocked + full.Failed, counts: full }
}

describe('rollupByProposal', () => {
  it('tallies each proposal’s tasks by cluster', () => {
    const tasks = [
      task({ id: 't1', cluster: 'Queued', parentProposalId: 'p1' }),
      task({ id: 't2', cluster: 'Queued', parentProposalId: 'p1' }),
      task({ id: 't3', cluster: 'Failed', parentProposalId: 'p1' }),
      task({ id: 't4', cluster: 'In progress', parentProposalId: 'p2' }),
    ]
    const r = rollupByProposal(tasks, [proposal('p1'), proposal('p2')])
    expect(r.get('p1')).toEqual({ total: 3, counts: { Queued: 2, 'In progress': 0, Blocked: 0, Failed: 1 } })
    expect(r.get('p2')).toEqual({ total: 1, counts: { Queued: 0, 'In progress': 1, Blocked: 0, Failed: 0 } })
  })

  it('ignores tasks whose parent proposal is not in scope', () => {
    const tasks = [
      task({ id: 't1', cluster: 'Queued', parentProposalId: 'p-missing' }),
      task({ id: 't2', cluster: 'Queued', parentProposalId: null }),
    ]
    const r = rollupByProposal(tasks, [proposal('p1')])
    expect(r.get('p1')).toEqual({ total: 0, counts: { Queued: 0, 'In progress': 0, Blocked: 0, Failed: 0 } })
  })

  it('records an entry for every proposal even with zero tasks', () => {
    const r = rollupByProposal([], [proposal('p1'), proposal('p2')])
    expect(r.size).toBe(2)
    expect(r.get('p1')?.total).toBe(0)
  })
})

describe('dominant', () => {
  it('picks the plurality cluster, not "any failure"', () => {
    // 1 failed out of 14 must NOT paint the card Failed.
    expect(dominant(rollup({ 'In progress': 10, Queued: 3, Failed: 1 }))).toBe('In progress')
  })

  it('breaks ties by severity Failed > In progress > Blocked > Queued', () => {
    expect(dominant(rollup({ Failed: 2, 'In progress': 2 }))).toBe('Failed')
    expect(dominant(rollup({ 'In progress': 3, Blocked: 3 }))).toBe('In progress')
    expect(dominant(rollup({ Blocked: 1, Queued: 1 }))).toBe('Blocked')
  })

  it('falls back to Queued for an empty rollup', () => {
    expect(dominant(rollup({}))).toBe('Queued')
  })

  it('returns the sole non-zero cluster', () => {
    expect(dominant(rollup({ Blocked: 5 }))).toBe('Blocked')
    expect(dominant(rollup({ Failed: 1 }))).toBe('Failed')
  })
})

describe('CLUSTER_STYLE', () => {
  it('has an entry for every real cluster and no Done', () => {
    expect(Object.keys(CLUSTER_STYLE).sort()).toEqual(['Blocked', 'Failed', 'In progress', 'Queued'])
    expect((CLUSTER_STYLE as Record<string, unknown>).Done).toBeUndefined()
  })

  it('keeps Blocked (warm ochre) and Queued (cool grey) visually distinct', () => {
    expect(CLUSTER_STYLE.Blocked.fill).toBe('#3f2a14')
    expect(CLUSTER_STYLE.Blocked.stroke).toBe('#d9a441')
    expect(CLUSTER_STYLE.Queued.fill).toBe('#2a2a30')
    expect(CLUSTER_STYLE.Queued.stroke).toBe('#9ca3af')
    expect(CLUSTER_STYLE.Blocked.fill).not.toBe(CLUSTER_STYLE.Queued.fill)
  })
})

describe('proposalIdFromComboId', () => {
  it('strips the combo: prefix', () => {
    expect(proposalIdFromComboId('combo:p1')).toBe('p1')
  })

  it('leaves a bare id untouched', () => {
    expect(proposalIdFromComboId('p1')).toBe('p1')
  })
})

describe('buildG6Data', () => {
  it('emits one collapsed combo per proposal with dominant status and count', () => {
    const tasks = [
      task({ id: 't1', cluster: 'Blocked', parentProposalId: 'p1' }),
      task({ id: 't2', cluster: 'Blocked', parentProposalId: 'p1' }),
    ]
    const { combos } = buildG6Data(tasks, [proposal('p1', 'Feature A')])
    expect(combos).toHaveLength(1)
    expect(combos[0]!.id).toBe('combo:p1')
    expect(combos[0]!.style?.collapsed).toBe(true)
    expect(combos[0]!.data).toMatchObject({ label: 'Feature A', proposalId: 'p1', count: 2, dom: 'Blocked' })
  })

  it('assigns each in-scope task node to its proposal combo with a prompt-derived label', () => {
    const tasks = [task({ id: 't1', cluster: 'Queued', parentProposalId: 'p1', prompt: 'Do the thing\nmore detail' })]
    const { nodes } = buildG6Data(tasks, [proposal('p1')])
    expect(nodes).toHaveLength(1)
    expect(nodes[0]!.id).toBe('t1')
    expect(nodes[0]!.combo).toBe('combo:p1')
    expect(nodes[0]!.data).toMatchObject({ label: 'Do the thing', cluster: 'Queued', proposalId: 'p1' })
  })

  it('includes unattached tasks (null parentProposalId) under the Unattached combo, not dropped', () => {
    const tasks = [
      task({ id: 't1', cluster: 'Queued', parentProposalId: null }),
      task({ id: 't2', cluster: 'Queued', parentProposalId: 'p-missing' }),
      task({ id: 't3', cluster: 'Queued', parentProposalId: 'p1' }),
    ]
    const { nodes, combos } = buildG6Data(tasks, [proposal('p1')])
    // All three tasks are now nodes (none dropped)
    expect(nodes.map((n) => n.id).sort()).toEqual(['t1', 't2', 't3'])
    // Unattached tasks route to the synthetic combo
    expect(nodes.find((n) => n.id === 't1')?.combo).toBe(UNATTACHED_COMBO_ID)
    expect(nodes.find((n) => n.id === 't2')?.combo).toBe(UNATTACHED_COMBO_ID)
    expect(nodes.find((n) => n.id === 't3')?.combo).toBe('combo:p1')
    // The Unattached combo is emitted
    expect(combos.some((c) => c.id === UNATTACHED_COMBO_ID)).toBe(true)
  })

  it('keys blocker edges with blockerKey so the highlight map can match', () => {
    const tasks = [
      task({ id: 'a', cluster: 'In progress', parentProposalId: 'p1' }),
      task({ id: 'b', cluster: 'Blocked', parentProposalId: 'p1', blockedBy: ['a'] }),
    ]
    const { edges } = buildG6Data(tasks, [proposal('p1')])
    expect(edges).toHaveLength(1)
    expect(edges[0]!.id).toBe(blockerKey('a', 'b'))
    expect(edges[0]!.source).toBe('a')
    expect(edges[0]!.target).toBe('b')
    expect(edges[0]!.data).toMatchObject({ kind: 'blocker' })
  })

  it('drops blocker edges whose blocker is out of scope', () => {
    const tasks = [
      // blocked by an orphan task that won't be a node
      task({ id: 'b', cluster: 'Blocked', parentProposalId: 'p1', blockedBy: ['ghost'] }),
    ]
    const { edges } = buildG6Data(tasks, [proposal('p1')])
    expect(edges).toHaveLength(0)
  })

  it('follows cross-proposal blocker edges (both endpoints in scope)', () => {
    const tasks = [
      task({ id: 'a', cluster: 'In progress', parentProposalId: 'p1' }),
      task({ id: 'b', cluster: 'Blocked', parentProposalId: 'p2', blockedBy: ['a'] }),
    ]
    const { edges } = buildG6Data(tasks, [proposal('p1'), proposal('p2')])
    expect(edges).toHaveLength(1)
    expect(edges[0]!.id).toBe(blockerKey('a', 'b'))
  })
})

describe('buildG6Data – unattached tasks', () => {
  it('emits the Unattached combo with label "Unattached", correct count, and dom when unattached tasks exist', () => {
    const tasks = [
      task({ id: 'a1', cluster: 'Failed', parentProposalId: null }),
      task({ id: 'a2', cluster: 'Failed', parentProposalId: null }),
      task({ id: 'p1t', cluster: 'Queued', parentProposalId: 'p1' }),
    ]
    const { combos } = buildG6Data(tasks, [proposal('p1', 'Feature A')])
    const unattached = combos.find((c) => c.id === UNATTACHED_COMBO_ID)
    expect(unattached).toBeDefined()
    expect(unattached!.data).toMatchObject({ label: 'Unattached', count: 2, dom: 'Failed' })
    expect(unattached!.style?.collapsed).toBe(true)
  })

  it('marks the Unattached combo with synthetic: true so TopologyView can apply neutral label styling', () => {
    const tasks = [task({ id: 'a1', cluster: 'Failed', parentProposalId: null })]
    const { combos } = buildG6Data(tasks, [])
    const unattached = combos.find((c) => c.id === UNATTACHED_COMBO_ID)
    expect(unattached!.data?.synthetic).toBe(true)
    // Real proposal combos must NOT be marked synthetic
    const proposalTasks = [task({ id: 'p1t', cluster: 'Queued', parentProposalId: 'p1' })]
    const { combos: propCombos } = buildG6Data(proposalTasks, [proposal('p1', 'Feature A')])
    expect(propCombos.find((c) => c.id === 'combo:p1')?.data?.synthetic).toBeFalsy()
  })

  it('assigns unattached tasks to UNATTACHED_COMBO_ID with proposalId "__unattached__"', () => {
    const tasks = [
      task({ id: 'a1', cluster: 'Queued', parentProposalId: null }),
      task({ id: 'p1t', cluster: 'Queued', parentProposalId: 'p1' }),
    ]
    const { nodes } = buildG6Data(tasks, [proposal('p1')])
    const unattachedNode = nodes.find((n) => n.id === 'a1')
    expect(unattachedNode?.combo).toBe(UNATTACHED_COMBO_ID)
    expect(unattachedNode?.data?.proposalId).toBe('__unattached__')
    // Proposal task stays on its own combo with its own proposalId
    const propNode = nodes.find((n) => n.id === 'p1t')
    expect(propNode?.combo).toBe('combo:p1')
    expect(propNode?.data?.proposalId).toBe('p1')
  })

  it('total node count equals all tasks (proposal + unattached), no tasks dropped', () => {
    const tasks = [
      task({ id: 'a1', cluster: 'Queued', parentProposalId: null }),
      task({ id: 'a2', cluster: 'Blocked', parentProposalId: 'unknown' }),
      task({ id: 'p1', cluster: 'Queued', parentProposalId: 'prop1' }),
      task({ id: 'p2', cluster: 'Failed', parentProposalId: 'prop1' }),
    ]
    const { nodes } = buildG6Data(tasks, [proposal('prop1')])
    expect(nodes).toHaveLength(4)
  })

  it('does NOT emit the Unattached combo when all tasks belong to proposals', () => {
    const tasks = [
      task({ id: 'p1t', cluster: 'Queued', parentProposalId: 'p1' }),
      task({ id: 'p2t', cluster: 'Failed', parentProposalId: 'p1' }),
    ]
    const { combos } = buildG6Data(tasks, [proposal('p1')])
    expect(combos.some((c) => c.id === UNATTACHED_COMBO_ID)).toBe(false)
    expect(combos).toHaveLength(1)
  })

  it('renders under the Unattached combo with no proposals emitted when ALL tasks are unattached', () => {
    const tasks = [
      task({ id: 'a1', cluster: 'Queued', parentProposalId: null }),
      task({ id: 'a2', cluster: 'Blocked', parentProposalId: null }),
    ]
    const { nodes, combos } = buildG6Data(tasks, [])
    expect(nodes).toHaveLength(2)
    expect(nodes.every((n) => n.combo === UNATTACHED_COMBO_ID)).toBe(true)
    expect(combos).toHaveLength(1)
    expect(combos[0]!.id).toBe(UNATTACHED_COMBO_ID)
  })

  it('treats a task whose parentProposalId references an unknown proposal as unattached', () => {
    const tasks = [task({ id: 'x', cluster: 'Queued', parentProposalId: 'not-a-real-proposal' })]
    const { nodes, combos } = buildG6Data(tasks, [])
    expect(nodes[0]?.combo).toBe(UNATTACHED_COMBO_ID)
    expect(combos.some((c) => c.id === UNATTACHED_COMBO_ID)).toBe(true)
  })

  it('draws a blocker edge from an ad hoc task to a proposal task (cross-boundary)', () => {
    const tasks = [
      task({ id: 'blocker', cluster: 'In progress', parentProposalId: null }),
      task({ id: 'blocked', cluster: 'Blocked', parentProposalId: 'p1', blockedBy: ['blocker'] }),
    ]
    const { edges } = buildG6Data(tasks, [proposal('p1')])
    expect(edges).toHaveLength(1)
    expect(edges[0]!.id).toBe(blockerKey('blocker', 'blocked'))
    expect(edges[0]!.source).toBe('blocker')
    expect(edges[0]!.target).toBe('blocked')
  })

  it('draws a blocker edge from a proposal task to an ad hoc task (cross-boundary)', () => {
    const tasks = [
      task({ id: 'prop', cluster: 'In progress', parentProposalId: 'p1' }),
      task({ id: 'adhoc', cluster: 'Blocked', parentProposalId: null, blockedBy: ['prop'] }),
    ]
    const { edges } = buildG6Data(tasks, [proposal('p1')])
    expect(edges).toHaveLength(1)
    expect(edges[0]!.id).toBe(blockerKey('prop', 'adhoc'))
  })
})

describe('computeStateMap', () => {
  // a tiny graph: combo p1 -> [a (In progress), b (Blocked)], edge a->b
  const snapshot = (): ElementSnapshot => ({
    nodes: [
      { id: 'a', combo: 'combo:p1', data: { cluster: 'In progress', proposalId: 'p1' } },
      { id: 'b', combo: 'combo:p1', data: { cluster: 'Blocked', proposalId: 'p1' } },
    ],
    edges: [{ id: blockerKey('a', 'b'), source: 'a', target: 'b', data: { kind: 'blocker' } }],
    combos: [{ id: 'combo:p1', data: { proposalId: 'p1' } }],
  })
  const edgeId = blockerKey('a', 'b')

  it('leaves everything at-rest with no filters and no hover', () => {
    const map = computeStateMap(snapshot(), { searchMatchIds: null, ghostedClusters: undefined, lit: null })
    expect(map.a).toEqual([])
    expect(map.b).toEqual([])
    expect(map[edgeId]).toEqual([])
    expect(map['combo:p1']).toEqual([])
  })

  it('dims nodes outside the search set', () => {
    const map = computeStateMap(snapshot(), {
      searchMatchIds: new Set(['a']),
      ghostedClusters: undefined,
      lit: null,
    })
    expect(map.a).toEqual([])
    expect(map.b).toEqual(['dim'])
  })

  it('dims nodes whose cluster is ghosted, and the proposal combo when "Proposal" is ghosted', () => {
    const map = computeStateMap(snapshot(), {
      searchMatchIds: null,
      ghostedClusters: new Set(['Blocked', 'Proposal']),
      lit: null,
    })
    expect(map.a).toEqual([])
    expect(map.b).toEqual(['dim'])
    expect(map['combo:p1']).toEqual(['dim'])
  })

  it('dims an edge when either endpoint is filtered out', () => {
    const map = computeStateMap(snapshot(), {
      searchMatchIds: new Set(['a']), // b is filtered → edge a->b dims
      ghostedClusters: undefined,
      lit: null,
    })
    expect(map[edgeId]).toEqual(['dim'])
  })

  it('with a hover trace, lights the lit set and dims everything else', () => {
    const lit: ChainResult = { nodes: new Set(['a', 'b']), edges: new Set([edgeId]), proposals: new Set(['p1']) }
    const map = computeStateMap(snapshot(), { searchMatchIds: null, ghostedClusters: undefined, lit })
    expect(map.a).toEqual(['active'])
    expect(map.b).toEqual(['active'])
    expect(map[edgeId]).toEqual(['active'])
    expect(map['combo:p1']).toEqual(['active'])
  })

  it('filters still suppress a hover-lit element (search wins over active)', () => {
    const lit: ChainResult = { nodes: new Set(['a', 'b']), edges: new Set([edgeId]), proposals: new Set(['p1']) }
    const map = computeStateMap(snapshot(), {
      searchMatchIds: new Set(['a']), // b is lit but filtered out → dim, not active
      ghostedClusters: undefined,
      lit,
    })
    expect(map.a).toEqual(['active'])
    expect(map.b).toEqual(['dim'])
  })

  it('dims a hover-unlit element even if it passes the filters', () => {
    const lit: ChainResult = { nodes: new Set(['a']), edges: new Set(), proposals: new Set(['p1']) }
    const map = computeStateMap(snapshot(), { searchMatchIds: null, ghostedClusters: undefined, lit })
    expect(map.a).toEqual(['active'])
    expect(map.b).toEqual(['dim'])
  })
})

describe('computeStateMap – unattached combo lighting', () => {
  // Graph: unattached task 'x', proposal task 'y' (in p1), edge x→y
  const unattachedSnapshot = (): ElementSnapshot => ({
    nodes: [
      { id: 'x', combo: UNATTACHED_COMBO_ID, data: { cluster: 'Queued', proposalId: '__unattached__' } },
      { id: 'y', combo: 'combo:p1', data: { cluster: 'Blocked', proposalId: 'p1' } },
    ],
    edges: [{ id: blockerKey('x', 'y'), source: 'x', target: 'y', data: { kind: 'blocker' } }],
    combos: [
      { id: UNATTACHED_COMBO_ID, data: { proposalId: '__unattached__' } },
      { id: 'combo:p1', data: { proposalId: 'p1' } },
    ],
  })
  const crossEdgeId = blockerKey('x', 'y')

  it('lights the Unattached combo when a hover trace includes an unattached node', () => {
    // chainForTask on 'x' will populate lit.nodes with 'x' (and 'y' downstream)
    // but lit.proposals will NOT include '__unattached__' because attachProvenance skips
    // null parentProposalId. The combo must still light via node-data derivation.
    const lit: ChainResult = { nodes: new Set(['x', 'y']), edges: new Set([crossEdgeId]), proposals: new Set(['p1']) }
    const map = computeStateMap(unattachedSnapshot(), { searchMatchIds: null, ghostedClusters: undefined, lit })
    expect(map[UNATTACHED_COMBO_ID]).toEqual(['active'])
    expect(map['combo:p1']).toEqual(['active'])
    expect(map.x).toEqual(['active'])
    expect(map.y).toEqual(['active'])
    expect(map[crossEdgeId]).toEqual(['active'])
  })

  it('does not light the Unattached combo when no unattached node is in the lit set', () => {
    // Only proposal task 'y' is lit
    const lit: ChainResult = { nodes: new Set(['y']), edges: new Set(), proposals: new Set(['p1']) }
    const map = computeStateMap(unattachedSnapshot(), { searchMatchIds: null, ghostedClusters: undefined, lit })
    expect(map[UNATTACHED_COMBO_ID]).toEqual(['dim'])
    expect(map.x).toEqual(['dim'])
  })
})

describe('dataSignature', () => {
  it('is stable for identical inputs', () => {
    const a = [task({ id: 't1', cluster: 'Queued', parentProposalId: 'p1' })]
    const p = [proposal('p1')]
    expect(dataSignature(a, p)).toBe(dataSignature(a, p))
  })

  it('changes when a task cluster changes', () => {
    const before = dataSignature([task({ id: 't1', cluster: 'Queued' })], [])
    const after = dataSignature([task({ id: 't1', cluster: 'Blocked' })], [])
    expect(before).not.toBe(after)
  })

  it('changes when a blocker edge is added', () => {
    const before = dataSignature([task({ id: 't1', cluster: 'Queued' })], [])
    const after = dataSignature([task({ id: 't1', cluster: 'Queued', blockedBy: ['x'] })], [])
    expect(before).not.toBe(after)
  })

  it('changes when a proposal title changes', () => {
    const before = dataSignature([], [proposal('p1', 'Old')])
    const after = dataSignature([], [proposal('p1', 'New')])
    expect(before).not.toBe(after)
  })
})

describe('structuralSignature', () => {
  it('is stable when only cluster changes (failed/blocked transition does not force rebuild)', () => {
    const before = structuralSignature([task({ id: 't1', cluster: 'In progress' })], [])
    const after = structuralSignature([task({ id: 't1', cluster: 'Failed' })], [])
    expect(before).toBe(after)
  })

  it('is stable for queued → blocked transition', () => {
    const before = structuralSignature([task({ id: 't1', cluster: 'Queued' })], [])
    const after = structuralSignature([task({ id: 't1', cluster: 'Blocked' })], [])
    expect(before).toBe(after)
  })

  it('changes when a task is added', () => {
    const before = structuralSignature([task({ id: 't1', cluster: 'Queued' })], [])
    const after = structuralSignature(
      [task({ id: 't1', cluster: 'Queued' }), task({ id: 't2', cluster: 'Queued' })],
      [],
    )
    expect(before).not.toBe(after)
  })

  it('changes when a blocker edge is added', () => {
    const before = structuralSignature([task({ id: 't1', cluster: 'Queued' })], [])
    const after = structuralSignature([task({ id: 't1', cluster: 'Queued', blockedBy: ['other'] })], [])
    expect(before).not.toBe(after)
  })

  it('changes when a proposal title changes', () => {
    const before = structuralSignature([], [proposal('p1', 'Old')])
    const after = structuralSignature([], [proposal('p1', 'New')])
    expect(before).not.toBe(after)
  })
})

describe('clusterSignature', () => {
  it('changes when a task transitions to Failed', () => {
    const before = clusterSignature([task({ id: 't1', cluster: 'In progress' })])
    const after = clusterSignature([task({ id: 't1', cluster: 'Failed' })])
    expect(before).not.toBe(after)
  })

  it('changes when a task transitions to Blocked', () => {
    const before = clusterSignature([task({ id: 't1', cluster: 'In progress' })])
    const after = clusterSignature([task({ id: 't1', cluster: 'Blocked' })])
    expect(before).not.toBe(after)
  })

  it('is stable when non-cluster task data changes', () => {
    const before = clusterSignature([task({ id: 't1', cluster: 'Failed', prompt: 'Old prompt' })])
    const after = clusterSignature([task({ id: 't1', cluster: 'Failed', prompt: 'New prompt' })])
    expect(before).toBe(after)
  })

  it('is stable for identical inputs', () => {
    const tasks = [task({ id: 't1', cluster: 'Blocked' }), task({ id: 't2', cluster: 'Failed' })]
    expect(clusterSignature(tasks)).toBe(clusterSignature(tasks))
  })
})

describe('buildG6Data – failed and blocked cluster node data', () => {
  it('assigns cluster: Failed to a failed task node so red fill/stroke apply', () => {
    const tasks = [task({ id: 'f1', cluster: 'Failed', parentProposalId: 'p1' })]
    const { nodes } = buildG6Data(tasks, [proposal('p1')])
    expect(nodes[0]!.data?.cluster).toBe('Failed')
  })

  it('assigns cluster: Blocked to a blocked task node so amber fill/stroke apply', () => {
    const tasks = [task({ id: 'b1', cluster: 'Blocked', parentProposalId: 'p1' })]
    const { nodes } = buildG6Data(tasks, [proposal('p1')])
    expect(nodes[0]!.data?.cluster).toBe('Blocked')
  })

  it('sets combo dom to Failed when all tasks failed (card turns red)', () => {
    const tasks = [
      task({ id: 'f1', cluster: 'Failed', parentProposalId: 'p1' }),
      task({ id: 'f2', cluster: 'Failed', parentProposalId: 'p1' }),
    ]
    const { combos } = buildG6Data(tasks, [proposal('p1')])
    expect(combos[0]!.data?.dom).toBe('Failed')
  })

  it('sets combo dom to Blocked when all tasks blocked (card turns amber)', () => {
    const tasks = [task({ id: 'b1', cluster: 'Blocked', parentProposalId: 'p1' })]
    const { combos } = buildG6Data(tasks, [proposal('p1')])
    expect(combos[0]!.data?.dom).toBe('Blocked')
  })
})
