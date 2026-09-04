// @vitest-environment happy-dom
/**
 * ActionQueueRow — copy-op behaviour tests, slice-failed rendering, and
 * task-failure relabeling.
 *
 * Verifies:
 *  - A verb with `op: 'copy'` is handled client-side (clipboard write) and
 *    does NOT call invokeAction / make any network request.
 *  - `slice-failed` rows render the proposal title as the primary goal heading
 *    and a "Slice again" primary action that calls `proposal.slice`.
 *  - Task-failure rows relabel the `restart` verb to "Continue".
 */

import { vi, describe, it, expect, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ActionQueueRow } from '@/widgets/ActionQueueRow'
import type { ActionQueueItem } from '@/shared/schemas'

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockInvokeAction = vi.fn().mockResolvedValue(undefined)

vi.mock('@/shared/api', () => ({
  snoozeActionQueueItem: vi.fn().mockResolvedValue(undefined),
  restoreSnoozedItem: vi.fn().mockResolvedValue(undefined),
  invokeAction: (...args: unknown[]) => mockInvokeAction(...args),
}))

// ---------------------------------------------------------------------------
// Clipboard mock
// ---------------------------------------------------------------------------

const mockClipboardWrite = vi.fn().mockResolvedValue(undefined)
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: mockClipboardWrite },
  configurable: true,
  writable: true,
})

// ---------------------------------------------------------------------------
// Fixture — draft-proposal row with a copy-op action
// ---------------------------------------------------------------------------

const PROPOSAL_ITEM: ActionQueueItem = {
  id: 'draft-proposal:p-abc',
  kind: 'draft-proposal',
  entityId: 'p-abc',
  priority: 'low',
  title: 'Ship the feature',
  body: 'as a user, I want this done',
  at: new Date().toISOString(),
  dag: null,
  errorKind: null,
  actions: [{ id: 'move-forward', label: 'Move forward', op: 'copy', hint: '/mars:grill p-abc' }],
  diagnosis: null,
  failureReasonCode: null,
  fixForTaskId: null,
  resolution: null,
  devServerUrl: null,
  humanSummary: 'Draft proposal: Ship the feature',
  humanDetail: undefined,
  arcGoal: undefined,
  verbs: [],
} as unknown as ActionQueueItem

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function renderRow(item: ActionQueueItem = PROPOSAL_ITEM): {
  container: HTMLElement
  root: ReturnType<typeof createRoot>
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<ActionQueueRow item={item} />)
  })
  return { container, root }
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// copy-op verb behaviour
// ---------------------------------------------------------------------------

