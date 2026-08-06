import { describe, expect, it } from 'vitest'
import {
  AutonomousNoticeKindSchema,
  isStewardRuntimeTuneKind,
  leverForConversationNotice,
  offersForConversationNotice,
  renderConversationNotice,
  speechActForConversationNotice,
  type AutonomousNoticeKind,
  type AutonomousNoticePayloads,
} from '../conversation-copy.js'
import { PreloadedResponseSchema } from '../chat-store.js'

/**
 * One fixture per kind. Typed as the payload map rather than `as const` so a
 * new kind fails to compile here until it is given a fixture — the schema's
 * option list and this table can never drift apart silently.
 */
const payloads: { [K in AutonomousNoticeKind]: AutonomousNoticePayloads[K] } = {
  'steward.worker-bumped': {
    from: 2,
    to: 3,
    pending: 8,
    threshold: 2,
    sustainedSeconds: 60,
  },
  'steward.worker-reduced': { from: 3, to: 2, pagingPps: 800 },
  'steward.worker-restored': { from: 2, to: 3 },
  'recipe.auto-applied': {
    recipeId: 'recipe-1',
    failureKind: 'verify-failed',
    targetTaskId: 'task-1',
  },
  'failure.batch': {
    taskCount: 2,
    cause: 'task branch has no commits ahead of integration',
  },
  'session.idle-proposal': { proposalId: 'prop-1', title: 'Rework the merge gate' },
  'suggestion.codegraph': { tasksRun: 41, windowDays: 7 },
  'observation.manual-push': { commits: 6, windowDays: 14, branch: 'main' },
  'trend.token-spend': { changePct: 38, windowDays: 14 },
  'gate.main-broken': { failingCheck: 'npm test', blockedTasks: 4 },
}

const bodyFor = (kind: AutonomousNoticeKind): string =>
  renderConversationNotice(kind, payloads[kind])

describe('renderConversationNotice', () => {
  it('says every Notice in one sentence', () => {
    for (const kind of AutonomousNoticeKindSchema.options) {
      const body = bodyFor(kind)
      expect(body.split(/[.!?]+/).filter((part) => part.trim() !== ''), kind).toHaveLength(1)
      expect(body, kind).toMatch(/[.?]$/)
    }
  })

  it('makes every announcement a first-person action with its reason', () => {
    for (const kind of AutonomousNoticeKindSchema.options) {
      if (speechActForConversationNotice(kind) !== 'announcement') continue
      const body = bodyFor(kind)
      expect(body, kind).toMatch(/^I\s/)
      expect(body, kind).toContain(' because ')
    }
  })

  it('never makes an offer claim a cause for something it has not done', () => {
    for (const kind of AutonomousNoticeKindSchema.options) {
      if (speechActForConversationNotice(kind) !== 'offer') continue
      const body = bodyFor(kind)
      // An offer may observe ("I noticed…") or address the operator
      // ("You have no…", "Nothing on my side —"), but it never reports a
      // completed action, so it owes no "because".
      expect(body, kind).not.toMatch(/^I (increased|reduced|restored|applied|paused|wrote) /)
    }
  })
})

describe('offersForConversationNotice', () => {
  it('gives every Notice at least one way to close it', () => {
    for (const kind of AutonomousNoticeKindSchema.options) {
      const offers = offersForConversationNotice(kind, payloads[kind])
      expect(offers.length, kind).toBeGreaterThan(0)
      for (const offer of offers) {
        expect(() => PreloadedResponseSchema.parse(offer), `${kind}/${offer.id}`).not.toThrow()
      }
      expect(new Set(offers.map((o) => o.id)).size, kind).toBe(offers.length)
    }
  })

  it('offers the off-switch of exactly the lever that produced the Notice', () => {
    for (const kind of AutonomousNoticeKindSchema.options) {
      const lever = leverForConversationNotice(kind)
      const leverOffers = offersForConversationNotice(kind, payloads[kind])
        .filter((offer) => offer.target.type === 'lever')
      if (lever === undefined) {
        // Nothing to silence: a Notice with no lever must not pretend to
        // offer one, or the operator taps it and nothing changes.
        expect(leverOffers, kind).toHaveLength(0)
        continue
      }
      expect(leverOffers.length, kind).toBeGreaterThan(0)
      for (const offer of leverOffers) {
        expect(offer.target, kind).toMatchObject({ name: lever, level: 'off' })
      }
    }
  })

  it('keeps every reference offer on https', () => {
    for (const kind of AutonomousNoticeKindSchema.options) {
      for (const offer of offersForConversationNotice(kind, payloads[kind])) {
        if (offer.target.type !== 'reference') continue
        expect(offer.target.url, kind).toMatch(/^https:\/\//)
      }
    }
  })
})

describe('isStewardRuntimeTuneKind', () => {
  it('returns true for all three runtime-tuning kinds', () => {
    expect(isStewardRuntimeTuneKind('steward.worker-bumped')).toBe(true)
    expect(isStewardRuntimeTuneKind('steward.worker-reduced')).toBe(true)
    expect(isStewardRuntimeTuneKind('steward.worker-restored')).toBe(true)
  })

  it('returns false for every other notice kind', () => {
    const nonTuneKinds = AutonomousNoticeKindSchema.options.filter(
      (k) => !k.startsWith('steward.'),
    )
    for (const kind of nonTuneKinds) {
      expect(isStewardRuntimeTuneKind(kind), kind).toBe(false)
    }
  })
})
