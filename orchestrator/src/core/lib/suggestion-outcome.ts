/**
 * The discriminated-union outcome that every reflection finding must carry.
 * Either the finding binds to an existing lever (with a proposed value) or it
 * declares a lever gap (a knob Mars does not yet have).
 *
 * Extracted from reflector.ts into its own module so that proposals.ts can
 * reference the type without creating a circular import (reflector.ts already
 * imports from proposals.ts).
 *
 * Persisted as JSON in `proposals.suggestion_outcome`. A null column value
 * means the proposal pre-dates the binding feature or was created by a source
 * other than the reflector — it is "unbound", not a gap.
 */

export interface LeverBinding {
  id: string
  currentValue: string | null
  proposedValue: string
}

export interface LeverGap {
  proposedLeverId: string
  family: string
  whatItWouldControl: string
}

export type SuggestionOutcome =
  | { type: 'lever'; lever: LeverBinding }
  | { type: 'leverGap'; leverGap: LeverGap }
