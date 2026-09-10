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
// A task-failure row must never name a wipe after the verb that preserves work
// ---------------------------------------------------------------------------

describe('ActionQueueRow – recovery verbs say what they do', () => {
  // This row used to relabel the server's `restart` verb to "Continue" and
  // style it `primary`. In Mars those are opposite operations: `continue`
  // resumes on the existing worktree and keeps the worker's commits, while
  // `restart` deletes the worktree and branch and discards them. The button
  // read as the safe one, looked like the recommended one, and was the
  // destructive one.
  const FAILED_ITEM: ActionQueueItem = {
    ...PROPOSAL_ITEM,
    id: 'failed:task-1',
    kind: 'failed',
    entityId: 'task-1',
    actions: [],
    // A task-backed row: only these carry a dag, and only these can be continued.
    dag: { blockers: [], blocking: [], descendants: [], proposalId: null, edges: [] },
    verbs: [{ op: 'restart', label: 'Restart', style: 'primary' }],
  } as unknown as ActionQueueItem

  it('calls the wipe "Restart", never "Continue", and keeps it behind the overflow', () => {
    const { container } = renderRow(FAILED_ITEM)
    // Destructive verbs live behind the overflow, so a wipe takes two clicks —
    // and the main row is left to the verb that preserves work.
    const btn = container.querySelector('[data-testid="alert-overflow-restart"]')
    expect(btn).not.toBeNull()
    expect(btn!.textContent).toContain('Restart')
    expect(btn!.textContent).not.toContain('Continue')
    expect(container.querySelector('[data-testid="alert-card-verb-restart"]')).toBeNull()
  })

  it('offers the real Continue as its own verb, dispatching the continue op', async () => {
    const { container } = renderRow(FAILED_ITEM)
    const btn = container.querySelector('[data-testid="alert-card-verb-continue"]')
    expect(btn).not.toBeNull()
    expect(btn!.textContent).toContain('Continue')
    await act(async () => {
      btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(mockInvokeAction).toHaveBeenCalledWith('continue', 'task-1')
  })

  it('still dispatches restart when the restart button is the one pressed', async () => {
    const { container } = renderRow(FAILED_ITEM)
    const btn = container.querySelector('[data-testid="alert-overflow-restart"]')!
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(mockInvokeAction).toHaveBeenCalledWith('restart', 'task-1')
  })

  it('withholds Continue once the task has spent its one recovery attempt', () => {
    const exhausted = { ...FAILED_ITEM, recoveryExhausted: true } as unknown as ActionQueueItem
    const { container } = renderRow(exhausted)
    expect(container.querySelector('[data-testid="alert-card-verb-continue"]')).toBeNull()
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
    expect(menu!.textContent).toContain('Delete task')
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

// ---------------------------------------------------------------------------
// Regression: two failed tasks each show their OWN title and phase (DEC-2026-09)
// ---------------------------------------------------------------------------

describe('ActionQueueRow – per-task title/phase isolation', () => {
  // Two tasks whose IDs differ by one character — the exact scenario that
  // produced a trust-damaging cross-task data leak in the "Needs You" view.
  const TASK_A: ActionQueueItem = {
    ...PROPOSAL_ITEM,
    id: 'failed:mars-abc1',
    kind: 'failed',
    entityId: 'mars-abc1',
    dag: { id: 'mars-abc1' },
    title: 'Task mars-abc1 failed at setup: The coding environment could not be set up',
    humanSummary: 'A task got stuck and Mars used up its automatic retry.',
    operatorGoal: 'Regroup sidebar into Decide / Watch / Tune',
    humanDetail: {
      failureSignature: 'setup:worker-error/unclassified',
      errorExcerpt: 'worker failed to start',
      branch: 'task/mars-abc1',
      worktree: '/tmp/worktrees/mars-abc1',
    },
    actions: [],
    verbs: [{ op: 'restart', label: 'Restart', style: 'primary' }],
  } as unknown as ActionQueueItem

  const TASK_B: ActionQueueItem = {
    ...PROPOSAL_ITEM,
    id: 'failed:mars-abc2',
    kind: 'failed',
    entityId: 'mars-abc2',
    dag: { id: 'mars-abc2' },
    title: 'Task mars-abc2 failed at setup: The coding environment could not be set up',
    humanSummary: 'A task got stuck and Mars used up its automatic retry.',
    operatorGoal: 'One source of truth for counts: /view/counts + useCounts hook',
    humanDetail: {
      failureSignature: 'merge:crashed/unclassified',
      errorExcerpt: 'duplicate key value violates unique constraint merge_jobs_active_task_uidx',
      branch: 'task/mars-abc2',
      worktree: '/tmp/worktrees/mars-abc2',
    },
    actions: [],
    verbs: [{ op: 'restart', label: 'Restart', style: 'primary' }],
  } as unknown as ActionQueueItem

  it('task A shows its own operatorGoal, not task B\'s', () => {
    const { container } = renderRow(TASK_A)
    const goal = container.querySelector('[data-testid="alert-card-goal"]')
    expect(goal).not.toBeNull()
    expect(goal!.textContent).toContain('Regroup sidebar')
    expect(goal!.textContent).not.toContain('One source of truth')
  })

  it('task B shows its own operatorGoal, not task A\'s', () => {
    const { container } = renderRow(TASK_B)
    const goal = container.querySelector('[data-testid="alert-card-goal"]')
    expect(goal).not.toBeNull()
    expect(goal!.textContent).toContain('One source of truth')
    expect(goal!.textContent).not.toContain('Regroup sidebar')
  })

  it('task A (setup failure) shows setup cause phrase', () => {
    const { container } = renderRow(TASK_A)
    const summary = container.querySelector('[data-testid="alert-card-summary"]')
    expect(summary).not.toBeNull()
    expect(summary!.textContent).toContain('Setup step failed')
  })

  it('task B (merge:crashed) shows merge-internal-error phrase, never setup phrase', () => {
    const { container } = renderRow(TASK_B)
    const summary = container.querySelector('[data-testid="alert-card-summary"]')
    expect(summary).not.toBeNull()
    expect(summary!.textContent).toContain('Merge failed inside Mars (internal error)')
    expect(summary!.textContent).not.toContain('coding environment could not be set up')
    expect(summary!.textContent).not.toContain('Setup step failed')
  })
})

// ---------------------------------------------------------------------------
// Regression: merge:crashed/unclassified never shows a setup-phase message
// ---------------------------------------------------------------------------

describe('ActionQueueRow – merge:crashed cause phrase', () => {
  const MERGE_CRASH_ITEM: ActionQueueItem = {
    ...PROPOSAL_ITEM,
    id: 'failed:mars-a6c520d3',
    kind: 'failed',
    entityId: 'mars-a6c520d3',
    dag: { id: 'mars-a6c520d3' },
    title: 'Task mars-a6c520d3 failed at setup: The coding environment could not be set up',
    humanSummary: 'A task got stuck and Mars used up its automatic retry.',
    operatorGoal: 'One source of truth for counts: /view/counts + useCounts hook',
    humanDetail: {
      failureSignature: 'merge:crashed/unclassified',
      errorExcerpt: 'merge step crashed: duplicate key value violates unique constraint merge_jobs_active_task_uidx',
      branch: 'task/mars-a6c520d3',
      worktree: '/tmp/worktrees/mars-a6c520d3',
    },
    actions: [],
    verbs: [{ op: 'restart', label: 'Restart', style: 'primary' }],
  } as unknown as ActionQueueItem

  it('shows "Merge failed inside Mars (internal error)", not a setup message', () => {
    const { container } = renderRow(MERGE_CRASH_ITEM)
    const summary = container.querySelector('[data-testid="alert-card-summary"]')
    expect(summary).not.toBeNull()
    expect(summary!.textContent).toContain('Merge failed inside Mars (internal error)')
  })

  it('does not contain "coding environment could not be set up"', () => {
    const { container } = renderRow(MERGE_CRASH_ITEM)
    // The card face (excluding the Output disclosure panel) must not show
    // the setup-phase boilerplate that comes from item.title when the task
    // actually failed at the merge step.
    const card = container.querySelector('[data-testid="alert-card"]')
    expect(card!.textContent).not.toContain('coding environment could not be set up')
  })
})
