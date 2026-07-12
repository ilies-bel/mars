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
  rollupByProposal,
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
  const full = { Queued: 0, 'In progress': 0, Blocked: 0, Failed: 0, ...counts }
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
  it('has a var() entry for every real cluster and no Done', () => {
    const keys = Object.keys(CLUSTER_CSS)
    expect(keys.sort()).toEqual(['Blocked', 'Failed', 'In progress', 'Queued'])
    for (const style of Object.values(CLUSTER_CSS)) {
      expect(style.fill.startsWith('var(--color-dag-')).toBe(true)
      expect(style.stroke.startsWith('var(--color-dag-')).toBe(true)
    }
  })
})

describe('buildClusterStyleFromVars', () => {
  const stub = (name: string): string => ` ${name}-resolved `

  it('resolves to a non-empty color for every cluster key', () => {
    const styles = buildClusterStyleFromVars(stub)
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

  it('does NOT change when a task cluster changes — cluster is a visual-only property', () => {
    expect(structuralSignature(base, [])).toBe(
      structuralSignature([task({ id: 't1', cluster: 'Failed' })], []),
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
