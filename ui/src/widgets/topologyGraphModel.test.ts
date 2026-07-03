import { describe, expect, it } from 'bun:test'

import { blockerKey, type ChainResult } from '@/shared/chainTrace'
import type { ProgressProposalNode, ProgressTask } from '@/shared/schemas'
import {
  arcKeyFromComboId,
  buildClusterStyleFromVars,
  buildG6Data,
  CARD_HALF_H,
  CARD_HALF_W,
  CLUSTER_STYLE,
  type CollisionBox,
  type CollisionCard,
  computeStateMap,
  computeVisualUpdates,
  dataSignature,
  dominant,
  type ElementSnapshot,
  LAYOUT_COL,
  LAYOUT_ROW,
  layeredPositions,
  MAX_COLLISION_PASSES,
  pulseOpacity,
  PULSE_MIN_OPACITY,
  PULSE_PERIOD_MS,
  resolveCardCollisions,
  rollupByProposal,
  type Rollup,
  structuralSignature,
  type VisualDiff,
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
})

describe('buildClusterStyleFromVars', () => {
  // These values mirror the --color-dag-* tokens defined in index.css.
  // The test exercises the CSS-var-name coupling contract: if a name drifts,
  // the resolver returns '' and the assertions fail.
  const CSS: Record<string, string> = {
    '--color-dag-in-progress-fill':   '#431407',
    '--color-dag-in-progress-stroke': '#ea580c',
    '--color-dag-in-progress-text':   '#fdba74',
    '--color-dag-blocked-fill':       '#3f2a14',
    '--color-dag-blocked-stroke':     '#d9a441',
    '--color-dag-blocked-text':       '#fde9c8',
    '--color-dag-failed-fill':        '#450a0a',
    '--color-dag-failed-stroke':      '#dc2626',
    '--color-dag-failed-text':        '#fca5a5',
    '--color-dag-queued-fill':        '#2a2a30',
    '--color-dag-queued-stroke':      '#9ca3af',
    '--color-dag-queued-text':        '#e5e7eb',
  }
  const getVar = (name: string) => CSS[name] ?? ''

  it('resolves to a non-empty color for every cluster key', () => {
    const style = buildClusterStyleFromVars(getVar)
    for (const cluster of ['In progress', 'Blocked', 'Queued', 'Failed'] as const) {
      expect(style[cluster].fill).not.toBe('')
      expect(style[cluster].stroke).not.toBe('')
      expect(style[cluster].text).not.toBe('')
      expect(style[cluster].dot).not.toBe('')
    }
  })

  it('derives dot from stroke', () => {
    const style = buildClusterStyleFromVars(getVar)
    for (const cluster of ['In progress', 'Blocked', 'Queued', 'Failed'] as const) {
      expect(style[cluster].dot).toBe(style[cluster].stroke)
    }
  })

  it('keeps Blocked (warm ochre) and Queued (cool grey) visually distinct', () => {
    const style = buildClusterStyleFromVars(getVar)
    expect(style.Blocked.fill).not.toBe(style.Queued.fill)
    expect(style.Blocked.stroke).not.toBe(style.Queued.stroke)
  })
})

