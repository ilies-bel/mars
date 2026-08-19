/**
 * Behaviour test for ControlRoomPage's NOW block dispatch indicator.
 *
 * TopStripe's health dot already has dedicated coverage (TopStripe.test.tsx)
 * for "never show green 'live' while dispatch is paused". This page has its
 * own, separately-written copy of that same dot inside NowSection — it does
 * not delegate to TopStripe — so a regression there is invisible to the
 * TopStripe suite. This is literally the second symptom named in the bug
 * report ("Control Room's own NOW block, directly below the PAUSED lever,
 * also showed a green Live"), so it gets its own assertion.
 */
import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ControlRoomPage } from './ControlRoomPage'

// LeversSection queries fetchOperatorState directly via useQuery, and
// RulesSection queries fetchGlossary/fetchAdrs — none of those resolve
// synchronously, so they stay in their loading state during
// renderToStaticMarkup and never interfere with the NOW block assertions
// below. They're mocked here only so the real network functions are never
// invoked from a test.
vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/api')>()
  return {
    ...actual,
    fetchOperatorState: vi.fn(() => new Promise(() => {})),
    fetchGlossary: vi.fn(() => new Promise(() => {})),
    fetchAdrs: vi.fn(() => new Promise(() => {})),
  }
})

vi.mock('@/hooks/useProgress', () => ({
  useProgress: () => ({ tasks: [], connected: true }),
}))

vi.mock('@/hooks/useStatusCounts', () => ({
  useStatusCounts: () => ({
    running: 0,
    recovering: 0,
    needYou: 0,
    failed: 0,
    doneToday: 0,
    known: true,
  }),
}))

vi.mock('@/entities/actionQueue/useActionQueue', () => ({
  useActionQueue: () => ({ items: [] }),
}))

vi.mock('@/shared/useFocusedProject', () => ({
  useFocusedProject: () => ({ focusedProjectId: null }),
}))

const mockUseDispatchState = vi.fn()
vi.mock('@/entities/operator/useDispatchState', () => ({
  useDispatchState: (...args: unknown[]) => mockUseDispatchState(...args),
  pauseReasonLabel: (state: { reason: string | null }) =>
    state.reason === 'storm' ? 'signature storm' : 'paused',
}))

const renderControlRoom = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(ControlRoomPage)),
  )
}

describe('ControlRoomPage – NOW block dispatch indicator', () => {
  it('does not render the "Live" label when dispatch is paused', () => {
    mockUseDispatchState.mockReturnValue({
      paused: true,
      reason: 'storm',
      since: null,
      detail: null,
    })

    const html = renderControlRoom()

    expect(html).not.toContain('>Live<')
    expect(html).toContain('Paused')
    expect(html).toContain('signature storm')
  })

  it('renders the "Live" label when dispatch is running', () => {
    mockUseDispatchState.mockReturnValue({
      paused: false,
      reason: null,
      since: null,
      detail: null,
    })

    const html = renderControlRoom()

    expect(html).toContain('>Live<')
  })
})
