// @vitest-environment happy-dom
import { describe, it, expect, mock } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { OpeningNextMoves } from './OpeningNextMoves'
import type { DisplayRow } from './OpeningNextMoves'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeRow = (
  id: string,
  title: string,
  kind = 'failed-task',
): DisplayRow => ({
  id,
  kind,
  title,
  humanSummary: '',
})

// ---------------------------------------------------------------------------
// Structure tests (SSR)
// ---------------------------------------------------------------------------

describe('OpeningNextMoves — structure', () => {
  it('renders nothing when rows is empty', () => {
    const html = renderToStaticMarkup(<OpeningNextMoves rows={[]} onPick={() => {}} />)
    expect(html).toBe('')
  })

  it('renders container with correct data-testid and aria-label', () => {
    const html = renderToStaticMarkup(
      <OpeningNextMoves rows={[makeRow('a', 'Fix auth')]} onPick={() => {}} />,
    )
    expect(html).toContain('data-testid="opening-next-moves"')
    expect(html).toContain('aria-label="Pending work"')
  })

  it('renders a group header for 1 blocked task', () => {
    const html = renderToStaticMarkup(
      <OpeningNextMoves rows={[makeRow('a', 'Fix auth')]} onPick={() => {}} />,
    )
    expect(html).toContain('data-testid="queue-group-header"')
    expect(html).toContain('1 blocked task')
  })

  it('renders a plural blocked-task header for multiple blocked tasks', () => {
    const rows = [makeRow('a', 'Fix auth'), makeRow('b', 'Deploy'), makeRow('c', 'Build')]
    const html = renderToStaticMarkup(<OpeningNextMoves rows={rows} onPick={() => {}} />)
    expect(html).toContain('3 blocked tasks')
  })

  it('renders a proposal group header for draft-proposal items', () => {
    const html = renderToStaticMarkup(
      <OpeningNextMoves
        rows={[makeRow('p1', 'New feature idea', 'draft-proposal')]}
        onPick={() => {}}
      />,
    )
    expect(html).toContain('1 proposal to refine')
  })

  it('renders both groups when blocked tasks and proposals coexist', () => {
    const rows = [
      makeRow('b1', 'Task failed', 'failed-task'),
      makeRow('p1', 'New idea', 'draft-proposal'),
    ]
    const html = renderToStaticMarkup(<OpeningNextMoves rows={rows} onPick={() => {}} />)
    const headerCount = (html.match(/data-testid="queue-group-header"/g) ?? []).length
    expect(headerCount).toBe(2)
    expect(html).toContain('1 blocked task')
    expect(html).toContain('1 proposal to refine')
  })

  it('renders one chip per row with titles', () => {
    const rows = [makeRow('a', 'Fix auth'), makeRow('b', 'Deploy')]
    const html = renderToStaticMarkup(<OpeningNextMoves rows={rows} onPick={() => {}} />)
    const chipCount = (html.match(/data-testid="next-move-chip"/g) ?? []).length
    expect(chipCount).toBe(2)
    expect(html).toContain('Fix auth')
    expect(html).toContain('Deploy')
  })

  it('groups draft-proposal rows separately from non-proposal rows', () => {
    const rows = [
      makeRow('b1', 'Task A', 'failed-task'),
      makeRow('b2', 'Task B', 'arc-failed'),
      makeRow('p1', 'Idea', 'draft-proposal'),
    ]
    const html = renderToStaticMarkup(<OpeningNextMoves rows={rows} onPick={() => {}} />)
    expect(html).toContain('2 blocked tasks')
    expect(html).toContain('1 proposal to refine')
  })

  it('groups synthetic blocked-task rows (kind="blocked") in the blocked-task group', () => {
    const rows = [
      makeRow('t1', 'Waiting for build', 'blocked'),
      makeRow('t2', 'Waiting for deploy', 'blocked'),
    ]
    const html = renderToStaticMarkup(<OpeningNextMoves rows={rows} onPick={() => {}} />)
    expect(html).toContain('2 blocked tasks')
    expect(html).toContain('Waiting for build')
    expect(html).toContain('Waiting for deploy')
  })

  it('renders the first chip in each group with foreground color class', () => {
    const rows = [
      makeRow('b1', 'Task A', 'failed-task'),
      makeRow('b2', 'Task B', 'failed-task'),
    ]
    const html = renderToStaticMarkup(<OpeningNextMoves rows={rows} onPick={() => {}} />)
    // First chip should have text-foreground, second should have text-muted-foreground
    expect(html).toContain('text-foreground')
    expect(html).toContain('text-muted-foreground')
  })
})

// ---------------------------------------------------------------------------
// Interaction tests (DOM)
// ---------------------------------------------------------------------------

describe('OpeningNextMoves — interaction', () => {
  it('calls onPick with the clicked row', async () => {
    const onPick = mock()
    const rowA = makeRow('row-a', 'Fix deploy')
    const rowB = makeRow('row-b', 'Rotate key')

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(<OpeningNextMoves rows={[rowA, rowB]} onPick={onPick} />)
    })

    const chips = container.querySelectorAll('[data-testid="next-move-chip"]')
    expect(chips.length).toBe(2)

    await act(async () => {
      ;(chips[1] as HTMLButtonElement).click()
    })

    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick).toHaveBeenCalledWith(rowB)

    await act(async () => {
      root.unmount()
    })
    container.remove()
  })

  it('calls onPick with the correct item from a proposal group', async () => {
    const onPick = mock()
    const proposal = makeRow('p1', 'New feature', 'draft-proposal')

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(<OpeningNextMoves rows={[proposal]} onPick={onPick} />)
    })

    const chip = container.querySelector('[data-testid="next-move-chip"]') as HTMLButtonElement
    await act(async () => {
      chip.click()
    })

    expect(onPick).toHaveBeenCalledWith(proposal)

    await act(async () => {
      root.unmount()
    })
    container.remove()
  })

  it('calls onPick with synthetic blocked-task rows', async () => {
    const onPick = mock()
    const blockedRow: DisplayRow = {
      id: 'task-xyz',
      kind: 'blocked',
      title: 'Deploy blocked by build',
      humanSummary: 'Waiting on a blocker task.',
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(<OpeningNextMoves rows={[blockedRow]} onPick={onPick} />)
    })

    const chip = container.querySelector('[data-testid="next-move-chip"]') as HTMLButtonElement
    await act(async () => {
      chip.click()
    })

    expect(onPick).toHaveBeenCalledWith(blockedRow)

    await act(async () => {
      root.unmount()
    })
    container.remove()
  })
})
