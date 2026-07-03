/**
 * ArcTree tests.
 *
 * Strategy:
 *  - The pure `buildArcTree` function is tested directly — no DOM needed.
 *  - The `ArcTree` component is exercised via renderToStaticMarkup.
 *    Task IDs appear directly in the rendered HTML (not just in an sr-only
 *    list) because ArcTree renders real DOM text nodes.
 *
 * Schema round-trip: verifies that `dagContextSchema.parse()` accepts `edges`
 * with both `blocks` and `recovers` kinds.
 */
import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { dagContextSchema } from '@/shared/schemas'
import { ArcTree, buildArcTree } from './ArcTree'
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
  // Daemon emits recovers edges as { from: recoveryTask, to: originTask }
  edges: [{ from: 'mars-fix', to: 'mars-center', kind: 'recovers' }],
}

const dagFull: DagContext = {
  blockers: [{ id: 'mars-blocker', status: 'done', summary: 'prerequisite' }],
  blocking: [{ id: 'mars-child', status: 'queued', summary: 'downstream' }],
  descendants: [{ id: 'mars-fix', status: 'running', summary: 'recovery' }],
  proposalId: null,
  edges: [
    { from: 'mars-blocker', to: 'mars-center', kind: 'blocks' },
    { from: 'mars-center', to: 'mars-child', kind: 'blocks' },
    { from: 'mars-fix', to: 'mars-center', kind: 'recovers' },
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
        { from: 'b', to: 'entity-1', kind: 'recovers' },
      ],
    }
    const result = dagContextSchema.parse(raw)
    expect(result.edges).toHaveLength(2)
    expect(result.edges[0]).toEqual({ from: 'a', to: 'entity-1', kind: 'blocks' })
    expect(result.edges[1]).toEqual({ from: 'b', to: 'entity-1', kind: 'recovers' })
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
// buildArcTree — ordered rows
// ---------------------------------------------------------------------------

describe('buildArcTree – central entity', () => {
  it('always includes the central entity row', () => {
    const rows = buildArcTree(dagWithBlocker, 'mars-center', 'failed')
    const center = rows.find((r) => r.id === 'mars-center')
    expect(center).toBeDefined()
    expect(center?.isCenter).toBe(true)
    expect(center?.status).toBe('failed')
  })

  it('marks the central entity as isCenter: true', () => {
    const rows = buildArcTree(emptyDag, 'mars-center', 'running')
    expect(rows).toHaveLength(1)
    expect(rows[0].isCenter).toBe(true)
  })

  it('marks all peripheral nodes as isCenter: false', () => {
    const rows = buildArcTree(dagWithBlocker, 'mars-center', 'failed')
    for (const row of rows) {
      if (row.id !== 'mars-center') {
        expect(row.isCenter).toBe(false)
      }
    }
  })
})

describe('buildArcTree – ordering', () => {
  it('places blockers before the central entity', () => {
    const rows = buildArcTree(dagWithBlocker, 'mars-center', 'failed')
    const blockerIdx = rows.findIndex((r) => r.id === 'mars-aaa')
    const centerIdx = rows.findIndex((r) => r.id === 'mars-center')
    expect(blockerIdx).toBeLessThan(centerIdx)
  })

  it('places the central entity before blocking tasks', () => {
    const dagBlocking: DagContext = {
      blockers: [],
      blocking: [{ id: 'mars-child', status: 'queued', summary: '' }],
      descendants: [],
      proposalId: null,
      edges: [],
    }
    const rows = buildArcTree(dagBlocking, 'mars-center', 'failed')
    const centerIdx = rows.findIndex((r) => r.id === 'mars-center')
    const childIdx = rows.findIndex((r) => r.id === 'mars-child')
    expect(centerIdx).toBeLessThan(childIdx)
  })

  it('places blocking tasks before recovery descendants', () => {
    const rows = buildArcTree(dagFull, 'mars-center', 'failed')
    const childIdx = rows.findIndex((r) => r.id === 'mars-child')
    const fixIdx = rows.findIndex((r) => r.id === 'mars-fix')
    expect(childIdx).toBeLessThan(fixIdx)
  })

  it('includes all peripheral node categories', () => {
    const rows = buildArcTree(dagFull, 'mars-center', 'failed')
    const ids = rows.map((r) => r.id)
    expect(ids).toContain('mars-center')
    expect(ids).toContain('mars-blocker')
    expect(ids).toContain('mars-child')
    expect(ids).toContain('mars-fix')
  })
})

