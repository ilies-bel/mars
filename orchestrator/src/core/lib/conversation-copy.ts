import { z } from 'zod'

/** Kinds of autonomous, template-authored conversation Notices. */
export const AutonomousNoticeKindSchema = z.enum([
  'steward.worker-bumped',
  'steward.worker-reduced',
  'steward.worker-restored',
  'recipe.auto-applied',
  'failure.batch',
])

export type AutonomousNoticeKind = z.infer<typeof AutonomousNoticeKindSchema>

export interface AutonomousNoticePayloads {
  'steward.worker-bumped': {
      from: number
      to: number
      pending: number
      threshold: number
      sustainedSeconds: number
  }
  'steward.worker-reduced': { from: number; to: number; pagingPps: number }
  'steward.worker-restored': { from: number; to: number }
  'recipe.auto-applied': { recipeId: string; failureKind: string; targetTaskId: string }
  'failure.batch': { taskCount: number; cause: string }
}

export type AutonomousNoticePayload = AutonomousNoticePayloads[AutonomousNoticeKind]

export type AutonomousConversationNoticeInput = {
  [Kind in AutonomousNoticeKind]: {
    kind: Kind
    payload: AutonomousNoticePayloads[Kind]
  }
}[AutonomousNoticeKind]

const sentenceValue = (value: string): string => value.replace(/[.!?]+/g, ' ').trim()

/**
 * Render an autonomous event without involving a provider. Every renderer is
 * deliberately a single first-person sentence that says what changed and why.
 */
export const renderConversationNotice = <Kind extends AutonomousNoticeKind>(
  kind: Kind,
  payload: AutonomousNoticePayloads[Kind],
): string => {
  switch (kind) {
    case 'steward.worker-bumped': {
      const p = payload as AutonomousNoticePayloads['steward.worker-bumped']
      return `I increased implement workers from ${p.from} to ${p.to} because ${p.pending} tasks stayed above the ${p.threshold}-task backlog threshold for ${p.sustainedSeconds}s.`
    }
    case 'steward.worker-reduced': {
      const p = payload as AutonomousNoticePayloads['steward.worker-reduced']
      return `I reduced implement workers from ${p.from} to ${p.to} because the host was swapping at ${p.pagingPps} pages/s.`
    }
    case 'steward.worker-restored': {
      const p = payload as AutonomousNoticePayloads['steward.worker-restored']
      return `I restored implement workers from ${p.from} to ${p.to} because host pressure cleared.`
    }
    case 'recipe.auto-applied': {
      const p = payload as AutonomousNoticePayloads['recipe.auto-applied']
      return `I applied recipe ${sentenceValue(p.recipeId)} to task ${sentenceValue(p.targetTaskId)} because it matched ${sentenceValue(p.failureKind)}.`
    }
    case 'failure.batch': {
      const p = payload as AutonomousNoticePayloads['failure.batch']
      const tasks = p.taskCount === 1 ? '1 blocked task' : `${p.taskCount} blocked tasks`
      return `I am flagging ${tasks} because they share the same failure: ${sentenceValue(p.cause)}.`
    }
  }
}
