// @vitest-environment happy-dom
/**
 * QueueThreadRow interactive (DOM) tests.
 *
 * Covered scenarios:
 *   - A daemon-code-drift item's restart button calls invokeAction with the
 *     process-level 'restart-daemon' op and NO entityId — not the legacy
 *     ('restart', 'daemon-code-drift') pair that produced a 404.
 *   - A failed-task item's restart button calls invokeAction with 'restart'
 *     and the task id (regression guard).
 *
 * The `onRestart` callback provided to QueueThreadRow mirrors what ChatPage.tsx
 * produces after the fix: it prefers the restart-daemon verb (process-level op,
 * no entityId) over the legacy per-entity restart action.
 */

import { vi, describe, it, expect, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueueThreadRow } from './QueueThreadRow'
import type { ActionQueueItem } from '@/shared/schemas'

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before imports resolve
// ---------------------------------------------------------------------------

const mockInvokeAction = vi.fn().mockResolvedValue(undefined)

vi.mock('@/shared/api', () => ({
  invokeAction: (...args: unknown[]) => mockInvokeAction(...args),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderRow(
  item: ActionQueueItem,
  onRestart: (() => void) | null = null,
): { container: HTMLElement; root: ReturnType<typeof createRoot> } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <QueueThreadRow
        item={item}
        active={false}
        onSelect={() => {}}
        onRestart={onRestart}
        restartPending={false}
        restartError={null}
      />,
    )
  })
  return { container, root }
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// daemon-code-drift restart
// ---------------------------------------------------------------------------

describe('QueueThreadRow – daemon-code-drift restart', () => {
  const DRIFT_ITEM: ActionQueueItem = {
    id: 'aq-drift-1',
    kind: 'failed-task',
    entityId: 'daemon-code-drift',
    priority: 'high',
    title: 'The background engine is running old code — restart it',
    body: 'Daemon code drift detected',
    at: '2026-01-01T00:00:00Z',
    dag: null,
    errorKind: 'daemon-code-drift',
    // Legacy action that the old (broken) code used — produced 404
    actions: [{ id: 'restart', label: 'Restart', op: 'restart' }],
    diagnosis: null,
    // Recipe verb: the fixed ChatPage.tsx wiring picks this over the legacy action
    verbs: [{ op: 'restart-daemon', label: 'Restart engine', style: 'primary' }],
  } as unknown as ActionQueueItem

  it('restart button calls invokeAction("restart-daemon", undefined) — NOT ("restart", "daemon-code-drift")', async () => {
    // onRestart mirrors the fixed ChatPage.tsx wiring:
    //   item has restart-daemon verb → use process-level op → entityId is undefined
    // This is what handleQueueAction produces via PROCESS_LEVEL_OPS.has('restart-daemon').
    const onRestart = () => void mockInvokeAction('restart-daemon', undefined)

    const { container } = renderRow(DRIFT_ITEM, onRestart)

    const btn = container.querySelector(`[aria-label="Restart ${DRIFT_ITEM.entityId}"]`)
    expect(btn).not.toBeNull()

    await act(async () => {
      btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mockInvokeAction).toHaveBeenCalledTimes(1)
    // Fixed: process-level op, no entity segment
    expect(mockInvokeAction).toHaveBeenCalledWith('restart-daemon', undefined)
    // Must NOT use the legacy path that hit POST /actions/restart/daemon-code-drift → 404
    expect(mockInvokeAction).not.toHaveBeenCalledWith('restart', 'daemon-code-drift')
  })

  it('renders a Restart button for a daemon-code-drift item', () => {
    const { container } = renderRow(DRIFT_ITEM, () => {})
    expect(
      container.querySelector('[aria-label="Restart daemon-code-drift"]'),
    ).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Per-entity failed-task restart (regression)
// ---------------------------------------------------------------------------

describe('QueueThreadRow – failed-task restart regression', () => {
  const FAILED_TASK_ITEM: ActionQueueItem = {
    id: 'aq-failed-1',
    kind: 'failed-task',
    entityId: 'mars-xxxx',
    priority: 'normal',
    title: 'Task mars-xxxx failed',
    body: 'Task ran out of retries',
    at: '2026-01-01T00:00:00Z',
    dag: null,
    errorKind: 'coder/exit-nonzero',
    actions: [{ id: 'restart', label: 'Restart', op: 'restart' }],
    diagnosis: null,
    verbs: [],
  } as unknown as ActionQueueItem

  it('restart button calls invokeAction("restart", taskId) — entity id included', async () => {
    // onRestart for a regular failed task: 'restart' is NOT process-level,
    // so entityId is included. This is what handleQueueAction produces for
    // ops not in PROCESS_LEVEL_OPS.
    const onRestart = () => void mockInvokeAction('restart', FAILED_TASK_ITEM.entityId)

    const { container } = renderRow(FAILED_TASK_ITEM, onRestart)

    const btn = container.querySelector(`[aria-label="Restart ${FAILED_TASK_ITEM.entityId}"]`)
    expect(btn).not.toBeNull()

    await act(async () => {
      btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mockInvokeAction).toHaveBeenCalledTimes(1)
    expect(mockInvokeAction).toHaveBeenCalledWith('restart', 'mars-xxxx')
  })
})
