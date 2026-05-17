import { describe, expect, it } from 'bun:test'

import { focusSubgraph, type Graph } from './focusSubgraph.ts'

const task = (id: string): { id: string; kind: 'task' } => ({ id, kind: 'task' })
const idea = (id: string): { id: string; kind: 'idea' } => ({ id, kind: 'idea' })
const blocker = (from: string, to: string) => ({ from, to, kind: 'blocker' as const })
const provenance = (from: string, to: string) => ({ from, to, kind: 'provenance' as const })

describe('focusSubgraph', () => {
  it('returns the full graph unchanged when no node is focused', () => {
    const g: Graph = {
      nodes: [task('a'), task('b')],
      edges: [blocker('a', 'b')],
    }
    expect(focusSubgraph(g, null)).toEqual(g)
    expect(focusSubgraph(g, undefined)).toEqual(g)
    expect(focusSubgraph(g, '')).toEqual(g)
  })

  it('returns the full graph unchanged when the focus id is not present', () => {
    const g: Graph = {
      nodes: [task('a'), task('b')],
      edges: [blocker('a', 'b')],
    }
    expect(focusSubgraph(g, 'missing')).toEqual(g)
  })

  it('keeps the focused task even when it has no neighbours', () => {
    const g: Graph = { nodes: [task('a')], edges: [] }
    expect(focusSubgraph(g, 'a')).toEqual({ nodes: [task('a')], edges: [] })
  })

  it('includes the full upstream blocker chain back to the roots', () => {
    // root -> mid -> focus
    const g: Graph = {
      nodes: [task('root'), task('mid'), task('focus'), task('unrelated')],
      edges: [
        blocker('root', 'mid'),
        blocker('mid', 'focus'),
        blocker('unrelated', 'unrelated-sink'),
      ],
    }
    const sub = focusSubgraph(g, 'focus')
    const ids = sub.nodes.map((n) => n.id).sort()
    expect(ids).toEqual(['focus', 'mid', 'root'])
    expect(sub.edges).toEqual(
      expect.arrayContaining([blocker('root', 'mid'), blocker('mid', 'focus')]),
    )
    expect(sub.edges).toHaveLength(2)
  })

  it('includes exactly one downstream hop and no further', () => {
    // focus -> child -> grandchild
    const g: Graph = {
      nodes: [task('focus'), task('child'), task('grandchild')],
      edges: [blocker('focus', 'child'), blocker('child', 'grandchild')],
    }
    const sub = focusSubgraph(g, 'focus')
    const ids = sub.nodes.map((n) => n.id).sort()
    expect(ids).toEqual(['child', 'focus'])
    expect(sub.edges).toEqual([blocker('focus', 'child')])
  })

  it('attaches the originating Idea as a fixed provenance hop', () => {
    const g: Graph = {
      nodes: [idea('i1'), idea('i2'), task('focus')],
      edges: [provenance('i1', 'focus'), provenance('i2', 'other-task')],
    }
    const sub = focusSubgraph(g, 'focus')
    const ids = sub.nodes.map((n) => n.id).sort()
    expect(ids).toEqual(['focus', 'i1'])
    expect(sub.edges).toEqual([provenance('i1', 'focus')])
  })

  it('does not pull in idea-side neighbours beyond the originating Idea', () => {
    // i1 spawns focus AND other; the slice should NOT include `other`
    const g: Graph = {
      nodes: [idea('i1'), task('focus'), task('other')],
      edges: [provenance('i1', 'focus'), provenance('i1', 'other')],
    }
    const sub = focusSubgraph(g, 'focus')
    const ids = sub.nodes.map((n) => n.id).sort()
    expect(ids).toEqual(['focus', 'i1'])
    expect(sub.edges).toEqual([provenance('i1', 'focus')])
  })

  it('does not walk further upstream through the Idea provenance hop', () => {
    // upstreamBlocker -> idea -> focus would be wrong; idea is a fixed hop only
    const g: Graph = {
      nodes: [task('upstream'), idea('i1'), task('focus')],
      edges: [blocker('upstream', 'i1' as string), provenance('i1', 'focus')],
    }
    const sub = focusSubgraph(g, 'focus')
    const ids = sub.nodes.map((n) => n.id).sort()
    expect(ids).toEqual(['focus', 'i1'])
  })

  it('combines upstream chain, one downstream hop, and provenance in one slice', () => {
    const g: Graph = {
      nodes: [
        idea('i1'),
        task('root'),
        task('mid'),
        task('focus'),
        task('child'),
        task('grandchild'),
        task('sibling'),
      ],
      edges: [
        blocker('root', 'mid'),
        blocker('mid', 'focus'),
        blocker('focus', 'child'),
        blocker('child', 'grandchild'),
        provenance('i1', 'focus'),
        blocker('sibling', 'mid'),
      ],
    }
    const sub = focusSubgraph(g, 'focus')
    const ids = sub.nodes.map((n) => n.id).sort()
    // upstream: root, mid, sibling (sibling also blocks mid -> on the upstream chain)
    // downstream 1 hop: child (NOT grandchild)
    // provenance: i1
    expect(ids).toEqual(['child', 'focus', 'i1', 'mid', 'root', 'sibling'])
    expect(sub.edges).toEqual(
      expect.arrayContaining([
        blocker('root', 'mid'),
        blocker('mid', 'focus'),
        blocker('focus', 'child'),
        blocker('sibling', 'mid'),
        provenance('i1', 'focus'),
      ]),
    )
    expect(sub.edges).toHaveLength(5)
  })

  it('handles diamond upstream shapes without duplicating nodes or edges', () => {
    //   root
    //   /  \
    //  a    b
    //   \  /
    //   focus
    const g: Graph = {
      nodes: [task('root'), task('a'), task('b'), task('focus')],
      edges: [
        blocker('root', 'a'),
        blocker('root', 'b'),
        blocker('a', 'focus'),
        blocker('b', 'focus'),
      ],
    }
    const sub = focusSubgraph(g, 'focus')
    const ids = sub.nodes.map((n) => n.id).sort()
    expect(ids).toEqual(['a', 'b', 'focus', 'root'])
    expect(sub.edges).toHaveLength(4)
    // every edge unique
    const seen = new Set<string>()
    for (const e of sub.edges) {
      const k = `${e.from}::${e.to}::${e.kind}`
      expect(seen.has(k)).toBe(false)
      seen.add(k)
    }
  })

  it('survives cycles in the upstream chain without looping forever', () => {
    // pathological: a <-> b, both upstream of focus
    const g: Graph = {
      nodes: [task('a'), task('b'), task('focus')],
      edges: [blocker('a', 'b'), blocker('b', 'a'), blocker('b', 'focus')],
    }
    const sub = focusSubgraph(g, 'focus')
    const ids = sub.nodes.map((n) => n.id).sort()
    expect(ids).toEqual(['a', 'b', 'focus'])
  })
})
