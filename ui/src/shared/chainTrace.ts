/**
 * Hover-chain computation for the Topology graph — the load-bearing "Focus
 * subgraph" mechanic, isolated so it can be unit-tested and lifted near
 * focusSubgraph.ts.
 *
 * Given the full task graph and a hovered entity (a task id OR a proposal id),
 * return the set of node ids + edge keys + proposal ids that should stay LIT.
 * Everything else gets dimmed/ghosted by the renderer.
 *
 * Spec (confirmed with the user — load-bearing, do not change):
 *   - Hover a TASK -> light its FULL lineage: upstream along blocker edges to
 *     every root AND downstream along blocker edges to every leaf (all paths,
 *     both directions; cross-proposal blocker edges are followed freely).
 *     Then attach the originating proposal (`parentProposalId`) of EVERY lit
 *     task as a provenance hop (`provKey(parentProposalId, taskId)` + the id).
 *   - Hover a PROPOSAL (combo) -> light every task it sliced
 *     (`parentProposalId === proposalId`) plus their full downstream reach
 *     (all paths, cross-proposal). Mark EVERY reached proposal so combos light,
 *     not just the hovered one. Add `provKey(proposalId, taskId)` for the
 *     directly-sliced tasks.
 *   - A non-pending task mid-chain stays lit; cluster only decides where the
 *     *tip* is for `deepestPendingLeaf`, never chain membership.
 *
 * The functions are pure and side-effect-free.
 */

import type { ProgressTask } from '@/shared/schemas'

/** Clusters that count as "still pending" when locating the deepest leaf. */
const PENDING: ReadonlySet<ProgressTask['cluster']> = new Set<ProgressTask['cluster']>(['Queued', 'Blocked'])

/** The structurally-minimal task shape this module needs. */
type ChainTask = Pick<ProgressTask, 'id' | 'cluster' | 'blockedBy' | 'parentProposalId'>

export interface ChainGraph {
  tasks: ReadonlyArray<ChainTask>
}

export interface ChainResult {
  /** Task ids to keep lit. */
  nodes: Set<string>
  /** Edge keys (blocker + provenance) to keep lit. */
  edges: Set<string>
  /** Proposal ids to keep lit. */
  proposals: Set<string>
}

interface ChainIndex {
  byId: Map<string, ChainTask>
  /** task id -> ids it is blockedBy (upstream parents). */
  blockers: Map<string, string[]>
  /** task id -> ids that are blockedBy it (downstream dependents). */
  dependents: Map<string, string[]>
}

export const blockerKey = (from: string, to: string): string => `b:${from}->${to}`
export const provKey = (from: string, to: string): string => `p:${from}->${to}`

const buildIndex = (tasks: ReadonlyArray<ChainTask>): ChainIndex => {
  const byId = new Map<string, ChainTask>(tasks.map((t) => [t.id, t]))
  const blockers = new Map<string, string[]>()
  const dependents = new Map<string, string[]>()
  for (const t of tasks) {
    const blockedBy = t.blockedBy ?? []
    blockers.set(t.id, [...blockedBy])
    for (const b of blockedBy) {
      const existing = dependents.get(b)
      if (existing) existing.push(t.id)
      else dependents.set(b, [t.id])
    }
  }
  return { byId, blockers, dependents }
}

/**
 * Walk every downstream path from `startIds` along blocker edges, lighting all
 * nodes and edges encountered (all paths, follows cross-proposal freely).
 */
const lightDownstream = (
  idx: ChainIndex,
  startIds: ReadonlyArray<string>,
  nodes: Set<string>,
  edges: Set<string>,
): void => {
  const stack: string[] = [...startIds]
  const seen = new Set<string>(startIds)
  while (stack.length > 0) {
    const cur = stack.pop() as string
    nodes.add(cur)
    for (const dep of idx.dependents.get(cur) ?? []) {
      edges.add(blockerKey(cur, dep))
      nodes.add(dep)
      if (!seen.has(dep)) {
        seen.add(dep)
        stack.push(dep)
      }
    }
  }
}

/** Walk every upstream path from `startId` along blocker edges back to the roots. */
const lightUpstream = (idx: ChainIndex, startId: string, nodes: Set<string>, edges: Set<string>): void => {
  const stack: string[] = [startId]
  const seen = new Set<string>([startId])
  while (stack.length > 0) {
    const cur = stack.pop() as string
    nodes.add(cur)
    for (const up of idx.blockers.get(cur) ?? []) {
      edges.add(blockerKey(up, cur))
      nodes.add(up)
      if (!seen.has(up)) {
        seen.add(up)
        stack.push(up)
      }
    }
  }
}

/** Attach the originating proposal of `taskId` (if any) as a provenance hop. */
const attachProvenance = (idx: ChainIndex, taskId: string, edges: Set<string>, proposals: Set<string>): void => {
  const t = idx.byId.get(taskId)
  if (t?.parentProposalId) {
    proposals.add(t.parentProposalId)
    edges.add(provKey(t.parentProposalId, taskId))
  }
}

/**
 * Hover a TASK: light its full lineage (upstream to roots + downstream to
 * leaves, all paths, cross-proposal), then attach the originating proposal of
 * every lit task as a provenance hop.
 */
export const chainForTask = (graph: ChainGraph, taskId: string): ChainResult => {
  const idx = buildIndex(graph.tasks)
  const nodes = new Set<string>()
  const edges = new Set<string>()
  const proposals = new Set<string>()

  lightUpstream(idx, taskId, nodes, edges)
  lightDownstream(idx, [taskId], nodes, edges)

  for (const id of [...nodes]) attachProvenance(idx, id, edges, proposals)

  return { nodes, edges, proposals }
}

/**
 * Hover a PROPOSAL (combo): light every task it sliced plus their full
 * downstream reach (all paths, cross-proposal), and mark every reached
 * proposal so its combo lights too — not just the hovered one.
 */
export const chainForProposal = (graph: ChainGraph, proposalId: string): ChainResult => {
  const idx = buildIndex(graph.tasks)
  const nodes = new Set<string>()
  const edges = new Set<string>()
  const proposals = new Set<string>([proposalId])

  const sliced = graph.tasks.filter((t) => t.parentProposalId === proposalId)
  for (const t of sliced) {
    edges.add(provKey(proposalId, t.id))
    nodes.add(t.id)
  }

  lightDownstream(idx, sliced.map((t) => t.id), nodes, edges)

  for (const id of nodes) {
    const t = idx.byId.get(id)
    if (t?.parentProposalId) proposals.add(t.parentProposalId)
  }

  return { nodes, edges, proposals }
}

/**
 * Locate the "deepest pending leaf" reachable downstream from `taskId`: the
 * task at max depth that is Queued/Blocked AND has no dependents. Used only for
 * a readout label, not for bounding the highlight. Returns null if none.
 */
export const deepestPendingLeaf = (graph: ChainGraph, taskId: string): string | null => {
  const idx = buildIndex(graph.tasks)
  let best: string | null = null
  let bestDepth = -1
  const stack: Array<[string, number]> = [[taskId, 0]]
  const seen = new Set<string>([taskId])
  while (stack.length > 0) {
    const [cur, depth] = stack.pop() as [string, number]
    const t = idx.byId.get(cur)
    const deps = idx.dependents.get(cur) ?? []
    if (t && PENDING.has(t.cluster) && deps.length === 0 && depth > bestDepth) {
      best = cur
      bestDepth = depth
    }
    for (const dep of deps) {
      if (!seen.has(dep)) {
        seen.add(dep)
        stack.push([dep, depth + 1])
      }
    }
  }
  return best
}
