/**
 * TopologyView renders React Flow, which is SSR-safe: the pure JSX (wrapper
 * attrs, overlays) renders under `renderToStaticMarkup`; interaction and
 * viewport behaviour live in effects that the static renderer never runs. The
 * layout/model logic is covered separately in topologyFlowModel.test.ts.
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

describe('TopologyView – rebuild gate (structural signature)', () => {
  // structuralSignature gates the fitView camera reset so cluster/status
  // flips never yank the viewport; the aria-label depends only on task count.

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
  it('names every interaction in the click model', () => {
    // The hint must document the three interactions the view actually supports:
    // single-click on a card, single-click on a task, and Esc to collapse.
    const html = renderToStaticMarkup(
      <TopologyView tasks={[stubTask('t-1')]} proposals={noProposals} />,
    )
    expect(html).toContain('click card')
    expect(html).toContain('click task')
    expect(html.toLowerCase()).toContain('esc')
  })

  it('uses a text size >= 11px and a token that clears AA contrast on the light bg', () => {
    // The prior overlay was 10.5px in text-muted-dark (#A89684 → ~2.5:1 on
    // --color-bg). It must now be >=11px and coloured with text-muted-foreground
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
    expect(cls).toContain('text-muted-foreground')
    expect(cls).not.toContain('text-muted-dark')
    expect(cls).not.toContain('opacity-70')
  })
})

// ---------------------------------------------------------------------------
// Proposal filter — topology must narrow like the Board tab
// ---------------------------------------------------------------------------

describe('TopologyView – proposal filter', () => {
  it('hides tasks from other proposals when selectedProposalId is set', () => {
    // Two proposals' worth of tasks: p1 has 2, p2 has 1.
    // Selecting p1 must exclude p2's task from the canvas entirely.
    const allTasks: ProgressTask[] = [
      { ...stubTask('t-p1a'), parentProposalId: 'p1' },
      { ...stubTask('t-p1b'), parentProposalId: 'p1' },
      { ...stubTask('t-p2a'), parentProposalId: 'p2' },
    ]

    const html = renderToStaticMarkup(
      <TopologyView tasks={allTasks} proposals={noProposals} selectedProposalId="p1" />,
    )

    // Only p1's 2 tasks are fed to the topology; the aria-label must reflect that.
    expect(html).toContain('2 tasks')
    expect(html).not.toContain('3 tasks')
  })

  it('renders every arc when selectedProposalId is null', () => {
    const tasks: ProgressTask[] = [
      { ...stubTask('t-p1a'), parentProposalId: 'p1' },
      { ...stubTask('t-p2a'), parentProposalId: 'p2' },
    ]

    const html = renderToStaticMarkup(
      <TopologyView tasks={tasks} proposals={noProposals} selectedProposalId={null} />,
    )

    // Full graph: both tasks present.
    expect(html).toContain('2 tasks')
  })
})

// ---------------------------------------------------------------------------
// Minimap navigation aid — presence and CSS class
// ---------------------------------------------------------------------------

describe('TopologyView – minimap navigation aid', () => {
  it('renders the minimap with the topo-minimap class when tasks are present', () => {
    // The topo-minimap class is what connects the MiniMap component to the CSS
    // rules that give it a drop shadow and keep it clear of the footer bar and
    // zoom controls. Without this class the positioning overrides (bottom: 60px,
    // right: 16px, box-shadow) would not apply and the minimap could overlap
    // with task cards in a busy graph.
    const html = renderToStaticMarkup(
      <TopologyView tasks={[stubTask('t-1')]} proposals={noProposals} />,
    )
    expect(html).toContain('topo-minimap')
  })

  it('does not render the minimap in the empty state', () => {
    // The empty-state path returns early with a plain <main> — no canvas, no
    // minimap. The minimap class should therefore be absent.
    const html = renderToStaticMarkup(<TopologyView tasks={[]} proposals={noProposals} />)
    expect(html).not.toContain('topo-minimap')
  })
})