describe('ActionQueueRow – copy-op verb', () => {
  it('renders the copy-op action as a button in the card', () => {
    const { container } = renderRow()
    const btn = container.querySelector('[data-testid="alert-card-verb-copy"]')
    expect(btn).not.toBeNull()
    expect(btn!.textContent).toContain('Move forward')
  })

  it('clicking the copy-op button does NOT call invokeAction', async () => {
    const { container } = renderRow()
    const btn = container.querySelector('[data-testid="alert-card-verb-copy"]')!
    expect(btn).not.toBeNull()

    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mockInvokeAction).not.toHaveBeenCalled()
  })

  it('clicking the copy-op button writes the hint text to the clipboard', async () => {
    const { container } = renderRow()
    const btn = container.querySelector('[data-testid="alert-card-verb-copy"]')!

    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mockClipboardWrite).toHaveBeenCalledTimes(1)
    expect(mockClipboardWrite).toHaveBeenCalledWith('/mars:grill p-abc')
  })

  it('falls back to label when hint is absent', async () => {
    const itemNoHint: ActionQueueItem = {
      ...PROPOSAL_ITEM,
      actions: [{ id: 'fwd', label: 'Forward', op: 'copy' }],
    } as unknown as ActionQueueItem

    const { container } = renderRow(itemNoHint)
    const btn = container.querySelector('[data-testid="alert-card-verb-copy"]')!

    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mockClipboardWrite).toHaveBeenCalledWith('Forward')
    expect(mockInvokeAction).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// restart → "Continue" relabeling on task-failure rows
// ---------------------------------------------------------------------------

describe('ActionQueueRow – task-failure rows relabel the restart verb', () => {
  // 'failed' is a member of taskFailureKinds (isTaskFailureActionQueueKind),
  // so its server-provided 'restart' verb is relabeled to the Mars recovery
  // vocabulary term "Continue" client-side (see ActionQueueRow.tsx).
  const FAILED_ITEM: ActionQueueItem = {
    ...PROPOSAL_ITEM,
    id: 'failed:task-1',
    kind: 'failed',
    entityId: 'task-1',
    actions: [],
    verbs: [{ op: 'restart', label: 'Restart', style: 'primary' }],
  } as unknown as ActionQueueItem

  it('renders the restart verb button labelled "Continue", not "Restart"', () => {
    const { container } = renderRow(FAILED_ITEM)
    const btn = container.querySelector('[data-testid="alert-card-verb-restart"]')
    expect(btn).not.toBeNull()
    expect(btn!.textContent).toContain('Continue')
    expect(btn!.textContent).not.toContain('Restart')
  })

  it('clicking it still dispatches invokeAction("restart", entityId)', async () => {
    const { container } = renderRow(FAILED_ITEM)
    const btn = container.querySelector('[data-testid="alert-card-verb-restart"]')!
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(mockInvokeAction).toHaveBeenCalledWith('restart', 'task-1')
  })
})

// ---------------------------------------------------------------------------
// slice-failed card — proposal title + "Slice again" action
// ---------------------------------------------------------------------------

describe('ActionQueueRow – slice-failed rows', () => {
  /**
   * A `slice-failed` action-queue item.
   * The backend recipe sets `operatorGoal` to the proposal title (from
   * payload.proposalTitle) and adds a `proposal.slice` primary verb so the
   * operator can retry without leaving the triage surface.
   */
  const SLICE_FAILED_ITEM: ActionQueueItem = {
    ...PROPOSAL_ITEM,
    id: 'slice-failed:prop-xyz',
    kind: 'slice-failed',
    entityId: 'prop-xyz',
    title: 'Slicer failed for PRD prop-xyz',
    humanSummary:
      'Mars could not turn this PRD into tasks — inspect the failure, then explicitly slice it again when ready.',
    operatorGoal: 'Ship the logging feature',
    dag: null,
    actions: [],
    verbs: [{ op: 'proposal.slice', label: 'Slice again', style: 'primary' }],
  } as unknown as ActionQueueItem

  it('shows the proposal title as the primary goal heading', () => {
    const { container } = renderRow(SLICE_FAILED_ITEM)
    const goal = container.querySelector('[data-testid="alert-card-goal"]')
    expect(goal).not.toBeNull()
    expect(goal!.textContent).toContain('Ship the logging feature')
  })

  it('shows the generic description as the subhead, not as the primary line', () => {
    const { container } = renderRow(SLICE_FAILED_ITEM)
    // With operatorGoal set, alert-card-summary is the secondary line.
    const summary = container.querySelector('[data-testid="alert-card-summary"]')
    expect(summary).not.toBeNull()
    expect(summary!.textContent).toContain('Mars could not turn this PRD')
  })

  it('renders a "Slice again" primary action button', () => {
    const { container } = renderRow(SLICE_FAILED_ITEM)
    const btn = container.querySelector('[data-testid="alert-card-verb-proposal.slice"]')
    expect(btn).not.toBeNull()
    expect(btn!.textContent).toContain('Slice again')
  })

  it('clicking "Slice again" calls invokeAction("proposal.slice", proposalId)', async () => {
    const { container } = renderRow(SLICE_FAILED_ITEM)
    const btn = container.querySelector('[data-testid="alert-card-verb-proposal.slice"]')!
    expect(btn).not.toBeNull()

    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mockInvokeAction).toHaveBeenCalledWith('proposal.slice', 'prop-xyz')
  })
})

// ---------------------------------------------------------------------------
// Failed card display — headline, output, overflow menu (DEC-18 / VISION §7)
// ---------------------------------------------------------------------------

