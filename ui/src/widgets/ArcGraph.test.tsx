/**
 * ArcGraph tests.
 *
 * Strategy (mirrors TopologyView.test.tsx):
 *  - The pure `buildArcData` function is tested directly — no G6, no DOM.
 *  - The `ArcGraph` component's empty-guard (returns null → empty HTML) is
 *    tested via renderToStaticMarkup, which never touches the canvas API.
 *  - The inner canvas-mounting path is NOT tested here because it requires
 *    a real DOM/G6 instance.  Behaviour via a real daemon is noted in the
 *    task's manual check.
 *
 * Schema round-trip test: verifies that `dagContextSchema.parse()` accepts
 * the new `edges` field with both `blocks` and `recovers` kinds.
 */
import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { dagContextSchema } from '@/shared/schemas'
import { ArcGraph, buildArcData } from './ArcGraph'
import type { DagContext } from '@/shared/schemas'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const emptyDag: DagContext = {
  blockers: [],
  blocking: [],
  descendants: [],
  proposalId: null,
  edges: [],
}

const dagWithBlocker: DagContext = {
  blockers: [{ id: 'mars-aaa', status: 'failed', summary: 'upstream task' }],
  blocking: [],
  descendants: [],
  proposalId: null,
  edges: [{ from: 'mars-aaa', to: 'mars-center', kind: 'blocks' }],
}

const dagWithRecovery: DagContext = {
  blockers: [],
  blocking: [],
  descendants: [{ id: 'mars-fix', status: 'running', summary: 'recovery task' }],
  proposalId: null,
  edges: [{ from: 'mars-center', to: 'mars-fix', kind: 'recovers' }],
}

const dagFull: DagContext = {
  blockers: [{ id: 'mars-blocker', status: 'done', summary: 'prerequisite' }],
  blocking: [{ id: 'mars-child', status: 'queued', summary: 'downstream' }],
  descendants: [{ id: 'mars-fix', status: 'running', summary: 'recovery' }],
  proposalId: null,
  edges: [
    { from: 'mars-blocker', to: 'mars-center', kind: 'blocks' },
    { from: 'mars-center', to: 'mars-child', kind: 'blocks' },
    { from: 'mars-center', to: 'mars-fix', kind: 'recovers' },
  ],
}

// ---------------------------------------------------------------------------
// Schema round-trip — new `edges` field must parse for both edge kinds
// ---------------------------------------------------------------------------

