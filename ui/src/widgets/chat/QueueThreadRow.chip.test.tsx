/**
 * Kind-chip rendering tests for QueueThreadRow.
 *
 * Verifies that the optional `kindChip` prop renders the right chip element
 * (alert = softened error-tinted, decision = softened status-blocked-tinted)
 * and that no chip is rendered when the prop is omitted or null.
 */

import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueueThreadRow } from './QueueThreadRow'
import type { ActionQueueItem } from '@/shared/schemas'

const BASE_ITEM: ActionQueueItem = {
  id: 'row-chip-1',
  kind: 'failed-task',
  entityId: 'task-chip',
  priority: 'normal',
  title: 'Some task',
  body: 'Details',
  at: '2026-01-01T00:00:00Z',
  dag: null,
  errorKind: 'failed-task',
  actions: [],
  diagnosis: null,
} as unknown as ActionQueueItem

const renderRow = (
  kindChip?: 'alert' | 'decision' | null,
  active = false,
): string =>
  renderToStaticMarkup(
    <QueueThreadRow
      item={BASE_ITEM}
      active={active}
      onSelect={() => {}}
      onRestart={null}
      restartPending={false}
      restartError={null}
      kindChip={kindChip}
    />,
  )

// ---------------------------------------------------------------------------
// Kind chip rendering
// ---------------------------------------------------------------------------

describe('QueueThreadRow – kind chip', () => {
  it('renders no chip when kindChip is omitted', () => {
    const html = renderRow()
    expect(html).not.toContain('data-testid="kind-chip-alert"')
    expect(html).not.toContain('data-testid="kind-chip-decision"')
  })

  it('renders no chip when kindChip is null', () => {
    const html = renderRow(null)
    expect(html).not.toContain('data-testid="kind-chip-alert"')
    expect(html).not.toContain('data-testid="kind-chip-decision"')
  })

  it('renders the alert chip when kindChip is "alert"', () => {
    const html = renderRow('alert')
    expect(html).toContain('data-testid="kind-chip-alert"')
    expect(html).toContain('>alert<')
    expect(html).not.toContain('data-testid="kind-chip-decision"')
  })

  it('renders the decision chip when kindChip is "decision"', () => {
    const html = renderRow('decision')
    expect(html).toContain('data-testid="kind-chip-decision"')
    expect(html).toContain('>decision<')
    expect(html).not.toContain('data-testid="kind-chip-alert"')
  })

  it('alert chip uses softened error styling', () => {
    const html = renderRow('alert')
    // The chip must carry softened error classes — not raw palette tokens.
    expect(html).toContain('bg-error/15')
    expect(html).toContain('text-error')
  })

  it('decision chip uses softened status-blocked styling', () => {
    const html = renderRow('decision')
    // The chip must carry softened status-blocked classes.
    expect(html).toContain('bg-status-blocked/15')
    expect(html).toContain('text-status-blocked')
  })

  it('renders both chip and existing kind-badge label on the same row', () => {
    const html = renderRow('alert')
    // The existing kind badge label should still appear alongside the chip.
    expect(html).toContain('data-testid="kind-chip-alert"')
    // Row content is still present (entity id, title).
    expect(html).toContain('task-chip')
    expect(html).toContain('Some task')
  })
})
