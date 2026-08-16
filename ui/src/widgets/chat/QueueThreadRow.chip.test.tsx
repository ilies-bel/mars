/**
 * Kind-chip rendering tests for QueueThreadRow.
 *
 * Verifies that the optional `kindChip` prop renders the right chip element
 * (alert = iron-tinted, decision = ochre-tinted) and that no chip is rendered
 * when the prop is omitted or null.
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

  it('alert chip uses iron-tinted (primary) styling', () => {
    const html = renderRow('alert')
    // The chip must carry iron-tinted classes via the primary alias — not raw palette tokens.
    expect(html).toContain('bg-primary/10')
    expect(html).toContain('border-primary/30')
    expect(html).toContain('text-primary')
  })

  it('decision chip uses ochre-tinted (status-blocked) styling', () => {
    const html = renderRow('decision')
    // The chip must carry ochre-tinted classes via the status-blocked alias.
    expect(html).toContain('bg-status-blocked/10')
    expect(html).toContain('border-status-blocked/30')
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
