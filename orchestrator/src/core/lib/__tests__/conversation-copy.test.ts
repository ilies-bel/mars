import { describe, expect, it } from 'vitest'
import {
  AutonomousNoticeKindSchema,
  collapseKeyForConversationNotice,
  isActionableConversationNotice,
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
  'observation.manual-push': { commits: 6, marsCommits: 665, windowDays: 14, branch: 'main' },
  'trend.token-spend': { changePct: 38, windowDays: 14 },
  'trend.triage-yield': {
    recentRatePct: 3,
    priorRatePct: 48,
    recentCreated: 105,
    windowDays: 30,
    topSource: 'reflection',
  },
  'gate.main-broken': { failingCheck: 'npm test', blockedTasks: 4 },
  'merge.operator-auto-commit': {
    taskId: 'mars-abc123',
    branch: 'main',
    commitSha: '0123456789abcdef0123456789abcdef01234567',
    files: ['operator.txt', 'notes.md'],
  },
  'steward.prompt-optimizer-ack': {
    workerId: 'Coder',
    reason: 'the depth ratio showed excess boilerplate',
    entryId: 'entry-abc123',
  },
  'steward.prompt-optimization': {
    ledgerId: 'ledger-abc123',
  },
  'steward.workflow-patch': {
    path: '.mars/workflows/implement.md',
    diff: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new',
    proposalId: 'prop-xyz789',
  },
  'steward.runtime-tune': { from: 6, to: 8, reason: 'the backlog was sustained' },
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

  it('frames the manual-push observation as a repo-state fact, not an operator verdict', () => {
    const body = bodyFor('observation.manual-push')
    // New phrasing: repo-state subject
    expect(body).toContain('have never been through verify')
    // Old framing must be absent
    expect(body).not.toContain('outside the pipeline')
    expect(body).not.toContain('habit')
    expect(body).not.toContain('push_habit_observation')
    // HR-11/DEC-20: no consequence attributed to the operator's method
    expect(body).not.toContain('vouch')
  })

  it('reflects the file count in the auto-commit notice body', () => {
    // Contract for "Add files to auto-commit notice payload": the rendered
    // sentence must surface how many files were captured so the operator can
    // verify what Mars touched without opening a git log.
    const body = bodyFor('merge.operator-auto-commit')
    const { files } = payloads['merge.operator-auto-commit']
    expect(body).toContain(`${files.length} uncommitted files`)
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

  it('includes a revert-auto-commit verb offer for the auto-commit notice encoding commitSha and files', () => {
    // Contract for "Add revert offer to auto-commit notice" (DEC-3): an offer
    // with id 'revert' must be present, typed as a daemon verb with
    // op='revert-auto-commit', and carry a JSON-serialised { commitSha, files }
    // entityId so the handler knows exactly which commit to revert and can
    // surface the affected paths to the operator.
    const p = payloads['merge.operator-auto-commit']
    const offers = offersForConversationNotice('merge.operator-auto-commit', p)
    const revert = offers.find((o) => o.id === 'revert')
    expect(revert, 'revert offer').toBeDefined()
    expect(revert!.label).toBe('Undo this commit')
    expect(revert!.target.type).toBe('verb')
    // Narrow to verb target so TS knows `op` and `entityId` exist.
    if (revert!.target.type !== 'verb') throw new Error('not a verb target')
    expect(revert!.target.op).toBe('revert-auto-commit')
    const decoded = JSON.parse(revert!.target.entityId as string)
    expect(decoded).toEqual({ commitSha: p.commitSha, files: p.files })
  })
})

describe('isActionableConversationNotice', () => {
  it('returns true for notices that require operator attention', () => {
    expect(isActionableConversationNotice('failure.batch')).toBe(true)
    expect(isActionableConversationNotice('gate.main-broken')).toBe(true)
    expect(isActionableConversationNotice('merge.operator-auto-commit')).toBe(true)
    expect(isActionableConversationNotice('observation.manual-push')).toBe(true)
    expect(isActionableConversationNotice('session.idle-proposal')).toBe(true)
    expect(isActionableConversationNotice('steward.prompt-optimizer-ack')).toBe(true)
    expect(isActionableConversationNotice('steward.workflow-patch')).toBe(true)
  })

  it('returns false for informational notices that may be coalesced', () => {
    expect(isActionableConversationNotice('recipe.auto-applied')).toBe(false)
    expect(isActionableConversationNotice('suggestion.codegraph')).toBe(false)
    expect(isActionableConversationNotice('trend.token-spend')).toBe(false)
  })
})

describe('collapseKeyForConversationNotice', () => {
  it('returns a key for non-actionable notices eligible for coalescing', () => {
    expect(collapseKeyForConversationNotice('recipe.auto-applied')).toBe('recipe-auto-applied')
    expect(collapseKeyForConversationNotice('suggestion.codegraph')).toBe('codegraph-suggestion')
    expect(collapseKeyForConversationNotice('trend.token-spend')).toBe('token-spend-trend')
  })

  it('returns undefined for actionable notices (coalescing is not applicable)', () => {
    for (const kind of AutonomousNoticeKindSchema.options) {
      if (isActionableConversationNotice(kind)) {
        expect(collapseKeyForConversationNotice(kind), kind).toBeUndefined()
      }
    }
  })
})

