/**
 * Happy-dom DOM tests for the Grill button in ProposalDetailDrawer.
 *
 * These run under the `dom` vitest project (happy-dom environment) so they
 * can exercise actual click events and observe window.location.hash mutations.
 *
 * The critical regression case: clicking Grill must navigate to
 * #/chat?thread=<id> and must NOT call onClose() afterwards.  In the bug that
 * prompted this test, handleGrill called handleClose() after navigateToThread(),
 * scheduling onClose() 180 ms later.  onClose() then called
 * navigateReplace('#/progress'), overwriting the chat destination.
 */

import { describe, expect, it, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ProposalDetailDrawer } from './ProposalDetailDrawer'
import type { ProposalDetail } from '@/shared/schemas'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const draftProposal = (overrides: Partial<ProposalDetail> = {}): ProposalDetail => ({
  id: 'prop-grill',
  title: 'Grill nav test proposal',
  problem: '',
  solution: '',
  outOfScope: '',
  notes: '',
  status: 'draft',
  source: 'reflection',
  author: null,
  createdAt: 0,
  updatedAt: 0,
  userStories: [],
  ...overrides,
})

afterEach(() => {
  vi.unstubAllGlobals()
  // Reset hash so tests are independent.
  window.location.hash = ''
})

// ---------------------------------------------------------------------------
// Grill navigation tests
// ---------------------------------------------------------------------------

describe('ProposalDetailDrawer – Grill button post-navigation', () => {
  it('sets window.location.hash to #/chat?thread=<id> on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ threadId: 'thread-42' }),
    }))

    const onClose = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(<ProposalDetailDrawer proposal={draftProposal()} onClose={onClose} />)
      })

      const grillBtn = container.querySelector('[data-testid="btn-grill"]') as HTMLButtonElement
      expect(grillBtn).not.toBeNull()

      await act(async () => {
        grillBtn.click()
      })

      // The hash must point at the newly created thread.
      expect(window.location.hash).toBe('#/chat?thread=thread-42')
    } finally {
      await act(async () => { root.unmount() })
      document.body.removeChild(container)
    }
  })

  it('does NOT call onClose after a successful Grill — onClose would overwrite the navigation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ threadId: 'thread-99' }),
    }))

    const onClose = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(<ProposalDetailDrawer proposal={draftProposal()} onClose={onClose} />)
      })

      const grillBtn = container.querySelector('[data-testid="btn-grill"]') as HTMLButtonElement

      await act(async () => {
        grillBtn.click()
      })

      // Give any stray timers a chance to fire (180 ms was the old handleClose delay).
      await new Promise((r) => setTimeout(r, 250))

      expect(onClose).not.toHaveBeenCalled()
    } finally {
      await act(async () => { root.unmount() })
      document.body.removeChild(container)
    }
  })

  it('calls the proposals thread API with the correct proposal id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ threadId: 'thread-7' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(
          <ProposalDetailDrawer
            proposal={draftProposal({ id: 'my-prop' })}
            onClose={() => {}}
          />,
        )
      })

      const grillBtn = container.querySelector('[data-testid="btn-grill"]') as HTMLButtonElement

      await act(async () => {
        grillBtn.click()
      })

      // Exactly one POST call to the proposals thread endpoint.
      const call = fetchMock.mock.calls.find(([url]: [string]) =>
        (url as string).includes('/api/proposals/my-prop/thread'),
      )
      expect(call).toBeDefined()
      expect((call as [string, RequestInit])[1].method).toBe('POST')
    } finally {
      await act(async () => { root.unmount() })
      document.body.removeChild(container)
    }
  })
})
