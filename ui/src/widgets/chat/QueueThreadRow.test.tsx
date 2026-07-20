/**
 * Unit tests for QueueThreadRow — the projection-Thread sidebar row.
 *
 * Rendered with renderToStaticMarkup: the row is stateless and receives all
 * behaviour via props, so no React Query context is needed.
 */

import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueueThreadRow } from './QueueThreadRow'
import type { ActionQueueItem } from '@/shared/schemas'

const BASE_ITEM: ActionQueueItem = {
  id: 'row-1',
  kind: 'failed-task',
  entityId: 'task-abc',
  priority: 'normal',
  title: 'Some failed task',
  body: 'Task failed because of X',
  at: '2026-01-01T00:00:00Z',
  dag: null,
  errorKind: 'failed-task',
  actions: [
    { id: 'diagnose-failure', label: 'Investigate', op: 'diagnose-failure' },
    { id: 'restart', label: 'Restart', op: 'restart' },
    { id: 'purge', label: 'Purge', op: 'purge', needsConfirm: true },
  ],
  diagnosis: null,
} as unknown as ActionQueueItem

const makeItem = (overrides: Record<string, unknown>): ActionQueueItem =>
  ({ ...BASE_ITEM, ...overrides } as ActionQueueItem)

const renderRow = (
  item: ActionQueueItem,
  opts: {
    active?: boolean
    onRestart?: (() => void) | null
    restartPending?: boolean
    restartError?: string | null
    hasConversation?: boolean
  } = {},
) =>
  renderToStaticMarkup(
    <QueueThreadRow
      item={item}
      active={opts.active ?? false}
      onSelect={() => {}}
      onRestart={opts.onRestart ?? null}
      restartPending={opts.restartPending ?? false}
      restartError={opts.restartError ?? null}
      hasConversation={opts.hasConversation ?? false}
    />,
  )

// ---------------------------------------------------------------------------
// Decisions render on the row
// ---------------------------------------------------------------------------

describe('QueueThreadRow – Decisions', () => {
  it('renders compact Decision pills on an inactive row', () => {
    const html = renderRow(BASE_ITEM)
    // Non-restart Decisions appear as compact pills.
    expect(html).toContain('Investigate')
    expect(html).toContain('Purge')
  })

  it('renders full Decision buttons in the inline resolver when active', () => {
    const html = renderRow(BASE_ITEM, { active: true })
    expect(html).toContain('>Investigate<')
    expect(html).toContain('>Purge<')
  })

  it('renders a Restart button when onRestart is provided', () => {
    const html = renderRow(BASE_ITEM, { onRestart: () => {} })
    expect(html).toContain('>Restart<')
    expect(html).toContain(`aria-label="Restart ${BASE_ITEM.entityId}"`)
  })

  it('renders "Restarting…" and disables the button while restart is pending', () => {
    const html = renderRow(BASE_ITEM, { onRestart: () => {}, restartPending: true })
    expect(html).toContain('Restarting')
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('>Restart<')
  })

  it('renders NO Restart button when onRestart is null', () => {
    const html = renderRow(
      makeItem({ actions: [{ id: 'investigate', label: 'Investigate', op: 'investigate' }] }),
      { onRestart: null },
    )
    expect(html).not.toContain('Restart')
  })

  it('shows the error message inline when restartError is set', () => {
    const html = renderRow(BASE_ITEM, {
      onRestart: () => {},
      restartError: 'restart failed (409): task is queued',
    })
    expect(html).toContain('restart failed (409): task is queued')
    expect(html).toContain('>Restart<')
  })
})

// ---------------------------------------------------------------------------
// Projection semantics
// ---------------------------------------------------------------------------

describe('QueueThreadRow – projection semantics', () => {
  it('uses Mars as the sender so a queue row reads as a conversation preview', () => {
    const html = renderRow(BASE_ITEM)
    expect(html).toContain('>Mars<')
    expect(html).toContain('Some failed task')
  })

  it('has no delete affordance (projection entries evaporate via entity mutation)', () => {
    const html = renderRow(BASE_ITEM)
    expect(html).not.toContain('aria-label="Delete thread"')
    expect(html).not.toContain('✕')
  })

  it('shows the conversation marker when merged with an alert-origin thread', () => {
    const html = renderRow(BASE_ITEM, { hasConversation: true })
    expect(html).toContain('data-testid="projection-has-conversation"')
  })

  it('omits the conversation marker for a pure projection', () => {
    const html = renderRow(BASE_ITEM)
    expect(html).not.toContain('data-testid="projection-has-conversation"')
  })

  it('renders the priority pill', () => {
    expect(renderRow(BASE_ITEM)).toContain('normal')
    expect(renderRow(makeItem({ priority: 'high' }))).toContain('high')
  })
})

// ---------------------------------------------------------------------------
// Draft-proposal headline clamp
// ---------------------------------------------------------------------------

describe('QueueThreadRow – draft-proposal headline', () => {
  const draftItem = (title: string): ActionQueueItem =>
    makeItem({
      id: 'draft-row',
      kind: 'draft-proposal',
      entityId: 'prop-1',
      errorKind: 'draft-proposal',
      title,
      actions: [],
    })

  const visibleBody = (html: string): string => {
    const match = html.match(/<div class="mt-1 line-clamp-\d[^"]*"[^>]*>([\s\S]*?)<\/div>/)
    return match ? match[1] : ''
  }

  it('renders only the first sentence when title is multi-sentence prose', () => {
    const html = renderRow(
      draftItem('Ship a keyboard-first navigator. It should let power users move. Details.'),
    )
    expect(visibleBody(html)).toBe('Ship a keyboard-first navigator.')
  })

  it('does NOT truncate failed-task titles', () => {
    const html = renderRow(
      makeItem({ title: 'Some failed task. With follow-up detail.' }),
      { onRestart: () => {} },
    )
    expect(visibleBody(html)).toBe('Some failed task. With follow-up detail.')
  })
})

// ---------------------------------------------------------------------------
// Keyboard accessibility
// ---------------------------------------------------------------------------

describe('QueueThreadRow – keyboard accessibility', () => {
  it('renders role="button" and tabindex="0"', () => {
    const html = renderRow(BASE_ITEM)
    expect(html).toContain('role="button"')
    expect(html).toContain('tabindex="0"')
  })

  it('renders aria-current="true" only on the active row', () => {
    expect(renderRow(BASE_ITEM, { active: true })).toContain('aria-current="true"')
    expect(renderRow(BASE_ITEM, { active: false })).not.toContain('aria-current')
  })
})
