/**
 * TopologyView renders React Flow, which is SSR-safe: the pure JSX (wrapper
 * attrs, overlays) renders under `renderToStaticMarkup`; interaction and
 * viewport behaviour live in effects that the static renderer never runs. The
 * layout/model logic is covered separately in topologyFlowModel.test.ts.
 *
 * This file runs in the happy-dom project so it can also test interactive
 * behaviour (click events on arc cards) with createRoot + act.
 */

import { describe, expect, it, vi } from 'bun:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
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

// ---------------------------------------------------------------------------
// Arc click model: onSelectProposal gating
//
// Clicking an arc card must call onSelectProposal only when the arc key is a
// real proposal id. Origin arcs are keyed by a task id; propagating that id
// to the parent's proposal filter empties the board because no task has
// parentProposalId === <task-id>.
//
// These tests use createRoot + act (happy-dom environment) to exercise the
// actual click path: user click → React Flow onNodeClick → toggleArc →
// conditional onSelectProposal call.
// ---------------------------------------------------------------------------

describe('TopologyView – arc click model', () => {
  it('clicking an origin arc card does not call onSelectProposal with the task id', async () => {
    const onSelectProposal = vi.fn<[string | null], void>()

    // Two tasks sharing arcKey = 'task-origin-arc' form a multi-task arc that
    // renders as a collapsed arc CARD (not a bare task node).
    const task1: ProgressTask = { ...stubTask('task-origin-arc') }
    const task2: ProgressTask = { ...stubTask('task-recovery-arc'), originId: 'task-origin-arc' }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(
          <TopologyView
            tasks={[task1, task2]}
            proposals={noProposals}
            onSelectProposal={onSelectProposal}
          />,
        )
      })

      // The arc card for the origin arc should be in the DOM.
      const arcCard = container.querySelector('[aria-label*="click to open"]')
      expect(arcCard).not.toBeNull()

      await act(async () => {
        arcCard!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })

      // After the fix: onSelectProposal must NOT be called with the origin
      // task id — that would blank the board by filtering on a non-proposal id.
      expect(onSelectProposal).not.toHaveBeenCalledWith('task-origin-arc')
      expect(onSelectProposal).not.toHaveBeenCalledWith('task-recovery-arc')
    } finally {
      await act(async () => { root.unmount() })
      document.body.removeChild(container)
    }
  })

  it('clicking a proposal-backed arc card calls onSelectProposal with the proposal id', async () => {
    const onSelectProposal = vi.fn<[string | null], void>()

    const proposal: ProgressProposalNode = {
      id: 'test-proposal-arc',
      title: 'Test Proposal',
      source: 'human',
      status: 'draft',
    }
    const task1: ProgressTask = { ...stubTask('tp-arc-1'), parentProposalId: 'test-proposal-arc' }
    const task2: ProgressTask = { ...stubTask('tp-arc-2'), parentProposalId: 'test-proposal-arc' }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(
          <TopologyView
            tasks={[task1, task2]}
            proposals={[proposal]}
            onSelectProposal={onSelectProposal}
          />,
        )
      })

      const arcCard = container.querySelector('[aria-label*="click to open"]')
      expect(arcCard).not.toBeNull()

      await act(async () => {
        arcCard!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })

      // For a proposal arc the callback must be called with the proposal id so
      // the parent's proposal dropdown drills in correctly.
      expect(onSelectProposal).toHaveBeenCalledWith('test-proposal-arc')
    } finally {
      await act(async () => { root.unmount() })
      document.body.removeChild(container)
    }
  })
})
