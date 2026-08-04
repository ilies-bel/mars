import { describe, expect, it } from 'vitest'
import { collectOpenOffers, matchOffer, type OpenOffer } from './offerMatch'
import type { ChatConversationEntry, PreloadedResponse } from '@/shared/schemas'

const offer = (
  id: string,
  label: string,
  target: PreloadedResponse['target'],
  messageId = 'notice-1',
): OpenOffer => ({ messageId, response: { id, label, target } })

const NOTED = offer('ack', 'Noted', { type: 'ack' })
const SILENCE = offer('silence', 'Stop doing this automatically', {
  type: 'lever',
  name: 'steward_runtime_tune',
  level: 'off',
})

const entry = (over: Partial<ChatConversationEntry> = {}): ChatConversationEntry => ({
  id: 'notice-1',
  seq: 1,
  threadId: 'main',
  subthreadId: 'main',
  subthreadTitle: 'Main thread',
  subthreadClosed: false,
  role: 'assistant',
  content: 'I reduced implement workers.',
  segments: [
    { type: 'text', text: 'I reduced implement workers.' },
    { type: 'preloaded_responses', responses: [NOTED.response, SILENCE.response] },
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  kind: 'notice',
  backingEntityId: null,
  resolution: null,
  ...over,
} as ChatConversationEntry)

describe('collectOpenOffers', () => {
  it('reads the Offer set off the newest Notice that still has one', () => {
    const offers = collectOpenOffers([
      entry({ id: 'old', seq: 1 }),
      entry({ id: 'new', seq: 2 }),
    ])

    expect(offers).toHaveLength(2)
    expect(offers.every((o) => o.messageId === 'new')).toBe(true)
  })

  it('skips a Notice the operator has already answered', () => {
    const offers = collectOpenOffers([
      entry({ id: 'open', seq: 1 }),
      entry({ id: 'answered', seq: 2, resolution: 'resolved' }),
    ])

    expect(offers.every((o) => o.messageId === 'open')).toBe(true)
  })

  it('returns nothing when the feed has no chips standing open', () => {
    expect(collectOpenOffers([entry({ segments: [{ type: 'text', text: 'hi' }] })])).toEqual([])
  })
})

describe('matchOffer', () => {
  const offers = [NOTED, SILENCE]

  it('matches a chip label the operator typed out', () => {
    expect(matchOffer('Stop doing this automatically', offers)?.response.id).toBe('silence')
  })

  it('ignores case and punctuation', () => {
    expect(matchOffer('  stop doing this, automatically!  ', offers)?.response.id).toBe('silence')
  })

  it('accepts the words people actually type instead of the chip label', () => {
    expect(matchOffer('noted', offers)?.response.id).toBe('ack')
    expect(matchOffer('ok', offers)?.response.id).toBe('ack')
    expect(matchOffer("don't do that again", offers)?.response.id).toBe('silence')
    expect(matchOffer('stop', offers)?.response.id).toBe('silence')
  })

  it('refuses to guess when two offers fit', () => {
    const twoLevers = [
      SILENCE,
      offer('never', 'Never again', { type: 'lever', name: 'other', level: 'off' }),
    ]
    expect(matchOffer('stop', twoLevers)).toBeNull()
  })

  it('lets a real message through instead of hijacking it', () => {
    expect(matchOffer('why did you stop the workers?', offers)).toBeNull()
    expect(matchOffer('add a task to fix the merge gate', offers)).toBeNull()
    expect(matchOffer('', offers)).toBeNull()
  })

  it('matches nothing when no Offer set is open', () => {
    expect(matchOffer('noted', [])).toBeNull()
  })
})
