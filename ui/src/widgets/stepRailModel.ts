/**
 * Step-rail model — the ordered, typed structure behind the drawer's "Steps
 * that ran" rail: which attempt each card is, its duration and outcome labels,
 * its token line, and whether the failure signature blames a phase that left no
 * step of its own.
 *
 * Pure model function `buildStepRail` is exported for unit testing without a DOM;
 * the drawer's StepCardList only renders its output.
 */
import { formatDuration } from '@/shared/time'
import { formatTokensLabel } from '@/shared/displayStrings'
import type { StepCardEntry } from './TaskDetailDrawer'

export type StepOutcome = StepCardEntry['outcome']

/** Outcome → short human label for a timeline row. */
export const outcomeLabel = (outcome: StepOutcome): string => {
  switch (outcome) {
    case 'running':
      return 'running…'
    case 'completed':
      return 'done'
    case 'failed':
      return 'failed'
    case 'killed':
      return 'killed'
  }
}

/** The pipeline phase a failure signature blames — the word before the colon. */
export const blamedPhaseOf = (signature: string | null | undefined): string | null => {
  if (signature == null || signature === '') return null
  const head = signature.split(':')[0]?.trim().toLowerCase() ?? ''
  return ['setup', 'code', 'verify', 'merge'].includes(head) ? head : null
}

/**
 * True when `blamedPhase` names a phase that none of `stepNames` carries — the
 * failure is blamed on something that ran after (or never produced) a step.
 */
export const isBlamedPhaseUnmatched = (
  blamedPhase: string | null | undefined,
  stepNames: string[],
): boolean =>
  blamedPhase != null &&
  blamedPhase !== '' &&
  !stepNames.some((n) => n.toLowerCase().includes(blamedPhase.toLowerCase()))

export interface StepRailRow {
  card: StepCardEntry
  /** Which run of this step the card is; set only when the step ran more than once. */
  attempt?: number
  attemptsTotal?: number
  outcomeLabel: string
  /** Formatted duration (`3.2s`, `53m 26s`), or null while in flight. */
  durationLabel: string | null
  /** "in N · out N · cached N" line, or null for non-LLM steps. */
  tokensLabel: string | null
}

export interface StepRail {
  rows: StepRailRow[]
  /**
   * The blamed phase when no row carries that name (e.g. `merge` after a passed
   * verify), else null. Drives the "which ran vs which is blamed" narration.
   */
  blamedPhaseGap: string | null
}

export const buildStepRail = (
  cards: StepCardEntry[],
  blamedPhase?: string | null,
): StepRail => {
  const rows = cards.map((card, i): StepRailRow => {
    const runsOfThisStep = cards.filter((c) => c.stepName === card.stepName).length
    const attemptIndex = cards.slice(0, i + 1).filter((c) => c.stepName === card.stepName).length
    return {
      card,
      attempt: runsOfThisStep > 1 ? attemptIndex : undefined,
      attemptsTotal: runsOfThisStep > 1 ? runsOfThisStep : undefined,
      outcomeLabel: outcomeLabel(card.outcome),
      durationLabel: card.durationMs != null ? formatDuration(card.durationMs) : null,
      tokensLabel: formatTokensLabel(card.inputTokens, card.outputTokens, card.cacheReadTokens),
    }
  })
  return {
    rows,
    blamedPhaseGap:
      blamedPhase != null &&
      isBlamedPhaseUnmatched(
        blamedPhase,
        cards.map((c) => c.stepName),
      )
        ? blamedPhase
        : null,
  }
}
