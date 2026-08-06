import { describe, expect, it } from 'bun:test'

import { blockerKey, type ChainResult } from '@/shared/chainTrace'
import type { ProgressProposalNode, ProgressTask } from '@/shared/schemas'
import {
  arcKeyFromNodeId,
  buildClusterStyleFromVars,
  buildTopology,
  CLUSTER_CSS,
  computeEmphasisMap,
  dataSignature,
  dominant,
  FANOUT_BUNDLE_THRESHOLD,
  rollupByProposal,
  type FanoutBundleNodeData,
  type Rollup,
  structuralSignature,
} from './topologyFlowModel'

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
  const full = { Queued: 0, 'In progress': 0, Blocked: 0, Failed: 0, Done: 0, ...counts }
  return { total: full.Queued + full['In progress'] + full.Blocked + full.Failed, counts: full }
}

describe('rollupByProposal', () => {
  it('tallies each proposal’s tasks by cluster', () => {
    const tasks = [
      task({ id: 't1', cluster: 'Queued', parentProposalId: 'p1' }),
      task({ id: 't2', cluster: 'Failed', parentProposalId: 'p1' }),
      task({ id: 't3', cluster: 'Queued', parentProposalId: 'p2' }),
    ]
    const r = rollupByProposal(tasks, [proposal('p1'), proposal('p2')])
    expect(r.get('p1')!.total).toBe(2)
    expect(r.get('p1')!.counts.Failed).toBe(1)
    expect(r.get('p2')!.total).toBe(1)
  })

  it('ignores tasks whose parent proposal is not in scope', () => {
    const r = rollupByProposal([task({ id: 't1', cluster: 'Queued', parentProposalId: 'ghost' })], [proposal('p1')])
    expect(r.get('p1')!.total).toBe(0)
    expect(r.has('ghost')).toBe(false)
  })

  it('records an entry for every proposal even with zero tasks', () => {
    const r = rollupByProposal([], [proposal('p1')])
    expect(r.get('p1')!.total).toBe(0)
  })
})

describe('dominant', () => {
  it('picks the plurality cluster, not "any failure"', () => {
    expect(dominant(rollup({ Queued: 10, Failed: 1 }))).toBe('Queued')
  })

  it('breaks ties by severity Failed > In progress > Blocked > Queued', () => {
    expect(dominant(rollup({ Queued: 2, Failed: 2 }))).toBe('Failed')
    expect(dominant(rollup({ Blocked: 3, 'In progress': 3 }))).toBe('In progress')
  })

  it('falls back to Queued for an empty rollup', () => {
    expect(dominant(rollup({}))).toBe('Queued')
  })

  it('returns the sole non-zero cluster', () => {
    expect(dominant(rollup({ Blocked: 4 }))).toBe('Blocked')
  })
})

describe('CLUSTER_CSS', () => {
  it('has a defined var() entry for every Cluster value including Done', () => {
    const keys = Object.keys(CLUSTER_CSS)
    expect(keys.sort()).toEqual(['Blocked', 'Done', 'Failed', 'In progress', 'Queued'])
    for (const style of Object.values(CLUSTER_CSS)) {
      expect(style.fill).toBeDefined()
      expect(style.fill.startsWith('var(--color-dag-')).toBe(true)
      expect(style.stroke.startsWith('var(--color-dag-')).toBe(true)
    }
  })
})

describe('buildClusterStyleFromVars', () => {
  const stub = (name: string): string => ` ${name}-resolved `

  it('resolves to a non-empty color for every cluster key including Done', () => {
    const styles = buildClusterStyleFromVars(stub)
    const keys = Object.keys(styles)
    expect(keys.sort()).toEqual(['Blocked', 'Done', 'Failed', 'In progress', 'Queued'])
    for (const style of Object.values(styles)) {
      expect(style.fill.length).toBeGreaterThan(0)
      expect(style.fill.endsWith('-resolved')).toBe(true)
    }
  })

  it('derives dot from stroke', () => {
    const styles = buildClusterStyleFromVars(stub)
    for (const style of Object.values(styles)) expect(style.dot).toBe(style.stroke)
  })
})

