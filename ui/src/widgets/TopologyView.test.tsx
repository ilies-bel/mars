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
import { structuralSignature } from './topologyFlowModel'
import { TopologyView, visibleLegendItems } from './TopologyView'

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
  recoverySpawnedCount: 0,
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

describe('TopologyView – proposal-filter empty state', () => {
  it('says "for this proposal" when a proposal filter is active and there are no tasks', () => {
    const html = renderToStaticMarkup(
      <TopologyView
        tasks={noTasks}
        proposals={noProposals}
        selectedProposalId="p1"
        onSelectProposal={() => {}}
      />,
    )
    expect(html).toContain('No active tasks for this proposal')
  })

  it('shows bare "No active tasks" when no proposal filter is set', () => {
    const html = renderToStaticMarkup(<TopologyView tasks={noTasks} proposals={noProposals} />)
    // Must not include "for this proposal" — that phrase only appears when a filter is active.
    expect(html).not.toContain('for this proposal')
    expect(html).toContain('No active tasks')
  })

  it('renders a clear-filter button with the correct testid when the proposal filter is active', () => {
    const html = renderToStaticMarkup(
      <TopologyView
        tasks={noTasks}
        proposals={noProposals}
        selectedProposalId="p1"
        onSelectProposal={() => {}}
      />,
    )
    expect(html).toContain('data-testid="clear-proposal-filter"')
  })

  it('does not render the clear-filter button when there is no proposal filter', () => {
    const html = renderToStaticMarkup(<TopologyView tasks={noTasks} proposals={noProposals} />)
    expect(html).not.toContain('data-testid="clear-proposal-filter"')
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
  it('shows a "no match" pill when the search set is empty', () => {
    const html = renderToStaticMarkup(
      <TopologyView
        tasks={[stubTask('t-1')]}
        proposals={noProposals}
        searchMatchIds={new Set()}
        searchQuery="zzzznonexistent"
      />,
    )
    expect(html).toContain('No task or proposal matches')
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
    expect(html).not.toContain('No task or proposal matches')
  })

  it('does not show the zero-state pill when there is no active search (searchMatchIds is null)', () => {
    const html = renderToStaticMarkup(
      <TopologyView
        tasks={[stubTask('t-1')]}
        proposals={noProposals}
        searchMatchIds={null}
      />,
    )
    expect(html).not.toContain('No task or proposal matches')
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
    expect(cls).toContain('text-label')
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

describe('TopologyView – no minimap', () => {
  it('draws no minimap, in any state', () => {
    // It was an unlabelled 180x120 panel pinned bottom-right, and measured on
    // a live graph it covered a task card outright — the very thing the CSS
    // it carried was written to prevent. It also had nothing to navigate: the
    // view opens fitted, so the whole graph is already on screen.
    for (const tasks of [[], [stubTask('t-1')]]) {
      const html = renderToStaticMarkup(
        <TopologyView tasks={tasks} proposals={noProposals} />,
      )
      expect(html).not.toContain('topo-minimap')
      expect(html).not.toContain('react-flow__minimap')
    }
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

// ---------------------------------------------------------------------------
// Search isolation: arc expansion while search is active
//
// When a search query is active, clicking an arc card must NOT call
// onSelectProposal — the proposal filter must stay unset so the matched task
// remains visible alongside all other tasks. Without this guard the topology
// switches to single-proposal mode and the URL gains an unwanted ?proposal=.
// ---------------------------------------------------------------------------

describe('TopologyView – search isolation: arc click while search active', () => {
  it('does not call onSelectProposal when clicking a proposal arc card while search is active', async () => {
    const onSelectProposal = vi.fn<[string | null], void>()

    const proposal: ProgressProposalNode = {
      id: 'p-search-test',
      title: 'Search Isolation Proposal',
      source: 'human',
      status: 'draft',
    }
    const task1: ProgressTask = { ...stubTask('t-match'), parentProposalId: 'p-search-test' }
    const task2: ProgressTask = { ...stubTask('t-other'), parentProposalId: 'p-search-test' }

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
            // Active search: matches t-match and its parent proposal
            searchMatchIds={new Set(['t-match', 'p-search-test'])}
            searchQuery="t-match"
          />,
        )
      })

      const arcCard = container.querySelector('[aria-label*="click to open"]')
      expect(arcCard).not.toBeNull()

      await act(async () => {
        arcCard!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })

      // The proposal filter must NOT be set while search is active — arc
      // expansion is local only and the URL must stay free of ?proposal=.
      expect(onSelectProposal).not.toHaveBeenCalled()
    } finally {
      await act(async () => { root.unmount() })
      document.body.removeChild(container)
    }
  })

  it('still calls onSelectProposal when clicking a proposal arc card with no active search', async () => {
    // Regression guard: the baseline behaviour (no search) must be preserved.
    const onSelectProposal = vi.fn<[string | null], void>()

    const proposal: ProgressProposalNode = {
      id: 'p-no-search',
      title: 'No Search Proposal',
      source: 'human',
      status: 'draft',
    }
    const task1: ProgressTask = { ...stubTask('t-ns-1'), parentProposalId: 'p-no-search' }
    const task2: ProgressTask = { ...stubTask('t-ns-2'), parentProposalId: 'p-no-search' }

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
            // No active search
            searchMatchIds={null}
            searchQuery=""
          />,
        )
      })

      const arcCard = container.querySelector('[aria-label*="click to open"]')
      expect(arcCard).not.toBeNull()

      await act(async () => {
        arcCard!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })

      expect(onSelectProposal).toHaveBeenCalledWith('p-no-search')
    } finally {
      await act(async () => { root.unmount() })
      document.body.removeChild(container)
    }
  })
})

// ---------------------------------------------------------------------------
// Search isolation: Escape key while an input is focused
//
// The TopologyView's window-level Escape handler must NOT collapse the arc
// when an input element (e.g. the Progress search box) has keyboard focus.
// ---------------------------------------------------------------------------

describe('TopologyView – Escape key isolation from editable targets', () => {
  it('does not call onSelectProposal when Escape is dispatched from an input', async () => {
    const onSelectProposal = vi.fn<[string | null], void>()

    const proposal: ProgressProposalNode = {
      id: 'p-esc-test',
      title: 'Escape Test Proposal',
      source: 'human',
      status: 'draft',
    }
    const task1: ProgressTask = { ...stubTask('t-esc-1'), parentProposalId: 'p-esc-test' }
    const task2: ProgressTask = { ...stubTask('t-esc-2'), parentProposalId: 'p-esc-test' }

    const container = document.createElement('div')
    document.body.appendChild(container)
    // A search input outside the topology canvas (sibling in the real layout)
    const searchInput = document.createElement('input')
    searchInput.type = 'text'
    document.body.appendChild(searchInput)
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

      // Open the arc first so collapse() has something to do
      const arcCard = container.querySelector('[aria-label*="click to open"]')
      expect(arcCard).not.toBeNull()

      await act(async () => {
        arcCard!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })

      // Arc opened → onSelectProposal called once with the proposal id
      expect(onSelectProposal).toHaveBeenCalledWith('p-esc-test')
      onSelectProposal.mockClear()

      // Simulate Escape dispatched from a search input (target = INPUT element)
      await act(async () => {
        searchInput.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        )
      })

      // Escape from an input must NOT trigger collapse → onSelectProposal must
      // NOT be called a second time (with null).
      expect(onSelectProposal).not.toHaveBeenCalled()
    } finally {
      await act(async () => { root.unmount() })
      document.body.removeChild(container)
      document.body.removeChild(searchInput)
    }
  })

  it('does call onSelectProposal(null) when Escape is dispatched from the document body (non-input)', async () => {
    // Regression guard: pressing Escape NOT in an input still collapses.
    const onSelectProposal = vi.fn<[string | null], void>()

    const proposal: ProgressProposalNode = {
      id: 'p-esc-body',
      title: 'Escape Body Test',
      source: 'human',
      status: 'draft',
    }
    const task1: ProgressTask = { ...stubTask('t-eb-1'), parentProposalId: 'p-esc-body' }
    const task2: ProgressTask = { ...stubTask('t-eb-2'), parentProposalId: 'p-esc-body' }

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

      // Open the arc
      const arcCard = container.querySelector('[aria-label*="click to open"]')
      expect(arcCard).not.toBeNull()

      await act(async () => {
        arcCard!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })

      onSelectProposal.mockClear()

      // Escape from the body (target = BODY, not an input) must still collapse
      await act(async () => {
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        )
      })

      expect(onSelectProposal).toHaveBeenCalledWith(null)
    } finally {
      await act(async () => { root.unmount() })
      document.body.removeChild(container)
    }
  })
})

