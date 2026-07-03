/**
 * TopologyView is a Canvas/G6 component: it needs a real DOM + canvas and will
 * not render under `renderToStaticMarkup` or jsdom once G6 is constructed. So
 * the testable value lives in the PURE model (see topologyGraphModel.test.ts).
 *
 * Here we cover:
 *  - The empty-state path, which short-circuits BEFORE G6 is ever constructed.
 *  - The non-empty container wrapper attrs (role, aria-label). The wrapper is
 *    pure JSX — G6 is only instantiated inside useEffect, which `renderToStaticMarkup`
 *    does not invoke, so these tests are safe under the static renderer.
 *
 * We do NOT attempt to instantiate G6 in tests.
 */

import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ProgressProposalNode, ProgressTask } from '@/shared/schemas'
import { TopologyView } from './TopologyView'

const noTasks: ProgressTask[] = []
const noProposals: ProgressProposalNode[] = []

const stubTask = (id: string): ProgressTask => ({
  id,
  prompt: `Task ${id}`,
  status: 'queued',
  plan: null,
  branch: null,
  worktreePath: null,
  error: null,
  dropReason: null,
  retryCount: 0,
  blockerTaskId: null,
  blockedBy: [],
  spec: null,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  cluster: 'Queued',
  parentProposalId: null,
})

describe('TopologyView – empty state', () => {
  it('renders the empty-state message when there are no tasks', () => {
    const html = renderToStaticMarkup(<TopologyView tasks={noTasks} proposals={noProposals} />)
    expect(html).toContain('No active tasks')
  })

  it('does not construct any canvas/graph chrome in the empty state', () => {
    // The empty path returns a plain <main> with a <p>; no graph container.
    const html = renderToStaticMarkup(<TopologyView tasks={noTasks} proposals={noProposals} />)
    expect(html).not.toContain('dag-canvas')
    expect(html.length).toBeGreaterThan(0)
  })

  it('renders empty state regardless of the optional toolbar props', () => {
    const html = renderToStaticMarkup(
      <TopologyView
        tasks={noTasks}
        proposals={noProposals}
        selectedProposalId="p1"
        searchMatchIds={new Set(['x'])}
        onSelectProposal={() => {}}
      />,
    )
    expect(html).toContain('No active tasks')
  })
})

describe('TopologyView – graph rebuild gate (structural signature)', () => {
  // The component uses structuralSignature as the mount-effect dependency so
  // that cluster/status flips do NOT destroy and recreate the G6 graph.
  // G6 cannot be instantiated in this environment, but we can verify the
  // structural signature behaves correctly via the model — and that the
  // component renders without error when a task cluster changes mid-life.

  it('renders the canvas container with the same aria-label regardless of task cluster', () => {
    const htmlQueued = renderToStaticMarkup(
      <TopologyView tasks={[{ ...stubTask('t-1'), cluster: 'Queued' }]} proposals={noProposals} />,
    )
    const htmlBlocked = renderToStaticMarkup(
      <TopologyView tasks={[{ ...stubTask('t-1'), cluster: 'Blocked' }]} proposals={noProposals} />,
    )
    // Same task count → same aria-label; cluster change is visual-only
    expect(htmlQueued).toContain('role="img"')
    expect(htmlBlocked).toContain('role="img"')
    expect(htmlQueued).toContain('1 task')
    expect(htmlBlocked).toContain('1 task')
  })
})

describe('TopologyView – layout affordance', () => {
  // isLayoutReady starts false (graph.render() hasn't resolved yet in the static
  // renderer — no effects run).  The "laying out…" overlay should therefore be
  // present in the initial SSR markup and act as a pointer-events:none shield so
  // the canvas canvas below doesn't accidentally capture clicks before layout
  // positions are committed.
  it('renders the laying-out affordance before the graph has settled', () => {
    const html = renderToStaticMarkup(
      <TopologyView tasks={[stubTask('t-1')]} proposals={noProposals} />,
    )
    expect(html).toContain('laying out')
  })

  it('does not show the laying-out affordance in the empty state', () => {
    // Empty state short-circuits before the canvas is rendered; no overlay.
    const html = renderToStaticMarkup(<TopologyView tasks={noTasks} proposals={noProposals} />)
    expect(html).not.toContain('laying out')
  })
})