describe('buildArcTree – depth', () => {
  it('assigns depth 0 to the central entity', () => {
    const rows = buildArcTree(dagFull, 'mars-center', 'failed')
    const center = rows.find((r) => r.id === 'mars-center')
    expect(center?.depth).toBe(0)
  })

  it('assigns depth 0 to blocker nodes', () => {
    const rows = buildArcTree(dagFull, 'mars-center', 'failed')
    const blocker = rows.find((r) => r.id === 'mars-blocker')
    expect(blocker?.depth).toBe(0)
  })

  it('assigns depth 0 to blocking nodes', () => {
    const rows = buildArcTree(dagFull, 'mars-center', 'failed')
    const child = rows.find((r) => r.id === 'mars-child')
    expect(child?.depth).toBe(0)
  })

  it('assigns depth 1 to recovery descendants', () => {
    const rows = buildArcTree(dagFull, 'mars-center', 'failed')
    const fix = rows.find((r) => r.id === 'mars-fix')
    expect(fix?.depth).toBe(1)
  })
})

describe('buildArcTree – kind assignment', () => {
  it("assigns kind 'FIX' to nodes reached via a recovers edge", () => {
    const rows = buildArcTree(dagWithRecovery, 'mars-center', 'failed')
    const fix = rows.find((r) => r.id === 'mars-fix')
    expect(fix?.kind).toBe('FIX')
  })

  it("assigns kind 'TASK' to regular blocker nodes", () => {
    const rows = buildArcTree(dagWithBlocker, 'mars-center', 'failed')
    const blocker = rows.find((r) => r.id === 'mars-aaa')
    expect(blocker?.kind).toBe('TASK')
  })

  it("assigns FIX to the recovery task (fix-*) with realistic recovery→origin edge", () => {
    // The daemon emits recovers edges as { from: recoveryTask, to: originTask }.
    // e.g. fix-78dac451 recovered mars-b4370733 → edge is fix→origin.
    const dagRealistic: DagContext = {
      blockers: [],
      blocking: [],
      descendants: [{ id: 'fix-78dac451', status: 'running', summary: 'Recovery run' }],
      proposalId: null,
      edges: [{ from: 'fix-78dac451', to: 'mars-b4370733', kind: 'recovers' }],
    }
    const rows = buildArcTree(dagRealistic, 'mars-b4370733', 'failed')
    const fix = rows.find((r) => r.id === 'fix-78dac451')
    const origin = rows.find((r) => r.id === 'mars-b4370733')
    expect(fix?.kind).toBe('FIX')
    expect(origin?.kind).toBe('TASK')
  })

  it("assigns kind 'PROPOSAL' when id matches dag.proposalId", () => {
    const dagWithProposal: DagContext = {
      blockers: [{ id: 'prop-123', status: 'done', summary: 'proposal' }],
      blocking: [],
      descendants: [],
      proposalId: 'prop-123',
      edges: [],
    }
    const rows = buildArcTree(dagWithProposal, 'mars-center', 'running')
    const proposal = rows.find((r) => r.id === 'prop-123')
    expect(proposal?.kind).toBe('PROPOSAL')
  })
})

describe('buildArcTree – deduplication', () => {
  it('deduplicates nodes when the same id appears in multiple arrays', () => {
    const dag: DagContext = {
      blockers: [{ id: 'shared', status: 'done', summary: '' }],
      blocking: [{ id: 'shared', status: 'done', summary: '' }],
      descendants: [],
      proposalId: null,
      edges: [],
    }
    const rows = buildArcTree(dag, 'mars-center', 'failed')
    const sharedRows = rows.filter((r) => r.id === 'shared')
    expect(sharedRows).toHaveLength(1)
  })

  it('preserves the status from the dag node for peripheral nodes', () => {
    const rows = buildArcTree(dagWithBlocker, 'mars-center', 'failed')
    const blocker = rows.find((r) => r.id === 'mars-aaa')
    expect(blocker?.status).toBe('failed')
  })

  it('preserves the summary from the dag node for peripheral nodes', () => {
    const rows = buildArcTree(dagWithBlocker, 'mars-center', 'failed')
    const blocker = rows.find((r) => r.id === 'mars-aaa')
    expect(blocker?.summary).toBe('upstream task')
  })
})