describe('arcKeyFromNodeId', () => {
  it('strips the arc: prefix', () => {
    expect(arcKeyFromNodeId('arc:p1')).toBe('p1')
  })

  it('leaves a bare id untouched', () => {
    expect(arcKeyFromNodeId('t1')).toBe('t1')
  })
})

describe('buildTopology', () => {
  it('emits one collapsed card per multi-task proposal arc with dominant status and count', () => {
    const tasks = [
      task({ id: 't1', cluster: 'Failed', parentProposalId: 'p1' }),
      task({ id: 't2', cluster: 'Failed', parentProposalId: 'p1' }),
      task({ id: 't3', cluster: 'Queued', parentProposalId: 'p1' }),
    ]
    const { nodes } = buildTopology(tasks, [proposal('p1', 'Ship it')], null)
    const card = nodes.find((n) => n.type === 'arcCard')!
    expect(card.id).toBe('arc:p1')
    expect(card.data.label).toBe('Ship it')
    expect(card.data).toMatchObject({ count: 3, dom: 'Failed', isProposal: true })
    // Member tasks are hidden while the arc is collapsed.
    expect(nodes.filter((n) => n.type === 'task')).toHaveLength(0)
  })

  it('renders every single-task arc as a bare task node — no task silently dropped', () => {
    const tasks = [
      task({ id: 't1', cluster: 'Queued' }),
      task({ id: 't2', cluster: 'In progress' }),
    ]
    const { nodes } = buildTopology(tasks, [], null)
    expect(nodes.map((n) => n.id).sort()).toEqual(['t1', 't2'])
    expect(nodes.every((n) => n.type === 'task')).toBe(true)
  })

  it('groups tasks sharing the same originId into one arc card', () => {
    const tasks = [
      task({ id: 'o1', cluster: 'Failed', prompt: 'origin work' }),
      task({ id: 'f1', cluster: 'Queued', originId: 'o1', fixForTaskId: 'o1' }),
    ]
    const { nodes } = buildTopology(tasks, [], null)
    const card = nodes.find((n) => n.type === 'arcCard')!
    expect(card.id).toBe('arc:o1')
    expect(card.data.label).toBe('origin work')
    expect(card.data.isProposal).toBe(false)
  })

  it('expands the open arc into a group node with parentId/extent children', () => {
    const tasks = [
      task({ id: 't1', cluster: 'Queued', parentProposalId: 'p1' }),
      task({ id: 't2', cluster: 'Queued', parentProposalId: 'p1', blockedBy: ['t1'] }),
    ]
    const { nodes } = buildTopology(tasks, [proposal('p1')], 'p1')
    const group = nodes.find((n) => n.type === 'arcGroup')!
    expect(group.id).toBe('arc:p1')
    const kids = nodes.filter((n) => n.type === 'task')
    expect(kids).toHaveLength(2)
    for (const kid of kids) {
      expect(kid.parentId).toBe('arc:p1')
      expect(kid.extent).toBe('parent')
    }
    // dagre LR: blocker t1 sits left of its dependent t2
    const t1 = kids.find((n) => n.id === 't1')!
    const t2 = kids.find((n) => n.id === 't2')!
    expect(t1.position.x).toBeLessThan(t2.position.x)
  })

  it('keys blocker edges with blockerKey so the highlight map can match', () => {
    const tasks = [
      task({ id: 't1', cluster: 'Queued' }),
      task({ id: 't2', cluster: 'Queued', blockedBy: ['t1'] }),
    ]
    const { edges } = buildTopology(tasks, [], null)
    expect(edges).toHaveLength(1)
    expect(edges[0]!.data!.keys).toEqual([blockerKey('t1', 't2')])
    expect(edges[0]!.data!.kind).toBe('blocker')
  })

  it('drops blocker edges whose blocker is out of scope', () => {
    const { edges } = buildTopology([task({ id: 't2', cluster: 'Queued', blockedBy: ['ghost'] })], [], null)
    expect(edges).toHaveLength(0)
  })

  it('emits a recovery edge for in-scope fix tasks', () => {
    const tasks = [
      task({ id: 'o1', cluster: 'Failed' }),
      task({ id: 'f1', cluster: 'Queued', fixForTaskId: 'o1' }),
    ]
    const { edges } = buildTopology(tasks, [], null)
    expect(edges).toHaveLength(1)
    expect(edges[0]!.data!.kind).toBe('recovery')
    expect(edges[0]!.source).toBe('o1')
    expect(edges[0]!.target).toBe('f1')
  })

  it('does not emit a recovery edge when the fixForTaskId target is out of scope', () => {
    const { edges } = buildTopology([task({ id: 'f1', cluster: 'Queued', fixForTaskId: 'ghost' })], [], null)
    expect(edges).toHaveLength(0)
  })

  it('lifts a cross-arc blocker edge to the collapsed card and records the original key', () => {
    const tasks = [
      task({ id: 't1', cluster: 'Queued', parentProposalId: 'p1' }),
      task({ id: 't2', cluster: 'Queued', parentProposalId: 'p1' }),
      task({ id: 'solo', cluster: 'Queued', blockedBy: ['t1'] }),
    ]
    const { edges } = buildTopology(tasks, [proposal('p1')], null)
    expect(edges).toHaveLength(1)
    expect(edges[0]!.source).toBe('arc:p1')
    expect(edges[0]!.target).toBe('solo')
    expect(edges[0]!.data!.keys).toEqual([blockerKey('t1', 'solo')])
  })

  it('omits edges fully inside a collapsed arc and dedupes lifted parallels', () => {
    const tasks = [
      task({ id: 't1', cluster: 'Queued', parentProposalId: 'p1' }),
      task({ id: 't2', cluster: 'Queued', parentProposalId: 'p1', blockedBy: ['t1'] }),
      task({ id: 'a', cluster: 'Queued', blockedBy: ['t1'] }),
      task({ id: 'b', cluster: 'Queued', blockedBy: ['t2'], parentProposalId: null }),
    ]
    const { edges } = buildTopology(tasks, [proposal('p1')], null)
    // t1->t2 hidden; arc:p1->a and arc:p1->b are distinct targets, both kept.
    expect(edges.map((e) => `${e.source}->${e.target}`).sort()).toEqual(['arc:p1->a', 'arc:p1->b'])
  })

  it('produces deterministic positions for identical input', () => {
    const tasks = [
      task({ id: 't1', cluster: 'Queued' }),
      task({ id: 't2', cluster: 'Queued', blockedBy: ['t1'] }),
      task({ id: 'x1', cluster: 'Failed', parentProposalId: 'p1' }),
      task({ id: 'x2', cluster: 'Queued', parentProposalId: 'p1' }),
    ]
    const props = [proposal('p1')]
    const a = buildTopology(tasks, props, null)
    const b = buildTopology(tasks, props, null)
    expect(a.nodes.map((n) => ({ id: n.id, ...n.position }))).toEqual(
      b.nodes.map((n) => ({ id: n.id, ...n.position })),
    )
  })
})

