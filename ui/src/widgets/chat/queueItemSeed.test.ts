// @vitest-environment happy-dom
/**
 * The opener Mars posts when an operator clicks an alert.
 *
 * The bar is: it must never say the same thing twice, never invent a detail the
 * row did not carry, and always end with something the operator can act on.
 */

import { describe, it, expect } from 'vitest'
import { buildQueueItemSeed } from './queueItemSeed'
import type { ActionQueueItem } from '@/shared/schemas'

const baseItem = {
  id: 'q1',
  kind: 'gate-broken',
  entityId: 'mars-ffb3b476',
  priority: 'high',
  title: 'gate broken',
  body: '',
  at: '2026-08-18T10:00:00.000Z',
  dag: null,
  actions: [],
  verbs: [],
  decisions: [],
  humanSummary: '',
} as unknown as ActionQueueItem

const make = (overrides: Partial<ActionQueueItem>): ActionQueueItem =>
  ({ ...baseItem, ...overrides }) as ActionQueueItem

describe('buildQueueItemSeed', () => {
  it('leads with the row summary and does not repeat it', () => {
    // The kind lead used to be prefixed onto the summary, producing
    // "A verify gate is broken. A verify gate keeps failing the same way…".
    const seed = buildQueueItemSeed(
      make({ humanSummary: 'A verify gate keeps failing the same way' }),
    )
    expect(seed.startsWith('A verify gate keeps failing the same way')).toBe(true)
    expect(seed).not.toContain('A verify gate is broken. A verify gate')
  })

  it('falls back to a kind lead only when the row carries no summary', () => {
    const seed = buildQueueItemSeed(make({ humanSummary: '', title: '' }))
    expect(seed).toContain('A verify gate is broken')
  })

  it('names the entity the alert concerns', () => {
    const seed = buildQueueItemSeed(make({ humanSummary: 'Gate broken' }))
    expect(seed).toContain('mars-ffb3b476')
  })

  it('lists the available verbs so the thread never opens without a next step', () => {
    const seed = buildQueueItemSeed(
      make({
        humanSummary: 'Gate broken',
        verbs: [
          { label: 'Dismiss', op: 'dismiss', style: 'default' },
          { label: 'Snooze', op: 'snooze', style: 'snooze' },
        ],
      } as Partial<ActionQueueItem>),
    )
    expect(seed).toContain('Your options: Dismiss, Snooze.')
  })

  it('clips a long body rather than pasting a whole log into the opener', () => {
    const seed = buildQueueItemSeed(
      make({ humanSummary: 'Gate broken', body: 'x'.repeat(2000) }),
    )
    expect(seed).toContain('…')
    expect(seed.length).toBeLessThan(1200)
  })

  it('omits the entity line when the row has no entity', () => {
    const seed = buildQueueItemSeed(make({ humanSummary: 'Gate broken', entityId: '' }))
    expect(seed).not.toContain('This concerns')
  })

  it('always closes with an invitation to ask', () => {
    const seed = buildQueueItemSeed(make({ humanSummary: 'Gate broken' }))
    expect(seed.trimEnd().endsWith('Ask me anything about it, or use the buttons above.')).toBe(true)
  })
})