describe('TopologyView – accessible canvas container', () => {
  it('exposes the canvas container as an image landmark for assistive technology', () => {
    const html = renderToStaticMarkup(
      <TopologyView tasks={[stubTask('t-1')]} proposals={noProposals} />,
    )
    expect(html).toContain('role="img"')
  })

  it('includes the task count in the accessible label', () => {
    const html = renderToStaticMarkup(
      <TopologyView tasks={[stubTask('t-1'), stubTask('t-2')]} proposals={noProposals} />,
    )
    expect(html).toContain('2 tasks')
  })

  it('uses singular "task" when only one task is present', () => {
    const html = renderToStaticMarkup(
      <TopologyView tasks={[stubTask('t-1')]} proposals={noProposals} />,
    )
    expect(html).toContain('1 task')
    expect(html).not.toContain('1 tasks')
  })

  it('points to the Board tab as the accessible alternative', () => {
    const html = renderToStaticMarkup(
      <TopologyView tasks={[stubTask('t-1')]} proposals={noProposals} />,
    )
    expect(html).toContain('Board tab')
  })
})

// ---------------------------------------------------------------------------
// Zero-state search overlay
// ---------------------------------------------------------------------------

describe('TopologyView – zero-state search overlay', () => {
  it('shows a "0 tasks match" pill when the search set is empty', () => {
    const html = renderToStaticMarkup(
      <TopologyView
        tasks={[stubTask('t-1')]}
        proposals={noProposals}
        searchMatchIds={new Set()}
        searchQuery="zzzznonexistent"
      />,
    )
    expect(html).toContain('0 tasks match')
    expect(html).toContain('zzzznonexistent')
  })

  it('includes a testid on the zero-state pill for reliable selection', () => {
    const html = renderToStaticMarkup(
      <TopologyView
        tasks={[stubTask('t-1')]}
        proposals={noProposals}
        searchMatchIds={new Set()}
        searchQuery="nope"
      />,
    )
    expect(html).toContain('data-testid="search-zero-state"')
  })

  it('does not show the zero-state pill when the search set has matches', () => {
    const html = renderToStaticMarkup(
      <TopologyView
        tasks={[stubTask('t-1')]}
        proposals={noProposals}
        searchMatchIds={new Set(['t-1'])}
        searchQuery="task"
      />,
    )
    expect(html).not.toContain('0 tasks match')
  })

  it('does not show the zero-state pill when there is no active search (searchMatchIds is null)', () => {
    const html = renderToStaticMarkup(
      <TopologyView
        tasks={[stubTask('t-1')]}
        proposals={noProposals}
        searchMatchIds={null}
      />,
    )
    expect(html).not.toContain('0 tasks match')
  })
})

// ---------------------------------------------------------------------------
// Navigation hint overlay — completeness + legibility
// ---------------------------------------------------------------------------

describe('TopologyView – navigation hint overlay', () => {
  it('names every interaction in the click model, not just double-click', () => {
    // The hint must document the three interactions the view actually supports:
    // double-click on a combo, single-click on a task, and Esc to collapse.
    const html = renderToStaticMarkup(
      <TopologyView tasks={[stubTask('t-1')]} proposals={noProposals} />,
    )
    expect(html).toContain('double-click')
    expect(html).toContain('click task')
    expect(html.toLowerCase()).toContain('esc')
  })

  it('uses a text size >= 11px and a token that clears AA contrast on the light bg', () => {
    // The prior overlay was 10.5px in text-muted-dark (#A89684 → ~2.5:1 on
    // --color-bg). It must now be >=11px and coloured with text-muted
    // (#705F50 → 4.9:1 on --color-bg) so it meets WCAG AA. No opacity dampener
    // either — that silently drops effective contrast back under the threshold.
    const html = renderToStaticMarkup(
      <TopologyView tasks={[stubTask('t-1')]} proposals={noProposals} />,
    )
    // The hint is the div containing the always-on 'scroll = zoom · drag = pan'.
    // Extract just its class attribute so unrelated overlays don't confound.
    const match = html.match(/class="([^"]*)"[^>]*>[^<]*scroll = zoom/)
    expect(match).not.toBeNull()
    const cls = match?.[1] ?? ''
    expect(cls).toContain('text-[11px]')
    expect(cls).not.toContain('text-[10.5px]')
    expect(cls).toContain('text-muted')
    expect(cls).not.toContain('text-muted-dark')
    expect(cls).not.toContain('opacity-70')
  })
})
