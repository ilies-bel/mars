/**
 * Behaviour coverage for the operator-facing Steward intervention timeline.
 * The query boundary is fixed so the component can be rendered as a complete
 * surface without a running daemon.
 */
import { describe, expect, it, mock } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

let entries: unknown[] = []

mock.module('@tanstack/react-query', () => ({
  useQuery: () => ({ data: entries, isPending: false, isError: false }),
}))

const { StewardLedgerPanel } = await import('./StewardLedgerPanel')

describe('StewardLedgerPanel', () => {
  it('explains when Steward has not intervened for the selected target', () => {
    entries = []

    const html = renderToStaticMarkup(
      <StewardLedgerPanel targetKind="task" targetId="task-empty" />,
    )

    expect(html).toContain('No Steward interventions recorded.')
    expect(html).toContain('task-empty')
  })

  it('shows intervention rows newest first with their operator evidence', () => {
    entries = [
      {
        id: 'oldest',
        ts: '2026-07-01T09:00:00.000Z',
        targetKind: 'task',
        targetId: 'task-7',
        targetVersion: 'verify:v1',
        recipeId: 'repair-verify',
        rationale: 'The verify step repeatedly failed.',
        outcome: 'recovered',
        commitSha: null,
      },
      {
        id: 'newest',
        ts: '2026-07-03T09:00:00.000Z',
        targetKind: 'task',
        targetId: 'task-7',
        targetVersion: 'verify:v3',
        recipeId: 'repair-verify',
        rationale: 'The latest regression needed a focused repair.',
        outcome: 'merged',
        commitSha: 'abc123def456',
      },
      {
        id: 'middle',
        ts: '2026-07-02T09:00:00.000Z',
        targetKind: 'task',
        targetId: 'task-7',
        targetVersion: 'verify:v2',
        recipeId: 'retry-verify',
        rationale: 'A transient runner failure was retried.',
        outcome: 'no-op',
        commitSha: null,
      },
    ]

    const html = renderToStaticMarkup(
      <StewardLedgerPanel targetKind="task" targetId="task-7" />,
    )

    expect((html.match(/data-testid="steward-ledger-row"/g) ?? [])).toHaveLength(3)
    expect(html.indexOf('verify:v3')).toBeLessThan(html.indexOf('verify:v2'))
    expect(html.indexOf('verify:v2')).toBeLessThan(html.indexOf('verify:v1'))
    expect(html).toContain('task-7')
    expect(html).toContain('repair-verify')
    expect(html).toContain('The latest regression needed a focused repair.')
    expect(html).toContain('merged')
    expect(html).toContain('abc123def456')
  })
})