// ---------------------------------------------------------------------------
// Task node click → correct URL hash (from=progress)
//
// Clicking a bare task node must navigate to #/task/<id>?from=progress, not a
// bare #/task/<id>. The `from=progress` param is what lets the drawer's Close
// button return to the Progress page correctly, and it is what `taskHash`
// encodes when called with from='progress'.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fit-view gate: structuralSignature must change when nodes enter/leave the
// rendered graph so the viewport is re-centred after completions.
//
// buildTopology excludes Done tasks from the rendered graph. If
// structuralSignature ignores Done, the fitKey never changes on completion,
// the viewport stays pinned at its old transform, and the graph drifts to
// the top-left corner over time.
// ---------------------------------------------------------------------------

describe('TopologyView – fitView gate sensitivity (structuralSignature)', () => {
  it('structural signature changes when a task transitions to Done', () => {
    // When a task becomes Done, buildTopology removes its node from the graph.
    // The structuralSignature must reflect this removal so fitKey changes and
    // fitView is triggered to re-centre the (now smaller) graph.
    const activeTask = stubTask('t1') // cluster: 'Queued'
    const doneTask = { ...stubTask('t1'), cluster: 'Done' as const }

    const sigActive = structuralSignature([activeTask], [])
    const sigDone = structuralSignature([doneTask], [])

    expect(sigActive).not.toBe(sigDone)
  })

  it('structural signature does not change when a task shifts between non-Done statuses', () => {
    // A Queued→Blocked or Queued→Failed transition is a colour-only change;
    // the node stays on the canvas at the same position. Re-fitting would
    // yank the viewport without moving any content, so the signature must be
    // stable for these transitions.
    const queued = stubTask('t1') // cluster: 'Queued'
    const blocked = { ...stubTask('t1'), cluster: 'Blocked' as const }
    const failed = { ...stubTask('t1'), cluster: 'Failed' as const }
    const inProgress = { ...stubTask('t1'), cluster: 'In progress' as const }

    const sigQueued = structuralSignature([queued], [])
    expect(structuralSignature([blocked], [])).toBe(sigQueued)
    expect(structuralSignature([failed], [])).toBe(sigQueued)
    expect(structuralSignature([inProgress], [])).toBe(sigQueued)
  })
})