// ---------------------------------------------------------------------------
// ArcTree component — empty guard (no canvas instantiation)
// ---------------------------------------------------------------------------

describe('ArcTree – empty guard', () => {
  it('renders nothing (null) when dag has no peripheral nodes', () => {
    const html = renderToStaticMarkup(
      <ArcTree dag={emptyDag} entityId="mars-center" entityStatus="failed" />,
    )
    expect(html).toBe('')
  })

  it('renders a list when dag has blockers', () => {
    const html = renderToStaticMarkup(
      <ArcTree dag={dagWithBlocker} entityId="mars-center" entityStatus="failed" />,
    )
    expect(html).not.toBe('')
    expect(html).toContain('<ul')
  })

  it('renders a list when dag has blocking tasks', () => {
    const dagBlocking: DagContext = {
      blockers: [],
      blocking: [{ id: 'child', status: 'queued', summary: '' }],
      descendants: [],
      proposalId: null,
      edges: [{ from: 'mars-center', to: 'child', kind: 'blocks' }],
    }
    const html = renderToStaticMarkup(
      <ArcTree dag={dagBlocking} entityId="mars-center" entityStatus="failed" />,
    )
    expect(html).not.toBe('')
  })

  it('renders a list when dag has descendants', () => {
    const html = renderToStaticMarkup(
      <ArcTree dag={dagWithRecovery} entityId="mars-center" entityStatus="failed" />,
    )
    expect(html).not.toBe('')
  })
})

describe('ArcTree – task IDs in rendered HTML', () => {
  it('includes blocker node id directly in the rendered HTML', () => {
    const html = renderToStaticMarkup(
      <ArcTree dag={dagWithBlocker} entityId="mars-center" entityStatus="failed" />,
    )
    // IDs must appear in real DOM text (not just a hidden fallback)
    expect(html).toContain('mars-aaa')
  })

  it('includes the central entity id in the rendered HTML', () => {
    const html = renderToStaticMarkup(
      <ArcTree dag={dagWithBlocker} entityId="mars-center" entityStatus="failed" />,
    )
    expect(html).toContain('mars-center')
  })

  it('includes recovery descendant id in the rendered HTML', () => {
    const html = renderToStaticMarkup(
      <ArcTree dag={dagWithRecovery} entityId="mars-center" entityStatus="failed" />,
    )
    expect(html).toContain('mars-fix')
  })

  it('includes all node ids from a full dag', () => {
    const html = renderToStaticMarkup(
      <ArcTree dag={dagFull} entityId="mars-center" entityStatus="failed" />,
    )
    expect(html).toContain('mars-blocker')
    expect(html).toContain('mars-center')
    expect(html).toContain('mars-child')
    expect(html).toContain('mars-fix')
  })

  it('does NOT contain aria-hidden canvas (DOM-based, no canvas needed)', () => {
    const html = renderToStaticMarkup(
      <ArcTree dag={dagWithBlocker} entityId="mars-center" entityStatus="failed" />,
    )
    expect(html).not.toContain('<canvas')
  })
})

describe('ArcTree – kind labels in rendered HTML', () => {
  it('shows FIX label for recovery descendants', () => {
    const html = renderToStaticMarkup(
      <ArcTree dag={dagWithRecovery} entityId="mars-center" entityStatus="failed" />,
    )
    expect(html).toContain('FIX')
  })

  it('shows TASK label for regular nodes', () => {
    const html = renderToStaticMarkup(
      <ArcTree dag={dagWithBlocker} entityId="mars-center" entityStatus="failed" />,
    )
    expect(html).toContain('TASK')
  })
})