describe('ActionQueueRow – failed card headline and output', () => {
  const FAILED_CARD: ActionQueueItem = {
    ...PROPOSAL_ITEM,
    id: 'failed:mars-8e4c98a5',
    kind: 'failed',
    entityId: 'mars-8e4c98a5',
    dag: { id: 'mars-8e4c98a5' },
    title: 'Task mars-8e4c98a5 failed at merge:hard-timeout: The changes could not be merged',
    humanSummary: 'A task got stuck and Mars used up its automatic retry.',
    operatorGoal: 'Shared contract: config.ts',
    humanDetail: {
      failureSignature: 'merge:hard-timeout',
      errorExcerpt: 'Error: hard timeout reached after 30000ms\nBranch task/mars-8e4c98a5 could not be fast-forwarded.',
      branch: 'task/mars-8e4c98a5',
      worktree: '/tmp/worktrees/mars-8e4c98a5',
    },
    actions: [],
    verbs: [
      { op: 'restart', label: 'Restart', style: 'primary' },
      { op: 'purge', label: 'Discard task', style: 'destructive' },
    ],
  } as unknown as ActionQueueItem

  it('primary headline is the operatorGoal (task intent), not the machine slug', () => {
    const { container } = renderRow(FAILED_CARD)
    const goal = container.querySelector('[data-testid="alert-card-goal"]')
    expect(goal).not.toBeNull()
    expect(goal!.textContent).toContain('Shared contract: config.ts')
    expect(goal!.textContent).not.toContain('merge:hard-timeout')
  })

  it('machine slug is not visible on the card face at initial render', () => {
    const { container } = renderRow(FAILED_CARD)
    // Neither the output panel nor the detail panel are open at render time,
    // so the raw signature slug must not appear anywhere in the visible text.
    const card = container.querySelector('[data-testid="alert-card"]')
    expect(card!.textContent).not.toContain('merge:hard-timeout')
  })

  it('OUTPUT disclosure shows failure_reason text when opened', async () => {
    const { container } = renderRow(FAILED_CARD)
    const toggleBtn = container.querySelector('[data-testid="alert-output-toggle"]')
    expect(toggleBtn).not.toBeNull()
    await act(async () => {
      toggleBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const panel = container.querySelector('[data-testid="alert-output-panel"]')
    expect(panel).not.toBeNull()
    // The raw signature is shown inside the Output panel as failure_reason.
    expect(panel!.textContent).toContain('merge:hard-timeout')
    expect(panel!.textContent).toContain('failure_reason')
  })

  it('OUTPUT disclosure shows branch and worktree when opened', async () => {
    const { container } = renderRow(FAILED_CARD)
    const toggleBtn = container.querySelector('[data-testid="alert-output-toggle"]')!
    await act(async () => {
      toggleBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const panel = container.querySelector('[data-testid="alert-output-panel"]')!
    expect(panel.textContent).toContain('task/mars-8e4c98a5')
    expect(panel.textContent).toContain('/tmp/worktrees/mars-8e4c98a5')
  })

  it('overflow … trigger renders and opens a menu with secondary verbs', async () => {
    const { container } = renderRow(FAILED_CARD)
    const trigger = container.querySelector('[data-testid="alert-overflow-trigger"]')
    expect(trigger).not.toBeNull()
    expect(trigger!.getAttribute('aria-label')).toBe('More actions')
    // The menu is always in the DOM (hidden via CSS when closed) so items are
    // always queryable — only visibility changes on trigger click.
    const menu = container.querySelector('[data-testid="alert-overflow-menu"]')
    expect(menu).not.toBeNull()
    // Destructive secondary verb (Discard task) appears in the menu.
    expect(menu!.textContent).toContain('Discard task')
  })

  it('overflow menu also has Open task when row is task-backed', async () => {
    const { container } = renderRow(FAILED_CARD)
    const trigger = container.querySelector('[data-testid="alert-overflow-trigger"]')!
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const openTask = container.querySelector('[data-testid="alert-overflow-open-task"]')
    expect(openTask).not.toBeNull()
    expect(openTask!.textContent).toContain('Open task')
  })
})