// ---------------------------------------------------------------------------
// Canvas re-renders correctly after task removal (node count update)
// ---------------------------------------------------------------------------

describe('TopologyView – canvas updates after task removal', () => {
  it('updates the aria-label task count when a task is removed', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(
          <TopologyView
            tasks={[stubTask('t1'), stubTask('t2'), stubTask('t3')]}
            proposals={noProposals}
          />,
        )
      })

      // Three tasks → aria-label says "3 tasks"
      const canvas = container.querySelector('[role="img"]')
      expect(canvas?.getAttribute('aria-label')).toContain('3 tasks')

      // Remove one task (simulates it reaching terminal status and leaving the projection)
      await act(async () => {
        root.render(
          <TopologyView
            tasks={[stubTask('t1'), stubTask('t2')]}
            proposals={noProposals}
          />,
        )
      })

      // Canvas must still be present (not the empty state)
      expect(container.querySelector('[role="img"]')).not.toBeNull()
      expect(container.textContent).not.toContain('No active tasks')
      // Aria-label must reflect the new count
      expect(container.querySelector('[role="img"]')?.getAttribute('aria-label')).toContain('2 tasks')
    } finally {
      await act(async () => { root.unmount() })
      document.body.removeChild(container)
    }
  })

  it('transitions to empty state when the last task is removed', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(<TopologyView tasks={[stubTask('t1')]} proposals={noProposals} />)
      })
      expect(container.querySelector('[role="img"]')).not.toBeNull()

      await act(async () => {
        root.render(<TopologyView tasks={[]} proposals={noProposals} />)
      })

      expect(container.textContent).toContain('No active tasks')
      expect(container.querySelector('[role="img"]')).toBeNull()
    } finally {
      await act(async () => { root.unmount() })
      document.body.removeChild(container)
    }
  })
})

