import { describe, expect, it } from 'vitest'
import {
  AutonomousNoticeKindSchema,
  renderConversationNotice,
} from '../conversation-copy.js'

describe('renderConversationNotice', () => {
  const payloads = {
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
  } as const

  it('renders every registered autonomous Notice as one first-person action with a reason', () => {
    for (const kind of AutonomousNoticeKindSchema.options) {
      const body = renderConversationNotice(kind, payloads[kind])

      expect(body).toMatch(/^I\s/)
      expect(body).toMatch(/^I (increased|reduced|restored|applied) /)
      expect(body).toContain(' because ')
      expect(body).toMatch(/\.$/)
      expect(body.split(/[.!?]+/).filter(Boolean)).toHaveLength(1)
    }
  })
})
