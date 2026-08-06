import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetContextCacheForTests } from '../context'
import {
  createCard,
  getLever,
  setLever,
  type Card,
  type AutonomyLevel,
} from './store'

describe('lever store', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mars-levers-store-'))
    mkdirSync(join(tmpDir, '.mars'), { recursive: true })
    process.env.MARS_REPO = tmpDir
    __resetContextCacheForTests()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    __resetContextCacheForTests()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── Card type shape ────────────────────────────────────────────────────────

  it('Card includes required autonomy_level and producer_key fields', () => {
    const card: Card = {
      id: 'test-id',
      autonomy_level: 'ask',
      producer_key: 'my-lever',
      body: 'something happened',
      created_at: Date.now(),
    }
    expect(card.autonomy_level).toBe('ask')
    expect(card.producer_key).toBe('my-lever')
  })

  // ── getLever / setLever ────────────────────────────────────────────────────

  it('getLever returns ask by default for an unknown key', () => {
    expect(getLever('unknown-lever')).toBe('ask')
  })

  it('setLever persists the level and getLever returns it', () => {
    setLever('my-lever', 'off')
    expect(getLever('my-lever')).toBe('off')
  })

  it('setLever can switch a lever back from off to ask', () => {
    setLever('my-lever', 'off')
    setLever('my-lever', 'ask')
    expect(getLever('my-lever')).toBe('ask')
  })

  // ── createCard lever guard ─────────────────────────────────────────────────

  it('createCard returns a Card when the lever is at its default (ask)', () => {
    const card = createCard({
      producer_key: 'my-lever',
      autonomy_level: 'ask',
      body: 'something happened',
    })
    expect(card).not.toBeNull()
    expect(card?.producer_key).toBe('my-lever')
    expect(card?.autonomy_level).toBe('ask')
    expect(card?.body).toBe('something happened')
    expect(typeof card?.id).toBe('string')
    expect(typeof card?.created_at).toBe('number')
  })

  it('createCard returns null when the lever is muted (off)', () => {
    setLever('my-lever', 'off')
    const card = createCard({
      producer_key: 'my-lever',
      autonomy_level: 'ask',
      body: 'something happened',
    })
    expect(card).toBeNull()
  })

  it('createCard returns a Card when the lever is tell', () => {
    setLever('my-lever', 'tell')
    const card = createCard({
      producer_key: 'my-lever',
      autonomy_level: 'tell',
      body: 'something happened autonomously',
    })
    expect(card).not.toBeNull()
  })

  // ── The acceptance criterion: create Card → silence → next event raises 0 Cards ──

  it('after silencing a lever, subsequent events from the same producer_key raise 0 Cards', () => {
    const key = 'alert-lever'

    // 1. Before silence: a Card is created
    const firstCard = createCard({ producer_key: key, autonomy_level: 'ask', body: 'event 1' })
    expect(firstCard).not.toBeNull()

    // 2. Operator silences the lever (e.g. via the Silence button on the Card)
    setLever(key, 'off')

    // 3. Subsequent events from same producer_key raise 0 Cards
    const secondCard = createCard({ producer_key: key, autonomy_level: 'ask', body: 'event 2' })
    expect(secondCard).toBeNull()

    const thirdCard = createCard({ producer_key: key, autonomy_level: 'ask', body: 'event 3' })
    expect(thirdCard).toBeNull()
  })

  it('silencing one lever does not affect Cards from a different producer_key', () => {
    setLever('lever-a', 'off')

    const cardFromB = createCard({ producer_key: 'lever-b', autonomy_level: 'ask', body: 'from b' })
    expect(cardFromB).not.toBeNull()
  })

  // ── Type safety ────────────────────────────────────────────────────────────

  it('autonomy_level on Card reflects the level passed at creation time', () => {
    const tellCard = createCard({ producer_key: 'lever', autonomy_level: 'tell', body: 'x' })
    expect(tellCard?.autonomy_level).toBe('tell')

    const askCard = createCard({ producer_key: 'lever2', autonomy_level: 'ask', body: 'y' })
    expect(askCard?.autonomy_level).toBe('ask')
  })
})

describe('AutonomyLevel type', () => {
  it('valid levels are off, ask, and tell', () => {
    const levels: AutonomyLevel[] = ['off', 'ask', 'tell']
    expect(levels).toHaveLength(3)
  })
})
