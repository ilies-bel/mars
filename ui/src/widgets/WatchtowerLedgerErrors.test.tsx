// @vitest-environment happy-dom
/**
 * The ledger widgets must not turn a rejected API query into a misleading
 * empty state. Fetch is the system boundary; the hooks and widgets are real.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { LoopLedgerPanel } from './LoopLedgerPanel'
import { PromotionLedgerTable } from './PromotionLedgerTable'

const renderAfterRejectedQuery = async (
  element: React.ReactNode,
  expectedPath: string,
): Promise<string> => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'))
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  queryClient.setQueryData(['scorer-workflows'], { workflows: ['implement'] })
  const div = document.createElement('div')
  const root = createRoot(div)
  document.body.appendChild(div)

  await act(async () => {
    root.render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  expect(fetchSpy.mock.calls[0]?.[0]).toContain(expectedPath)
  const html = div.innerHTML
  await act(async () => root.unmount())
  document.body.removeChild(div)
  fetchSpy.mockRestore()
  return html
}

afterEach(() => vi.restoreAllMocks())

describe('Watchtower ledger query failures', () => {
  it('renders an error rather than an empty promotion ledger', async () => {
    const html = await renderAfterRejectedQuery(<PromotionLedgerTable />, '/api/promotion-ledger')

    expect(html).toContain("Couldn't load promotions")
    expect(html).not.toContain('No promotions yet')
  })

  it('renders an error rather than an empty loop ledger', async () => {
    const html = await renderAfterRejectedQuery(
      <LoopLedgerPanel />,
      '/api/loop-ledger?workflow=implement&limit=50',
    )

    expect(html).toContain("Couldn't load loop ledger")
    expect(html).not.toContain('No loop runs yet')
  })
})
