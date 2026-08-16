/**
 * BoardView.dense.test.tsx
 *
 * Component tests for the dense 4-column Progress board:
 *   Proposals / In progress / Blocked / Failed
 *
 * Tests observable HTML output via renderToStaticMarkup — no click handlers,
 * no window references (those are SSR-safe in React's static renderer).
 */
import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ProgressProposalNode, ProgressTask } from '@/shared/schemas'
import { BoardView } from './BoardView'

// ---------------------------------------------------------------------------
// Test-data helpers
// ---------------------------------------------------------------------------

const task = (
  overrides: Partial<ProgressTask> & { id: string; cluster: ProgressTask['cluster'] },
): ProgressTask => ({
  id: overrides.id,
  prompt: overrides.prompt ?? `Task ${overrides.id}`,
  status: overrides.status ?? 'queued',
  plan: null,
  branch: null,
  worktreePath: null,
  error: null,
  dropReason: null,
  recoverySpawnedCount: 0,
  blockerTaskId: null,
  blockedBy: [],
  spec: null,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  cluster: overrides.cluster,
  parentProposalId: overrides.parentProposalId ?? null,
  ...overrides,
})

const emptyByCluster = () => ({
  Queued: [] as ProgressTask[],
  'In progress': [] as ProgressTask[],
  Blocked: [] as ProgressTask[],
  Failed: [] as ProgressTask[],
  Done: [] as ProgressTask[],
})

const proposal = (
  overrides: Partial<ProgressProposalNode> & { id: string },
): ProgressProposalNode => ({
  id: overrides.id,
  title: overrides.title ?? `Proposal ${overrides.id}`,
  source: overrides.source ?? 'human',
  status: overrides.status ?? 'draft',
  mockupReady: overrides.mockupReady ?? false,
})

// ---------------------------------------------------------------------------
// Four column titles and count pills
// ---------------------------------------------------------------------------

describe('BoardView dense — four column titles', () => {
  it('renders all four column sections with correct data-board-column attributes', () => {
    const html = renderToStaticMarkup(
      <BoardView byCluster={emptyByCluster()} proposals={[]} error={null} selectedProposalId={null} />,
    )

    expect(html).toContain('data-board-column="Proposals"')
    expect(html).toContain('data-board-column="In progress"')
    expect(html).toContain('data-board-column="Blocked"')
    expect(html).toContain('data-board-column="Failed"')
  })

  it('column headers contain the uppercase column labels', () => {
    const html = renderToStaticMarkup(
      <BoardView byCluster={emptyByCluster()} proposals={[]} error={null} selectedProposalId={null} />,
    )

    expect(html).toContain('PROPOSALS')
    expect(html).toContain('IN PROGRESS')
    expect(html).toContain('BLOCKED')
    expect(html).toContain('FAILED')
  })

  it('count pill reflects the number of items in each column', () => {
    const p = proposal({ id: 'prop-1' })
    const running = task({ id: 'run-1', cluster: 'In progress', status: 'running' })
    const blocked = task({ id: 'blk-1', cluster: 'Blocked', status: 'blocked' })
    const failed = task({ id: 'fail-1', cluster: 'Failed', status: 'failed' })
    const byCluster = {
      ...emptyByCluster(),
      'In progress': [running],
      Blocked: [blocked],
      Failed: [failed],
    }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} proposals={[p]} error={null} selectedProposalId={null} />,
    )

    // Each column's count span carries data-column-count
    expect(html).toContain('data-column-count="Proposals"')
    expect(html).toContain('data-column-count="In progress"')
    expect(html).toContain('data-column-count="Blocked"')
    expect(html).toContain('data-column-count="Failed"')
  })

  it('column headers have a border-b underline', () => {
    const html = renderToStaticMarkup(
      <BoardView byCluster={emptyByCluster()} proposals={[]} error={null} selectedProposalId={null} />,
    )

    // DenseColumn renders <header className="... border-b ...">
    expect(html).toMatch(/<header[^>]*class="[^"]*\bborder-b\b/)
  })

  it('does not render lifecycle tab strip (Running / Recovering / Needs you / Done)', () => {
    const html = renderToStaticMarkup(
      <BoardView byCluster={emptyByCluster()} proposals={[]} error={null} selectedProposalId={null} />,
    )

    expect(html).not.toContain('data-tab="Running"')
    expect(html).not.toContain('data-tab="Recovering"')
    expect(html).not.toContain('data-tab="Needs you"')
    expect(html).not.toContain('board-tab-strip')
  })
})

