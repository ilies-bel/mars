import { describe, it, expect } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { OpeningNextMoves } from './OpeningNextMoves'
import type { ActionQueueItem } from '@/shared/schemas'

const makeRow = (id: string, title: string): ActionQueueItem =>
  ({
    id,
    kind: 'failed-task',
    entityId: `task-${id}`,
    priority: 'high',
    title,
    body: '',
    at: '2026-07-27T00:00:00.000Z',
    dag: null,
    errorKind: 'unknown',
    actions: [],
    diagnosis: null,
    failureReasonCode: null,
    humanSummary: '',
    verbs: [],
    decisions: [],
  }) as ActionQueueItem

describe('OpeningNextMoves', () => {
  it('renders nothing when rows is empty', () => {
    const html = renderToStaticMarkup(<OpeningNextMoves rows={[]} onPick={() => {}} />)
    expect(html).toBe('')
  })

  it('renders one chip per row', () => {
    const rows = [makeRow('a', 'Fix auth'), makeRow('b', 'Deploy')]
    const html = renderToStaticMarkup(<OpeningNextMoves rows={rows} onPick={() => {}} />)
    expect(html).toContain('data-testid="next-move-chip"')
    expect(html).toContain('Fix auth')
    expect(html).toContain('Deploy')
    const chipCount = (html.match(/data-testid="next-move-chip"/g) ?? []).length
    expect(chipCount).toBe(2)
  })

  it('renders the container with the correct aria label', () => {
    const rows = [makeRow('a', 'Fix auth')]
    const html = renderToStaticMarkup(<OpeningNextMoves rows={rows} onPick={() => {}} />)
    expect(html).toContain('aria-label="Suggested next moves"')
    expect(html).toContain('data-testid="opening-next-moves"')
  })
})