describe('arcKeyFromComboId', () => {
  it('strips the combo: prefix', () => {
    expect(arcKeyFromComboId('combo:p1')).toBe('p1')
  })

  it('leaves a bare id untouched', () => {
    expect(arcKeyFromComboId('p1')).toBe('p1')
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
    // Two tasks in p1 → multi-task arc → combo is created; nodes point to it.
    const tasks = [
      task({ id: 't1', cluster: 'Queued', parentProposalId: 'p1', prompt: 'Do the thing\nmore detail' }),
      task({ id: 't2', cluster: 'Queued', parentProposalId: 'p1' }),
    ]
    const { nodes } = buildG6Data(tasks, [proposal('p1')])
    expect(nodes).toHaveLength(2)
    const t1Node = nodes.find((n) => n.id === 't1')!
    expect(t1Node.combo).toBe('combo:p1')
    expect(t1Node.data).toMatchObject({ label: 'Do the thing', cluster: 'Queued', proposalId: 'p1' })
  })

  it('renders all tasks as nodes — no task is silently dropped', () => {
    const tasks = [
      task({ id: 't1', cluster: 'Queued', parentProposalId: null }),
      task({ id: 't2', cluster: 'Queued', parentProposalId: 'p-missing' }),
      task({ id: 't3', cluster: 'Queued', parentProposalId: 'p1' }),
    ]
    const { nodes, combos } = buildG6Data(tasks, [proposal('p1')])
    expect(nodes.map((n) => n.id).sort()).toEqual(['t1', 't2', 't3'])
    // All three arcs have exactly one task → all are bare nodes, no combos.
    expect(combos).toHaveLength(0)
    expect(nodes.every((n) => n.combo === undefined)).toBe(true)
  })

  it('groups tasks sharing the same originId into one arc combo', () => {
    const tasks = [
      task({ id: 'origin', cluster: 'In progress', originId: 'origin' }),
      task({ id: 'slice1', cluster: 'Queued', originId: 'origin' }),
      task({ id: 'slice2', cluster: 'Blocked', originId: 'origin' }),
    ]
    const { nodes, combos } = buildG6Data(tasks, [])
    expect(combos).toHaveLength(1)
    expect(combos[0]!.id).toBe('combo:origin')
    expect(combos[0]!.data).toMatchObject({ arcKey: 'origin', count: 3 })
    expect(nodes).toHaveLength(3)
    expect(nodes.every((n) => n.combo === 'combo:origin')).toBe(true)
  })

  it('uses the origin task prompt as the arc combo label for non-proposal arcs', () => {
    const tasks = [
      task({ id: 'origin', cluster: 'In progress', originId: 'origin', prompt: 'Build the widget\ndetails here' }),
      task({ id: 'slice1', cluster: 'Queued', originId: 'origin' }),
    ]
    const { combos } = buildG6Data(tasks, [])
    expect(combos[0]!.data?.label).toBe('Build the widget')
  })

  it('single-task arc is a bare top-level node (no combo); multi-task arc still gets its combo', () => {
    const tasks = [
      // solo arc: arcKey = 'solo' (1 task) → bare node
      task({ id: 'solo', cluster: 'Queued' }),
      // multi-task arc: arcKey = 'grp' (2 tasks) → combo
      task({ id: 'grp', cluster: 'In progress', originId: 'grp' }),
      task({ id: 'grp2', cluster: 'Queued', originId: 'grp' }),
    ]
    const { combos, nodes } = buildG6Data(tasks, [])

    // Only the multi-task arc produces a combo
    expect(combos).toHaveLength(1)
    expect(combos[0]!.id).toBe('combo:grp')

    // solo node has no combo
    const soloNode = nodes.find((n) => n.id === 'solo')!
    expect(soloNode.combo).toBeUndefined()

    // multi-task arc nodes are assigned to their combo
    const grpNode = nodes.find((n) => n.id === 'grp')!
    expect(grpNode.combo).toBe('combo:grp')
    const grp2Node = nodes.find((n) => n.id === 'grp2')!
    expect(grp2Node.combo).toBe('combo:grp')
  })

  it('emits a recovery edge (kind=recovery) for fix tasks pointing source=fixForTaskId, target=fix', () => {
    const tasks = [
      task({ id: 'origin', cluster: 'Failed' }),
      task({ id: 'fix1', cluster: 'Queued', kind: 'fix', fixForTaskId: 'origin', originId: 'origin' }),
    ]
    const { edges } = buildG6Data(tasks, [])
    const recoveryEdge = edges.find((e) => e.data?.kind === 'recovery')
    expect(recoveryEdge).toBeDefined()
    expect(recoveryEdge?.source).toBe('origin')
    expect(recoveryEdge?.target).toBe('fix1')
    expect(recoveryEdge?.id).toBe('recovery:fix1')
  })

  it('does not emit a recovery edge when the fixForTaskId target is not in scope', () => {
    const tasks = [
      task({ id: 'fix1', cluster: 'Queued', kind: 'fix', fixForTaskId: 'ghost', originId: 'ghost' }),
    ]
    const { edges } = buildG6Data(tasks, [])
    expect(edges.filter((e) => e.data?.kind === 'recovery')).toHaveLength(0)
  })

  it('groups fix task into the same arc combo as its origin via originId', () => {
    const tasks = [
      task({ id: 'origin', cluster: 'Failed', originId: 'origin' }),
      task({ id: 'fix1', cluster: 'Queued', kind: 'fix', fixForTaskId: 'origin', originId: 'origin' }),
    ]
    const { combos, nodes } = buildG6Data(tasks, [])
    expect(combos).toHaveLength(1)
    expect(nodes.every((n) => n.combo === 'combo:origin')).toBe(true)
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

describe('computeStateMap', () => {
  // a tiny graph: combo p1 -> [a (In progress), b (Blocked)], edge a->b
  const snapshot = (): ElementSnapshot => ({
    nodes: [
      { id: 'a', combo: 'combo:p1', data: { cluster: 'In progress', proposalId: 'p1' } },
      { id: 'b', combo: 'combo:p1', data: { cluster: 'Blocked', proposalId: 'p1' } },
    ],
    edges: [{ id: blockerKey('a', 'b'), source: 'a', target: 'b', data: { kind: 'blocker' } }],
    combos: [{ id: 'combo:p1', data: { arcKey: 'p1', proposalId: 'p1' } }],
  })
  const edgeId = blockerKey('a', 'b')

  it('leaves everything at-rest with no filters and no hover', () => {
    const map = computeStateMap(snapshot(), { searchMatchIds: null, lit: null })
    expect(map.a).toEqual([])
    expect(map.b).toEqual([])
    expect(map[edgeId]).toEqual([])
    expect(map['combo:p1']).toEqual([])
  })

  it('dims nodes outside the search set', () => {
    const map = computeStateMap(snapshot(), {
      searchMatchIds: new Set(['a']),
      lit: null,
    })
    expect(map.a).toEqual([])
    expect(map.b).toEqual(['dim'])
  })

  it('dims an edge when either endpoint is filtered out', () => {
    const map = computeStateMap(snapshot(), {
      searchMatchIds: new Set(['a']), // b is filtered → edge a->b dims
      lit: null,
    })
    expect(map[edgeId]).toEqual(['dim'])
  })

  it('with a hover trace, lights the lit set and dims everything else', () => {
    const lit: ChainResult = { nodes: new Set(['a', 'b']), edges: new Set([edgeId]), proposals: new Set(['p1']) }
    const map = computeStateMap(snapshot(), { searchMatchIds: null, lit })
    expect(map.a).toEqual(['active'])
    expect(map.b).toEqual(['active'])
    expect(map[edgeId]).toEqual(['active'])
    expect(map['combo:p1']).toEqual(['active'])
  })

  it('filters still suppress a hover-lit element (search wins over active)', () => {
    const lit: ChainResult = { nodes: new Set(['a', 'b']), edges: new Set([edgeId]), proposals: new Set(['p1']) }
    const map = computeStateMap(snapshot(), {
      searchMatchIds: new Set(['a']), // b is lit but filtered out → dim, not active
      lit,
    })
    expect(map.a).toEqual(['active'])
    expect(map.b).toEqual(['dim'])
  })

  it('dims a hover-unlit element even if it passes the filters', () => {
    const lit: ChainResult = { nodes: new Set(['a']), edges: new Set(), proposals: new Set(['p1']) }
    const map = computeStateMap(snapshot(), { searchMatchIds: null, lit })
    expect(map.a).toEqual(['active'])
    expect(map.b).toEqual(['dim'])
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

  it('changes when originId is set', () => {
    const before = dataSignature([task({ id: 't1', cluster: 'Queued' })], [])
    const after = dataSignature([task({ id: 't1', cluster: 'Queued', originId: 'origin' })], [])
    expect(before).not.toBe(after)
  })

  it('changes when fixForTaskId is set (recovery relationship appears)', () => {
    const before = dataSignature([task({ id: 't1', cluster: 'Queued' })], [])
    const after = dataSignature([task({ id: 't1', cluster: 'Queued', fixForTaskId: 'x' })], [])
    expect(before).not.toBe(after)
  })
})

describe('structuralSignature', () => {
  it('is stable for identical inputs', () => {
    const a = [task({ id: 't1', cluster: 'Queued', parentProposalId: 'p1' })]
    const p = [proposal('p1')]
    expect(structuralSignature(a, p)).toBe(structuralSignature(a, p))
  })

  it('does NOT change when a task cluster changes — cluster is a visual-only property', () => {
    const before = structuralSignature([task({ id: 't1', cluster: 'Queued' })], [])
    const after = structuralSignature([task({ id: 't1', cluster: 'Blocked' })], [])
    expect(before).toBe(after)
  })

  it('changes when a blocker edge is added', () => {
    const before = structuralSignature([task({ id: 't1', cluster: 'Queued' })], [])
    const after = structuralSignature([task({ id: 't1', cluster: 'Queued', blockedBy: ['x'] })], [])
    expect(before).not.toBe(after)
  })

  it('changes when a proposal title changes', () => {
    const before = structuralSignature([], [proposal('p1', 'Old')])
    const after = structuralSignature([], [proposal('p1', 'New')])
    expect(before).not.toBe(after)
  })

  it('changes when originId is set', () => {
    const before = structuralSignature([task({ id: 't1', cluster: 'Queued' })], [])
    const after = structuralSignature([task({ id: 't1', cluster: 'Queued', originId: 'origin' })], [])
    expect(before).not.toBe(after)
  })

  it('changes when fixForTaskId is set (recovery relationship appears)', () => {
    const before = structuralSignature([task({ id: 't1', cluster: 'Queued' })], [])
    const after = structuralSignature([task({ id: 't1', cluster: 'Queued', fixForTaskId: 'x' })], [])
    expect(before).not.toBe(after)
  })

  it('changes when a task is added', () => {
    const before = structuralSignature([task({ id: 't1', cluster: 'Queued' })], [])
    const after = structuralSignature(
      [task({ id: 't1', cluster: 'Queued' }), task({ id: 't2', cluster: 'In progress' })],
      [],
    )
    expect(before).not.toBe(after)
  })
})

describe('computeVisualUpdates', () => {
  // Helper: make a minimal G6 NodeData-like object
  const liveNode = (
    id: string,
    cluster: ProgressTask['cluster'],
    comboId?: string,
  ): ElementSnapshot['nodes'][0] => ({
    id,
    combo: comboId,
    data: { cluster, label: id, proposalId: null },
  })

  // Helper: make a minimal G6 ComboData-like object
  const liveCombo = (
    id: string,
    dom: ProgressTask['cluster'],
  ): ElementSnapshot['combos'][0] => ({
    id,
    data: { dom, label: id, arcKey: id.replace(/^combo:/, ''), proposalId: null, count: 1 },
    style: { collapsed: true },
  })

  it('returns empty diffs when cluster values are unchanged', () => {
    const tasks = [task({ id: 't1', cluster: 'Queued', parentProposalId: 'p1' })]
    const nodes = [liveNode('t1', 'Queued', 'combo:p1')]
    const combos = [liveCombo('combo:p1', 'Queued')]
    const diff: VisualDiff = computeVisualUpdates(tasks, nodes, combos)
    expect(diff.nodeUpdates).toHaveLength(0)
    expect(diff.comboUpdates).toHaveLength(0)
  })

  it('returns a node update when a task cluster changes', () => {
    const tasks = [task({ id: 't1', cluster: 'In progress', parentProposalId: 'p1' })]
    const nodes = [liveNode('t1', 'Queued', 'combo:p1')] // stale: was Queued
    const combos = [liveCombo('combo:p1', 'Queued')]
    const diff = computeVisualUpdates(tasks, nodes, combos)
    expect(diff.nodeUpdates).toHaveLength(1)
    expect(diff.nodeUpdates[0]).toEqual({ id: 't1', data: { cluster: 'In progress' } })
  })

  it('returns a combo update when the dominant cluster changes', () => {
    // Two tasks in same combo; both flip from Queued to In progress
    const tasks = [
      task({ id: 't1', cluster: 'In progress', parentProposalId: 'p1' }),
      task({ id: 't2', cluster: 'In progress', parentProposalId: 'p1' }),
    ]
    const nodes = [liveNode('t1', 'Queued', 'combo:p1'), liveNode('t2', 'Queued', 'combo:p1')]
    const combos = [liveCombo('combo:p1', 'Queued')] // stale dom
    const diff = computeVisualUpdates(tasks, nodes, combos)
    expect(diff.comboUpdates).toHaveLength(1)
    expect(diff.comboUpdates[0]).toEqual({ id: 'combo:p1', data: { dom: 'In progress' } })
  })

  it('does not emit a combo update when dominant cluster is still correct', () => {
    // Only one task changes, but plurality stays the same (2 Queued, 1 flips to In progress)
    const tasks = [
      task({ id: 't1', cluster: 'Queued', parentProposalId: 'p1' }),
      task({ id: 't2', cluster: 'Queued', parentProposalId: 'p1' }),
      task({ id: 't3', cluster: 'In progress', parentProposalId: 'p1' }), // minority
    ]
    // Live nodes still show all Queued (t3 just flipped)
    const nodes = [
      liveNode('t1', 'Queued', 'combo:p1'),
      liveNode('t2', 'Queued', 'combo:p1'),
      liveNode('t3', 'Queued', 'combo:p1'),
    ]
    const combos = [liveCombo('combo:p1', 'Queued')] // plurality is still Queued
    const diff = computeVisualUpdates(tasks, nodes, combos)
    // Node update for t3, but no combo update (dom stays Queued)
    expect(diff.nodeUpdates).toHaveLength(1)
    expect(diff.nodeUpdates[0]!.id).toBe('t3')
    expect(diff.comboUpdates).toHaveLength(0)
  })

  it('ignores nodes not present in the task list (out-of-scope)', () => {
    const tasks: ProgressTask[] = [] // no tasks
    const nodes = [liveNode('ghost', 'Queued', 'combo:p1')]
    const combos = [liveCombo('combo:p1', 'Queued')]
    const diff = computeVisualUpdates(tasks, nodes, combos)
    expect(diff.nodeUpdates).toHaveLength(0)
  })
})

describe('pulseOpacity', () => {
  it('returns 1.0 at elapsed 0 (full opacity at start)', () => {
    expect(pulseOpacity(0)).toBeCloseTo(1.0, 5)
  })

  it('returns PULSE_MIN_OPACITY at the half-period (dip)', () => {
    expect(pulseOpacity(PULSE_PERIOD_MS / 2)).toBeCloseTo(PULSE_MIN_OPACITY, 5)
  })

  it('returns 1.0 at the full period (back to full opacity)', () => {
    expect(pulseOpacity(PULSE_PERIOD_MS)).toBeCloseTo(1.0, 5)
  })

  it('stays within [PULSE_MIN_OPACITY, 1.0] across the full cycle', () => {
    for (let i = 0; i <= 100; i++) {
      const v = pulseOpacity((i / 100) * PULSE_PERIOD_MS)
      expect(v).toBeGreaterThanOrEqual(PULSE_MIN_OPACITY - 1e-10)
      expect(v).toBeLessThanOrEqual(1.0 + 1e-10)
    }
  })

  it('is periodic: value at t equals value at t + PULSE_PERIOD_MS', () => {
    const offsets = [0, 137, 400, 799, 1200]
    for (const t of offsets) {
      expect(pulseOpacity(t)).toBeCloseTo(pulseOpacity(t + PULSE_PERIOD_MS), 10)
    }
  })

  it('is continuous: adjacent samples differ by less than 0.05 at 60 fps', () => {
    const frameDuration = 1000 / 60
    for (let t = 0; t < PULSE_PERIOD_MS; t += frameDuration) {
      const diff = Math.abs(pulseOpacity(t + frameDuration) - pulseOpacity(t))
      expect(diff).toBeLessThan(0.05)
    }
  })
})

// ---------------------------------------------------------------------------
// layeredPositions — convergence-capped layout
// ---------------------------------------------------------------------------

describe('layeredPositions', () => {
  it('produces finite, centred positions for a 100-node linear chain', () => {
    const nodeIds = Array.from({ length: 100 }, (_, i) => `n${i}`)
    // Chain: n0 → n1 → … → n99 (one node per rank)
    const edges = nodeIds.slice(1).map((id, i) => ({
      id: `e${i}`,
      source: nodeIds[i]!,
      target: id,
    }))
    const pos = layeredPositions(nodeIds, edges)

    expect(pos.size).toBe(100)
    for (const [, p] of pos) {
      expect(isFinite(p.x)).toBe(true)
      expect(isFinite(p.y)).toBe(true)
      // A 100-node chain has 100 ranks; max half-extent = 49 * LAYOUT_COL
      expect(Math.abs(p.x)).toBeLessThanOrEqual(50 * LAYOUT_COL)
      // Chain has 1 node per rank → y is always 0
      expect(p.y).toBeCloseTo(0, 5)
    }
  })

  it('places all 100 disconnected nodes at x=0 with distinct, finite y values', () => {
    const nodeIds = Array.from({ length: 100 }, (_, i) => `n${i}`)
    const pos = layeredPositions(nodeIds, [])

    expect(pos.size).toBe(100)
    const positions = [...pos.values()]

    // All nodes share rank 0 → all at x = 0 after centering
    for (const p of positions) {
      expect(p.x).toBeCloseTo(0, 5)
      expect(isFinite(p.y)).toBe(true)
    }

    // All y values are distinct (spaced by LAYOUT_ROW)
    const ys = positions.map((p) => Math.round(p.y))
    expect(new Set(ys).size).toBe(100)

    // y extent is bounded: |y| ≤ 50 * LAYOUT_ROW (99 nodes span 99 * ROW total)
    for (const p of positions) {
      expect(Math.abs(p.y)).toBeLessThanOrEqual(50 * LAYOUT_ROW)
    }
  })

  it('positions are centred near (0,0) for a diamond graph', () => {
    // root → a, root → b; a → leaf, b → leaf
    const nodeIds = ['root', 'a', 'b', 'leaf']
    const edges = [
      { id: 'e1', source: 'root', target: 'a' },
      { id: 'e2', source: 'root', target: 'b' },
      { id: 'e3', source: 'a', target: 'leaf' },
      { id: 'e4', source: 'b', target: 'leaf' },
    ]
    const pos = layeredPositions(nodeIds, edges)
    expect(pos.size).toBe(4)
    for (const [, p] of pos) {
      expect(isFinite(p.x)).toBe(true)
      expect(isFinite(p.y)).toBe(true)
    }
    // root and leaf should be symmetrically on the x axis (y ≈ 0)
    expect(pos.get('root')!.y).toBeCloseTo(0, 5)
    expect(pos.get('leaf')!.y).toBeCloseTo(0, 5)
  })
})

// ---------------------------------------------------------------------------
// resolveCardCollisions — convergence + bounded-positions
// ---------------------------------------------------------------------------

describe('resolveCardCollisions', () => {
  // A box far from the action so it doesn't affect card-card tests.
  const FAR_BOX: CollisionBox = { w: 10, h: 10, cx: 10_000, cy: 10_000 }

  it('separates two overlapping cards and returns converged=true', () => {
    const cards: CollisionCard[] = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 10, y: 0 }, // 10 px apart — well within CW = CARD_HALF_W*2+12
    ]
    const converged = resolveCardCollisions(cards, FAR_BOX)
    expect(converged).toBe(true)
    const dx = Math.abs(cards[0]!.x - cards[1]!.x)
    // After resolution, cards must be at least CW apart in x or y.
    const dy = Math.abs(cards[0]!.y - cards[1]!.y)
    const minSep = CARD_HALF_W * 2 + 12 - 0.5
    expect(dx >= minSep || dy >= CARD_HALF_H * 2 + 12 - 0.5).toBe(true)
  })

  it('returns converged=true immediately when cards do not overlap', () => {
    const cards: CollisionCard[] = [
      { id: 'a', x: -2000, y: -2000 },
      { id: 'b', x: 2000, y: 2000 },
    ]
    const converged = resolveCardCollisions(cards, FAR_BOX)
    expect(converged).toBe(true)
    // Positions unchanged (well outside any overlap zone)
    expect(cards[0]!.x).toBeCloseTo(-2000, 1)
    expect(cards[1]!.x).toBeCloseTo(2000, 1)
  })

  it('pushes cards outside the open-combo box exclusion zone', () => {
    const box: CollisionBox = { w: 200, h: 150, cx: 0, cy: 0 }
    // Card placed exactly at the centre of the box.
    const cards: CollisionCard[] = [{ id: 'a', x: 0, y: 0 }]
    resolveCardCollisions(cards, box)
    // After resolution the card must be outside the exclusion zone
    // (halfW = box.w/2 + CARD_HALF_W + 16, halfH = box.h/2 + CARD_HALF_H + 16)
    const halfW = box.w / 2 + CARD_HALF_W + 16
    const halfH = box.h / 2 + CARD_HALF_H + 16
    const outside = Math.abs(cards[0]!.x) >= halfW || Math.abs(cards[0]!.y) >= halfH
    expect(outside).toBe(true)
  })

  it('produces finite positions for a 100-card fixture and converges within cap', () => {
    // 100 cards laid out in a 10×10 grid spaced well enough to converge fast.
    const cards: CollisionCard[] = Array.from({ length: 100 }, (_, i) => ({
      id: `c${i}`,
      x: (i % 10) * 300,
      y: Math.floor(i / 10) * 200,
    }))
    const converged = resolveCardCollisions(cards, FAR_BOX)

    expect(converged).toBe(true)
    for (const c of cards) {
      expect(isFinite(c.x)).toBe(true)
      expect(isFinite(c.y)).toBe(true)
    }
  })

  it('does not diverge (positions stay bounded) even if cap is hit', () => {
    // Worst case: 100 cards all at the same position.  The cap will be hit
    // (40 passes is not enough for 100 overlapping cards) but positions must
    // stay finite and not grow without bound.
    const cards: CollisionCard[] = Array.from({ length: 100 }, (_, i) => ({
      id: `c${i}`,
      x: 0,
      y: 0,
    }))
    const converged = resolveCardCollisions(cards, FAR_BOX, CARD_HALF_W, CARD_HALF_H, MAX_COLLISION_PASSES)
    // May or may not converge — the important thing is positions are bounded.
    void converged
    const MAX_DRIFT = 100 * (CARD_HALF_W * 2 + 12) // generous upper bound
    for (const c of cards) {
      expect(isFinite(c.x)).toBe(true)
      expect(isFinite(c.y)).toBe(true)
      expect(Math.abs(c.x)).toBeLessThan(MAX_DRIFT)
      expect(Math.abs(c.y)).toBeLessThan(MAX_DRIFT)
    }
  })
})
