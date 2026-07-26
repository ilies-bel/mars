// @vitest-environment happy-dom
/**
 * ActionQueueRow — copy-op behaviour tests.
 *
 * Verifies that a verb with `op: 'copy'` is handled client-side (clipboard
 * write) and does NOT call invokeAction / make any network request.
 *
 * The fixture uses a draft-proposal row whose legacy `actions` array carries
 * `{ op: 'copy', hint: '/mars:grill <id>' }` — the exact descriptor the
 * backend emits for the "Move forward" action on proposal rows.
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
