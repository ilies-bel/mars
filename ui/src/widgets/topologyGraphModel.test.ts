import { describe, expect, it } from 'bun:test'

import { blockerKey, type ChainResult } from '@/shared/chainTrace'
import type { ProgressProposalNode, ProgressTask } from '@/shared/schemas'
import {
  arcKeyFromComboId,
  buildG6Data,
  CLUSTER_STYLE,
  computeStateMap,
  dataSignature,
  dominant,
  type ElementSnapshot,
  pulseOpacity,
  PULSE_MIN_OPACITY,
  PULSE_PERIOD_MS,
  rollupByProposal,
  type Rollup,
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
