// @vitest-environment happy-dom
/**
 * What the Needs-you page says when the daemon is not running.
 *
 * This is the highest-stakes moment the page has: the operator's whole picture
 * of the system is unavailable, and the page must not fill the silence with
 * reassurance. Rendering "All quiet — nothing running" over a dead daemon is
 * the same failure as reporting an empty inbox because the mail server is
 * down.
 *
 * These tests drive the REAL useActionQueue / useProposals hooks (only `fetch`
 * is stubbed) so they exercise the actual error plumbing rather than a mock of
 * it.
 */

import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { FocusedProjectProvider } from '@/shared/useFocusedProject'
import { TriagePage } from './TriagePage'

const NO_DAEMON_BODY = JSON.stringify({
  ok: false,
  error: 'daemon not running',
  errorCode: 'NO_DAEMON',
})

/**
 * Mirrors the live server exactly: /api/projects is served by the mars-ui
 * server's own registry and keeps answering 200 (with health:'down') while
 * every daemon-backed route 503s. This asymmetry is what made the bug
 * invisible — the page had a project id, so its queries ran and failed.
 */
const daemonDownFetch = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input)
  if (url.includes('/api/projects')) {
    return new Response(
      JSON.stringify({
        projects: [
          {
            projectId: 'p_test',
            repoRoot: '/repo',
            name: 'repo',
            health: 'down',
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  return new Response(NO_DAEMON_BODY, {
    status: 503,
    headers: { 'content-type': 'application/json' },
  })
})

let container: HTMLElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  vi.stubGlobal('fetch', daemonDownFetch)
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  vi.unstubAllGlobals()
  daemonDownFetch.mockClear()
})

const renderPage = async (): Promise<void> => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <FocusedProjectProvider>
          <TriagePage />
        </FocusedProjectProvider>
      </QueryClientProvider>,
    )
  })
  // Let the queries reject and the error state settle.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

describe('TriagePage with the daemon down', () => {
  it('does not claim all is quiet', async () => {
    await renderPage()
    expect(container.textContent).not.toContain('All quiet')
    expect(container.textContent).not.toContain('nothing running')
  })

  it('says the daemon is unreachable, and how to fix it', async () => {
    await renderPage()
    expect(container.textContent).toContain("Can't reach the Mars daemon")
    expect(container.textContent).toContain('mars daemon start')
  })

  it('does not advise restarting a daemon that is not running', async () => {
    await renderPage()
    // The old generic card said "try refreshing or restarting the daemon" for
    // every failure kind, which is useless advice when the daemon is stopped.
    expect(container.textContent).not.toContain('try refreshing or restarting')
  })
})