// ---------------------------------------------------------------------------
// Arc drill-in produces the breadcrumb so the canvas is demonstrably
// centred-on-expanded-group (breadcrumb = observable signal that the group
// rendered in the expanded state, which is the precondition for a correct fit).
// ---------------------------------------------------------------------------

describe('TopologyView – arc drill-in breadcrumb', () => {
  it('shows the arc label in the breadcrumb chip when an arc card is opened', async () => {
    const proposal: ProgressProposalNode = {
      id: 'p-drill',
      title: 'Drill-in proposal',
      source: 'human',
      status: 'draft',
    }
    const task1: ProgressTask = { ...stubTask('pd-1'), parentProposalId: 'p-drill' }
    const task2: ProgressTask = { ...stubTask('pd-2'), parentProposalId: 'p-drill' }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(
          <TopologyView
            tasks={[task1, task2]}
            proposals={[proposal]}
            onSelectProposal={() => {}}
          />,
        )
      })

      // Click the arc card to drill in
      const arcCard = container.querySelector('[aria-label*="click to open"]')
      expect(arcCard).not.toBeNull()

      await act(async () => {
        arcCard!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })

      // After drill-in, the breadcrumb chip must contain the proposal title
      // and the collapse hint. This is the observable signal that the expanded
      // arc group rendered (prerequisite for a correct fitView call).
      expect(container.textContent).toContain('Drill-in proposal')
      expect(container.textContent?.toLowerCase()).toContain('esc to collapse')
    } finally {
      await act(async () => { root.unmount() })
      document.body.removeChild(container)
    }
  })
})

describe('TopologyView – task node click produces task hash with from=progress', () => {
  it('clicking a task node sets window.location.hash to #/task/<id>?from=progress', async () => {
    const task = stubTask('click-test-task')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    // Capture the pre-test hash so we can restore it in finally.
    const priorHash = window.location.hash

    try {
      await act(async () => {
        root.render(<TopologyView tasks={[task]} proposals={noProposals} />)
      })

      // Task nodes carry aria-label of the form "<label> · <cluster>".
      // A single task with cluster='Queued' produces "Task click-test-task · queued".
      const taskNode = container.querySelector('[aria-label$="· queued"]')
      expect(taskNode).not.toBeNull()

      await act(async () => {
        taskNode!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })

      // Must include from=progress so the drawer knows to return to the
      // Progress page on close — not a bare #/task/<id>.
      expect(window.location.hash).toBe(
        `#/task/${encodeURIComponent('click-test-task')}?from=progress`,
      )
    } finally {
      window.location.hash = priorHash
      await act(async () => { root.unmount() })
      document.body.removeChild(container)
    }
  })
})

describe('visibleLegendItems', () => {
  it('names only the states present in this graph', () => {
    const items = visibleLegendItems(new Set(['Failed', 'Blocked'] as const), false)
    expect(items.map((i) => i.label)).toEqual(['blocked', 'failed'])
  })

  it('includes the proposal swatch only when a proposal frame is drawn', () => {
    expect(visibleLegendItems(new Set(['Failed'] as const), true).map((i) => i.label)).toEqual([
      'proposal',
      'failed',
    ])
    expect(visibleLegendItems(new Set(['Failed'] as const), false).map((i) => i.label)).toEqual([
      'failed',
    ])
  })

  it('shows nothing at all for an empty graph rather than a catalogue of states', () => {
    expect(visibleLegendItems(new Set(), false)).toEqual([])
  })
})