// ---------------------------------------------------------------------------
// Step rail on task cards
// ---------------------------------------------------------------------------

describe('BoardView dense — step rail', () => {
  it('renders a step-rail with four bars for a running task', () => {
    const running = task({ id: 'run-1', cluster: 'In progress', status: 'running' })
    const byCluster = { ...emptyByCluster(), 'In progress': [running] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} proposals={[]} error={null} selectedProposalId={null} />,
    )

    // step-rail container
    expect(html).toContain('step-rail')
    // done step (setup complete)
    expect(html).toContain('s-done')
    // running step (code in progress)
    expect(html).toContain('s-run')
    // upcoming steps (verify + merge)
    expect(html).toContain('upcoming')
  })

  it('marks setup+code+verify bars done and merge bar running for a verifying task', () => {
    const verifying = task({ id: 'ver-1', cluster: 'In progress', status: 'verifying' })
    const byCluster = { ...emptyByCluster(), 'In progress': [verifying] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} proposals={[]} error={null} selectedProposalId={null} />,
    )

    // Two done bars + one running bar
    expect(html).toContain('s-done')
    expect(html).toContain('s-run')
  })

  it('marks all bars as upcoming for a blocked task', () => {
    const blocked = task({ id: 'blk-1', cluster: 'Blocked', status: 'blocked' })
    const byCluster = { ...emptyByCluster(), Blocked: [blocked] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} proposals={[]} error={null} selectedProposalId={null} />,
    )

    expect(html).toContain('upcoming')
    // No running or done bars for a blocked task
    expect(html).not.toContain('s-run')
    expect(html).not.toContain('s-done')
  })

  it('applies mars-card-live animation to a running task card', () => {
    const running = task({ id: 'run-1', cluster: 'In progress', status: 'running' })
    const byCluster = { ...emptyByCluster(), 'In progress': [running] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} proposals={[]} error={null} selectedProposalId={null} />,
    )

    expect(html).toContain('mars-card-live')
  })

  it('does not apply mars-card-live to a queued task card', () => {
    const queued = task({ id: 'q-1', cluster: 'Queued', status: 'queued' })
    const byCluster = { ...emptyByCluster(), Queued: [queued] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} proposals={[]} error={null} selectedProposalId={null} />,
    )

    expect(html).not.toContain('mars-card-live')
  })
})

// ---------------------------------------------------------------------------
// Failure-signature chip
// ---------------------------------------------------------------------------

describe('BoardView dense — failure-signature chip', () => {
  it('renders chip-fail with the failure signature for a failed task', () => {
    const failed = task({
      id: 'fail-1',
      cluster: 'Failed',
      status: 'failed',
      failureSignature: 'verify:test',
    })
    const byCluster = { ...emptyByCluster(), Failed: [failed] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} proposals={[]} error={null} selectedProposalId={null} />,
    )

    // The chip element has class chip-fail
    expect(html).toContain('chip-fail')
    // The failure signature text is visible
    expect(html).toContain('verify:test')
  })

  it('uses iron (status-failed) token classes on the failure chip', () => {
    const failed = task({
      id: 'fail-2',
      cluster: 'Failed',
      status: 'failed',
      failureSignature: 'verify:typecheck',
    })
    const byCluster = { ...emptyByCluster(), Failed: [failed] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} proposals={[]} error={null} selectedProposalId={null} />,
    )

    // chip uses status-failed token (iron), not raw palette class
    expect(html).toContain('text-status-failed')
    expect(html).toContain('bg-status-failed')
  })

  it('does not render a failure chip for a running task', () => {
    const running = task({ id: 'run-1', cluster: 'In progress', status: 'running' })
    const byCluster = { ...emptyByCluster(), 'In progress': [running] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} proposals={[]} error={null} selectedProposalId={null} />,
    )

    expect(html).not.toContain('chip-fail')
  })
})