describe('dagContextSchema – edges field', () => {
  it('parses a dag with blocks and recovers edges', () => {
    const raw = {
      blockers: [{ id: 'a', status: 'failed', summary: 'upstream' }],
      blocking: [],
      descendants: [{ id: 'b', status: 'running', summary: 'fix' }],
      proposalId: null,
      edges: [
        { from: 'a', to: 'entity-1', kind: 'blocks' },
        { from: 'entity-1', to: 'b', kind: 'recovers' },
      ],
    }
    const result = dagContextSchema.parse(raw)
    expect(result.edges).toHaveLength(2)
    expect(result.edges[0]).toEqual({ from: 'a', to: 'entity-1', kind: 'blocks' })
    expect(result.edges[1]).toEqual({ from: 'entity-1', to: 'b', kind: 'recovers' })
  })

  it('rejects an unknown edge kind', () => {
    const raw = {
      blockers: [],
      blocking: [],
      descendants: [],
      proposalId: null,
      edges: [{ from: 'a', to: 'b', kind: 'unknown' }],
    }
    expect(() => dagContextSchema.parse(raw)).toThrow()
  })

  it('parses an empty edges array', () => {
    const result = dagContextSchema.parse(emptyDag)
    expect(result.edges).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// buildArcData — pure model function
// ---------------------------------------------------------------------------

describe('buildArcData – node construction', () => {
  it('includes the central entity node', () => {
    const { nodes } = buildArcData(dagWithBlocker, 'mars-center', 'failed')
    const center = nodes.find((n) => n.id === 'mars-center')
    expect(center).toBeDefined()
    expect(center?.data?.isCenter).toBe(true)
    expect(center?.data?.status).toBe('failed')
  })

  it('marks peripheral nodes as non-center', () => {
    const { nodes } = buildArcData(dagWithBlocker, 'mars-center', 'failed')
    const blocker = nodes.find((n) => n.id === 'mars-aaa')
    expect(blocker).toBeDefined()
    expect(blocker?.data?.isCenter).toBe(false)
  })

  it('includes all peripheral node categories', () => {
    const { nodes } = buildArcData(dagFull, 'mars-center', 'failed')
    const ids = nodes.map((n) => n.id)
    expect(ids).toContain('mars-center')
    expect(ids).toContain('mars-blocker')
    expect(ids).toContain('mars-child')
    expect(ids).toContain('mars-fix')
  })

  it('deduplicates nodes when the same id appears in multiple arrays', () => {
    const dag: DagContext = {
      blockers: [{ id: 'shared', status: 'done', summary: '' }],
      blocking: [{ id: 'shared', status: 'done', summary: '' }],
      descendants: [],
      proposalId: null,
      edges: [],
    }
    const { nodes } = buildArcData(dag, 'mars-center', 'failed')
    const sharedNodes = nodes.filter((n) => n.id === 'shared')
    expect(sharedNodes).toHaveLength(1)
  })

  it('preserves the status from the dag node for peripheral nodes', () => {
    const { nodes } = buildArcData(dagWithBlocker, 'mars-center', 'failed')
    const blocker = nodes.find((n) => n.id === 'mars-aaa')
    expect(blocker?.data?.status).toBe('failed')
  })
})

describe('buildArcData – edge construction', () => {
  it('emits one edge per dag.edges entry', () => {
    const { edges } = buildArcData(dagFull, 'mars-center', 'failed')
    expect(edges).toHaveLength(3)
  })

  it('maps blocks edges from source to target', () => {
    const { edges } = buildArcData(dagWithBlocker, 'mars-center', 'failed')
    const e = edges[0]
    expect(e.source).toBe('mars-aaa')
    expect(e.target).toBe('mars-center')
    expect(e.data?.kind).toBe('blocks')
  })

  it('maps recovers edges from source to target', () => {
    const { edges } = buildArcData(dagWithRecovery, 'mars-center', 'failed')
    const e = edges[0]
    expect(e.source).toBe('mars-center')
    expect(e.target).toBe('mars-fix')
    expect(e.data?.kind).toBe('recovers')
  })

  it('emits zero edges for an empty dag', () => {
    const { edges } = buildArcData(emptyDag, 'mars-center', 'failed')
    expect(edges).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// ArcGraph component — empty-guard (no canvas instantiation needed)
// ---------------------------------------------------------------------------

describe('ArcGraph – empty guard', () => {
  it('renders nothing (null) when dag has no peripheral nodes', () => {
    const html = renderToStaticMarkup(
      <ArcGraph dag={emptyDag} entityId="mars-center" entityStatus="failed" />,
    )
    expect(html).toBe('')
  })

  it('renders a container div when dag has blockers', () => {
    const html = renderToStaticMarkup(
      <ArcGraph dag={dagWithBlocker} entityId="mars-center" entityStatus="failed" />,
    )
    // The outer ArcGraphCanvas renders at minimum the canvas div + sr-only list
    expect(html).not.toBe('')
    expect(html).toContain('<div')
  })

  it('renders a container div when dag has blocking tasks', () => {
    const dagBlocking: DagContext = {
      blockers: [],
      blocking: [{ id: 'child', status: 'queued', summary: '' }],
      descendants: [],
      proposalId: null,
      edges: [{ from: 'mars-center', to: 'child', kind: 'blocks' }],
    }
    const html = renderToStaticMarkup(
      <ArcGraph dag={dagBlocking} entityId="mars-center" entityStatus="failed" />,
    )
    expect(html).not.toBe('')
  })

  it('renders a container div when dag has descendants', () => {
    const html = renderToStaticMarkup(
      <ArcGraph dag={dagWithRecovery} entityId="mars-center" entityStatus="failed" />,
    )
    expect(html).not.toBe('')
  })
})

describe('ArcGraph – a11y list', () => {
  it('includes a visually-hidden list with blocker node ids', () => {
    const html = renderToStaticMarkup(
      <ArcGraph dag={dagWithBlocker} entityId="mars-center" entityStatus="failed" />,
    )
    // The sr-only list must include the blocker's id
    expect(html).toContain('mars-aaa')
  })

  it('includes recovery descendant ids in the a11y list', () => {
    const html = renderToStaticMarkup(
      <ArcGraph dag={dagWithRecovery} entityId="mars-center" entityStatus="failed" />,
    )
    expect(html).toContain('mars-fix')
  })

  it('canvas div is aria-hidden', () => {
    const html = renderToStaticMarkup(
      <ArcGraph dag={dagWithBlocker} entityId="mars-center" entityStatus="failed" />,
    )
    expect(html).toContain('aria-hidden="true"')
  })
})