// ---------------------------------------------------------------------------
// Done-task filtering tests
// ---------------------------------------------------------------------------

describe('buildTopology — Done task filtering', () => {
  it('never emits a task node with cluster Done — Done task in a mixed arc is hidden', () => {
    const tasks = [
      task({ id: 'origin', cluster: 'Done', prompt: 'origin work' }),
      task({ id: 'active', cluster: 'Queued', originId: 'origin', fixForTaskId: 'origin' }),
    ]
    const { nodes } = buildTopology(tasks, [], null)
    const taskNodes = nodes.filter((n) => n.type === 'task')
    expect(taskNodes.every((n) => n.data.cluster !== 'Done')).toBe(true)
  })

  it('emits no nodes or edges for an arc whose all members are Done', () => {
    const tasks = [
      task({ id: 'o1', cluster: 'Done' }),
      task({ id: 'f1', cluster: 'Done', originId: 'o1', fixForTaskId: 'o1' }),
    ]
    const { nodes, edges } = buildTopology(tasks, [], null)
    expect(nodes).toHaveLength(0)
    expect(edges).toHaveLength(0)
  })

  it('renders an arc with 1 active + several Done members as a bare task node, not an arcCard', () => {
    const tasks = [
      task({ id: 'origin', cluster: 'Done', prompt: 'origin work' }),
      task({ id: 'fix1', cluster: 'Done', originId: 'origin' }),
      task({ id: 'fix2', cluster: 'Queued', originId: 'origin' }),
    ]
    const { nodes } = buildTopology(tasks, [], null)
    expect(nodes.find((n) => n.type === 'arcCard')).toBeUndefined()
    const taskNode = nodes.find((n) => n.type === 'task')
    expect(taskNode).toBeDefined()
    expect(taskNode!.id).toBe('fix2')
  })

  it('a Done origin still supplies the arc label — 8f2a5a12 regression stays fixed', () => {
    const tasks = [
      task({ id: 'origin', cluster: 'Done', prompt: 'do the important thing' }),
      task({ id: 'child1', cluster: 'Queued', originId: 'origin' }),
      task({ id: 'child2', cluster: 'In progress', originId: 'origin' }),
    ]
    const { nodes } = buildTopology(tasks, [], null)
    const card = nodes.find((n) => n.type === 'arcCard')!
    expect(card).toBeDefined()
    expect(card.data.label).toBe('do the important thing')
  })

  it('does not emit an edge whose endpoint is a Done task', () => {
    const tasks = [
      task({ id: 'done1', cluster: 'Done' }),
      task({ id: 'active', cluster: 'Queued', blockedBy: ['done1'] }),
    ]
    const { edges } = buildTopology(tasks, [], null)
    expect(edges).toHaveLength(0)
  })

  it('active card count reflects only active members, not Done members', () => {
    const tasks = [
      task({ id: 'origin', cluster: 'Done', prompt: 'origin' }),
      task({ id: 'done1', cluster: 'Done', originId: 'origin' }),
      task({ id: 'active1', cluster: 'Queued', originId: 'origin' }),
      task({ id: 'active2', cluster: 'In progress', originId: 'origin' }),
    ]
    const { nodes } = buildTopology(tasks, [], null)
    const card = nodes.find((n) => n.type === 'arcCard')!
    expect(card).toBeDefined()
    expect(card.data.count).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Fan-out bundle tests
// ---------------------------------------------------------------------------

describe('fanout bundling', () => {
  const hub = () => task({ id: 'h1', cluster: 'Failed' })
  const makeLeaves = (n: number, blockedBy = ['h1']) =>
    Array.from({ length: n }, (_, i) => task({ id: `l${i + 1}`, cluster: 'Queued', blockedBy }))

  it(`bundles leaf neighbours over FANOUT_BUNDLE_THRESHOLD (${FANOUT_BUNDLE_THRESHOLD}) into one fanoutBundle node with correct count`, () => {
    const leaves = makeLeaves(FANOUT_BUNDLE_THRESHOLD + 1)
    const { nodes, edges } = buildTopology([hub(), ...leaves], [], null)

    const bundle = nodes.find((n) => n.data.kind === 'fanoutBundle')
    expect(bundle).toBeDefined()
    expect((bundle!.data as FanoutBundleNodeData).count).toBe(FANOUT_BUNDLE_THRESHOLD + 1)
    expect((bundle!.data as FanoutBundleNodeData).memberIds).toHaveLength(FANOUT_BUNDLE_THRESHOLD + 1)

    // Individual leaf nodes must be absent
    const leafNodes = nodes.filter((n) => n.data.kind === 'task' && n.id !== 'h1')
    expect(leafNodes).toHaveLength(0)

    // Exactly one hub→bundle edge
    expect(edges).toHaveLength(1)
    expect(edges[0]!.source).toBe('h1')
    expect(edges[0]!.target).toBe(bundle!.id)
  })

  it('does NOT bundle when leaf count is at or below the threshold', () => {
    const leaves = makeLeaves(FANOUT_BUNDLE_THRESHOLD)
    const { nodes } = buildTopology([hub(), ...leaves], [], null)
    expect(nodes.find((n) => n.data.kind === 'fanoutBundle')).toBeUndefined()
    // All tasks (hub + leaves) rendered individually
    expect(nodes.filter((n) => n.data.kind === 'task')).toHaveLength(FANOUT_BUNDLE_THRESHOLD + 1)
  })

  it('excludes a non-pure-leaf neighbour (degree > 1) from bundling even when hub is over threshold', () => {
    // We need FANOUT_BUNDLE_THRESHOLD + 2 leaves so that even after l1 gains
    // degree 2 (because 'extra' is also blocked by l1), the remaining
    // FANOUT_BUNDLE_THRESHOLD + 1 pure leaves still exceed the threshold.
    const leaves = makeLeaves(FANOUT_BUNDLE_THRESHOLD + 2)
    // l1 now has two edges: h1→l1 and l1→extra, so its degree = 2 (not a pure leaf).
    const l1 = leaves[0]!
    // 'extra' is blocked by h1 AND l1 → degree-2 node, not a pure leaf.
    const extra = task({ id: 'extra', cluster: 'Queued', blockedBy: ['h1', l1.id] })
    const { nodes } = buildTopology([hub(), ...leaves, extra], [], null)

    // A bundle should still form (hub still has FANOUT_BUNDLE_THRESHOLD + 1 pure leaves)
    const bundle = nodes.find((n) => n.data.kind === 'fanoutBundle')
    expect(bundle).toBeDefined()
    // 'extra' is rendered individually — it was not bundled
    expect(nodes.find((n) => n.id === 'extra')).toBeDefined()
    // l1 is rendered individually — it was not bundled (degree 2)
    expect(nodes.find((n) => n.id === 'l1')).toBeDefined()
    // Neither 'extra' nor 'l1' appear in memberIds
    expect((bundle!.data as FanoutBundleNodeData).memberIds).not.toContain('extra')
    expect((bundle!.data as FanoutBundleNodeData).memberIds).not.toContain('l1')
  })

  it('emits individual leaf nodes + edges when bundleKey is in expandedBundles', () => {
    const leaves = makeLeaves(FANOUT_BUNDLE_THRESHOLD + 1)
    // First: collapsed
    const { nodes: collapsed } = buildTopology([hub(), ...leaves], [], null)
    const bundle = collapsed.find((n) => n.data.kind === 'fanoutBundle')!
    const bundleKey = (bundle.data as FanoutBundleNodeData).bundleKey

    // Now: expanded
    const { nodes: expanded, edges: expandedEdges } = buildTopology(
      [hub(), ...leaves],
      [],
      null,
      new Set([bundleKey]),
    )
    expect(expanded.find((n) => n.data.kind === 'fanoutBundle')).toBeUndefined()
    // All leaf task nodes are visible
    expect(expanded.filter((n) => n.id.startsWith('l'))).toHaveLength(FANOUT_BUNDLE_THRESHOLD + 1)
    // Individual hub→leaf edges are restored
    expect(expandedEdges).toHaveLength(FANOUT_BUNDLE_THRESHOLD + 1)
  })

  it('keeps in-direction and out-direction bundles separate with correct edge orientation', () => {
    // Blockers arrive INTO hub (direction 'in'); dependents flow OUT from hub (direction 'out').
    const N = FANOUT_BUNDLE_THRESHOLD + 1
    const blockers = Array.from({ length: N }, (_, i) => task({ id: `b${i + 1}`, cluster: 'Queued' }))
    const dependents = Array.from({ length: N }, (_, i) =>
      task({ id: `d${i + 1}`, cluster: 'Queued', blockedBy: ['h1'] }),
    )
    const hubWithBlockers = task({ id: 'h1', cluster: 'In progress', blockedBy: blockers.map((b) => b.id) })

    const { nodes, edges } = buildTopology([...blockers, hubWithBlockers, ...dependents], [], null)

    const bundles = nodes.filter((n) => n.data.kind === 'fanoutBundle') as typeof nodes & {
      data: FanoutBundleNodeData
    }[]
    expect(bundles).toHaveLength(2)

    const inBundle = bundles.find((n) => (n.data as FanoutBundleNodeData).direction === 'in')
    const outBundle = bundles.find((n) => (n.data as FanoutBundleNodeData).direction === 'out')
    expect(inBundle).toBeDefined()
    expect(outBundle).toBeDefined()
    expect((inBundle!.data as FanoutBundleNodeData).count).toBe(N)
    expect((outBundle!.data as FanoutBundleNodeData).count).toBe(N)

    // 'in' bundle: blockers flow into hub → bundle→hub edge
    const inEdge = edges.find((e) => e.target === 'h1')
    expect(inEdge).toBeDefined()
    expect(inEdge!.source).toBe(inBundle!.id)

    // 'out' bundle: hub flows out to dependents → hub→bundle edge
    const outEdge = edges.find((e) => e.source === 'h1')
    expect(outEdge).toBeDefined()
    expect(outEdge!.target).toBe(outBundle!.id)
  })

  it('produces deterministic positions for identical input containing a bundle', () => {
    const leaves = makeLeaves(FANOUT_BUNDLE_THRESHOLD + 1)
    const a = buildTopology([hub(), ...leaves], [], null)
    const b = buildTopology([hub(), ...leaves], [], null)
    expect(a.nodes.map((n) => ({ id: n.id, ...n.position }))).toEqual(
      b.nodes.map((n) => ({ id: n.id, ...n.position })),
    )
  })
})

describe('computeEmphasisMap', () => {
  const tasks = [
    task({ id: 't1', cluster: 'Queued' }),
    task({ id: 't2', cluster: 'Queued', blockedBy: ['t1'] }),
    task({ id: 'x1', cluster: 'Queued', parentProposalId: 'p1' }),
    task({ id: 'x2', cluster: 'Queued', parentProposalId: 'p1' }),
  ]
  const graph = buildTopology(tasks, [proposal('p1')], null)
  const edgeId = graph.edges[0]!.id

  const lit = (over: Partial<ChainResult>): ChainResult => ({
    nodes: new Set(),
    edges: new Set(),
    proposals: new Set(),
    ...over,
  })

  it('leaves everything at rest with no filters and no hover', () => {
    const map = computeEmphasisMap(graph.nodes, graph.edges, { searchMatchIds: null, lit: null })
    for (const v of map.values()) expect(v).toBe('rest')
  })

  it('dims nodes outside the search set', () => {
    const map = computeEmphasisMap(graph.nodes, graph.edges, { searchMatchIds: new Set(['t1']), lit: null })
    expect(map.get('t1')).toBe('rest')
    expect(map.get('t2')).toBe('dim')
    expect(map.get('arc:p1')).toBe('dim')
  })

  it('dims an edge when either endpoint is filtered out', () => {
    const map = computeEmphasisMap(graph.nodes, graph.edges, { searchMatchIds: new Set(['t1']), lit: null })
    expect(map.get(edgeId)).toBe('dim')
  })

  it('with a hover trace, lights the lit set and dims everything else', () => {
    const map = computeEmphasisMap(graph.nodes, graph.edges, {
      searchMatchIds: null,
      lit: lit({ nodes: new Set(['t1', 't2']), edges: new Set([blockerKey('t1', 't2')]) }),
    })
    expect(map.get('t1')).toBe('lit')
    expect(map.get('t2')).toBe('lit')
    expect(map.get(edgeId)).toBe('lit')
    expect(map.get('arc:p1')).toBe('dim')
  })

  it('lights an arc card when its arc key is in the lit proposals set', () => {
    const map = computeEmphasisMap(graph.nodes, graph.edges, {
      searchMatchIds: null,
      lit: lit({ proposals: new Set(['p1']) }),
    })
    expect(map.get('arc:p1')).toBe('lit')
    expect(map.get('t1')).toBe('dim')
  })

  it('filters still suppress a hover-lit element (search wins over lit)', () => {
    const map = computeEmphasisMap(graph.nodes, graph.edges, {
      searchMatchIds: new Set(['t2']),
      lit: lit({ nodes: new Set(['t1', 't2']) }),
    })
    expect(map.get('t1')).toBe('dim')
    expect(map.get('t2')).toBe('lit')
  })
})

describe('dataSignature', () => {
  const base = [task({ id: 't1', cluster: 'Queued' })]

  it('is stable for identical inputs', () => {
    expect(dataSignature(base, [])).toBe(dataSignature([task({ id: 't1', cluster: 'Queued' })], []))
  })

  it('changes when a task cluster changes', () => {
    expect(dataSignature(base, [])).not.toBe(dataSignature([task({ id: 't1', cluster: 'Failed' })], []))
  })

  it('changes when a blocker edge is added', () => {
    expect(dataSignature(base, [])).not.toBe(
      dataSignature([task({ id: 't1', cluster: 'Queued', blockedBy: ['x'] })], []),
    )
  })

  it('changes when a proposal title changes', () => {
    expect(dataSignature(base, [proposal('p1', 'a')])).not.toBe(dataSignature(base, [proposal('p1', 'b')]))
  })
})

describe('structuralSignature', () => {
  const base = [task({ id: 't1', cluster: 'Queued' })]

  it('is stable for identical inputs', () => {
    expect(structuralSignature(base, [])).toBe(
      structuralSignature([task({ id: 't1', cluster: 'Queued' })], []),
    )
  })

  it('does NOT change when a task cluster changes between non-Done statuses — colour-only update', () => {
    // Queued/Blocked/Failed/In-progress transitions are visual only: the node
    // stays on the canvas at the same position. Re-fitting would yank the
    // viewport unnecessarily, so the signature must be stable here.
    expect(structuralSignature(base, [])).toBe(
      structuralSignature([task({ id: 't1', cluster: 'Failed' })], []),
    )
  })

  it('DOES change when a task transitions to Done — Done removes the node from the graph', () => {
    // buildTopology excludes Done tasks from the rendered graph. The signature
    // must capture this so fitKey changes and fitView is triggered to
    // re-centre the (now smaller) canvas.
    expect(structuralSignature(base, [])).not.toBe(
      structuralSignature([task({ id: 't1', cluster: 'Done' })], []),
    )
  })

  it('changes when a blocker edge is added', () => {
    expect(structuralSignature(base, [])).not.toBe(
      structuralSignature([task({ id: 't1', cluster: 'Queued', blockedBy: ['x'] })], []),
    )
  })

  it('changes when fixForTaskId is set (recovery relationship appears)', () => {
    expect(structuralSignature(base, [])).not.toBe(
      structuralSignature([task({ id: 't1', cluster: 'Queued', fixForTaskId: 'o' })], []),
    )
  })
})