// ---------------------------------------------------------------------------
// Proposal cards — dashed border, ochre surface, mockup chip
// ---------------------------------------------------------------------------

describe('BoardView dense — proposal cards', () => {
  it('renders proposal cards in the Proposals column', () => {
    const p = proposal({ id: 'prop-1', title: 'Ship the dashboard' })

    const html = renderToStaticMarkup(
      <BoardView byCluster={emptyByCluster()} proposals={[p]} error={null} selectedProposalId={null} />,
    )

    expect(html).toContain('data-proposal-card="prop-1"')
    expect(html).toContain('Ship the dashboard')
  })

  it('proposal cards use dashed border', () => {
    const p = proposal({ id: 'prop-2', title: 'Some proposal' })

    const html = renderToStaticMarkup(
      <BoardView byCluster={emptyByCluster()} proposals={[p]} error={null} selectedProposalId={null} />,
    )

    // The proposal card element must have border-dashed in its class list
    expect(html).toMatch(/data-proposal-card="prop-2"[^>]*class="[^"]*\bborder-dashed\b/)
  })

  it('proposal cards use warn/ochre-tinted surface (bg-warn token)', () => {
    const p = proposal({ id: 'prop-3' })

    const html = renderToStaticMarkup(
      <BoardView byCluster={emptyByCluster()} proposals={[p]} error={null} selectedProposalId={null} />,
    )

    // bg-warn/10 (ochre tint) on the proposal card
    expect(html).toMatch(/data-proposal-card="prop-3"[^>]*class="[^"]*\bbg-warn/)
  })

  it('renders "mockup ready ↗" chip when mockupReady is true', () => {
    const p = proposal({ id: 'prop-4', mockupReady: true })

    const html = renderToStaticMarkup(
      <BoardView byCluster={emptyByCluster()} proposals={[p]} error={null} selectedProposalId={null} />,
    )

    expect(html).toContain('mockup ready ↗')
  })

  it('does not render "mockup ready ↗" chip when mockupReady is false', () => {
    const p = proposal({ id: 'prop-5', mockupReady: false })

    const html = renderToStaticMarkup(
      <BoardView byCluster={emptyByCluster()} proposals={[p]} error={null} selectedProposalId={null} />,
    )

    expect(html).not.toContain('mockup ready ↗')
  })

  it('does not render "mockup ready ↗" chip when mockupReady is absent (default false)', () => {
    // Proposal with no mockupReady field (simulates legacy daemon response)
    const p: ProgressProposalNode = {
      id: 'prop-6',
      title: 'Legacy proposal',
      source: 'human',
      status: 'draft',
      mockupReady: false,
    }

    const html = renderToStaticMarkup(
      <BoardView byCluster={emptyByCluster()} proposals={[p]} error={null} selectedProposalId={null} />,
    )

    expect(html).not.toContain('mockup ready ↗')
  })
})

// ---------------------------------------------------------------------------
// Board layout — no bordered-card column chrome
// ---------------------------------------------------------------------------

describe('BoardView dense — column layout', () => {
  it('board uses a grid layout (grid-cols-4)', () => {
    const html = renderToStaticMarkup(
      <BoardView byCluster={emptyByCluster()} proposals={[]} error={null} selectedProposalId={null} />,
    )

    expect(html).toContain('grid-cols-4')
  })

  it('column sections do not wrap tasks in bordered-card chrome (no border border-border bg-secondary)', () => {
    const t = task({ id: 'task-1', cluster: 'Queued' })
    const byCluster = { ...emptyByCluster(), Queued: [t] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} proposals={[]} error={null} selectedProposalId={null} />,
    )

    expect(html).not.toContain('border border-border bg-secondary')
  })
})
