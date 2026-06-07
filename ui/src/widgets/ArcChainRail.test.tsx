/**
 * ArcChainRail unit tests.
 *
 * Rendering strategy: `renderToStaticMarkup` (synchronous SSR) so no JSDOM or
 * @testing-library is required. Click behaviour is validated by rendering the
 * component with `initialSelectedId` set to the target node — the equivalent
 * of the post-click state — and asserting on the `data-node-id` attribute of
 * the detail aside.
 *
 * React Query needs a provider even for disabled queries; we wrap every render
 * in a fresh QueryClient so hooks initialise cleanly.
 *
 * `useFocusedProjectId` is mocked to return `null` so all trace-event queries
 * are disabled (enabled: false) — no API calls are attempted and the panel
 * renders its loading-placeholder safely.
 */
import { describe, expect, it, mock } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ArcChainRail from './ArcChainRail'
import type { AlertChainNode } from '@/shared/schemas'

// Disable project-aware queries so no API calls are attempted in tests.
mock.module('@/shared/useFocusedProject', () => ({
  useFocusedProjectId: () => null,
}))

/** Wraps the element in a fresh QueryClient so React Query hooks initialise. */
const wrap = (el: JSX.Element): string =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      {el}
    </QueryClientProvider>,
  )

const fourNodeChain: AlertChainNode[] = [
  { kind: 'proposal', id: 'prop-1', label: 'Proposal Alpha' },
  {
    kind: 'task',
    id: 'task-1',
    label: 'Attempt one prompt',
    attemptIndex: 1,
    status: 'failed',
  },
  {
    kind: 'task',
    id: 'task-2',
    label: 'Attempt two prompt',
    attemptIndex: 2,
    status: 'failed',
  },
  {
    kind: 'task',
    id: 'task-3',
    label: 'Attempt three prompt',
    attemptIndex: 3,
    status: 'failed',
  },
]

describe('ArcChainRail – 4-node chain (proposal + 3 task attempts)', () => {
  it('renders all 4 node labels in the rail', () => {
    const html = wrap(<ArcChainRail chain={fourNodeChain} />)
    expect(html).toContain('Proposal Alpha')
    expect(html).toContain('Attempt one prompt')
    expect(html).toContain('Attempt two prompt')
    expect(html).toContain('Attempt three prompt')
  })

  it('selects the first task node by default', () => {
    const html = wrap(<ArcChainRail chain={fourNodeChain} />)
    // The detail aside carries data-node-id for the selected task.
    expect(html).toContain('data-node-id="task-1"')
    expect(html).not.toContain('data-node-id="task-3"')
  })

  it('clicking the 3rd attempt swaps the detail panel content to that task prompt', () => {
    // Render with 3rd attempt selected (simulates post-click state).
    const html = wrap(
      <ArcChainRail chain={fourNodeChain} initialSelectedId="task-3" />,
    )
    // The detail aside now belongs to task-3.
    expect(html).toContain('data-node-id="task-3"')
    // task-1 is no longer in the detail aside.
    expect(html).not.toContain('data-node-id="task-1"')
    // task-3's prompt is rendered in the detail pane.
    expect(html).toContain('Attempt three prompt')
  })
})

describe('ArcChainRail – 1-node fallback chain', () => {
  it('renders without any "No origin recorded" string in the DOM', () => {
    const singleNode: AlertChainNode[] = [
      {
        kind: 'task',
        id: 'lone-task',
        label: 'Standalone task prompt',
        status: 'failed',
      },
    ]
    const html = wrap(<ArcChainRail chain={singleNode} />)
    expect(html).not.toContain('No origin recorded')
  })
})
