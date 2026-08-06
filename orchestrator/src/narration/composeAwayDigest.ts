/**
 * Away digest composition — application-service layer.
 *
 * Loads narration events from a caller-supplied store for a given time span
 * and passes them to the pure {@link narrate} function. Returns null when the
 * span contains no activity worth narrating (the narrator returned null).
 *
 * The events loader is injected so this function remains testable without a
 * real database and deployable against any backing store.
 */

import { narrate } from './narrator.js'
import type { NarrationEvent, AwayDigest } from './types.js'

export interface LoadEvents {
  (fromTs: number, toTs: number): Promise<NarrationEvent[]>
}

/**
 * Compose an {@link AwayDigest} for the half-open span [fromTs, toTs).
 *
 * @param fromTs  Inclusive start of the span (Unix ms timestamp).
 * @param toTs    Exclusive end of the span (Unix ms timestamp).
 * @param deps    Injected collaborators.
 * @param deps.loadEvents  Loads all {@link NarrationEvent} values that fall
 *   inside [fromTs, toTs) from the events store. The caller decides which DB
 *   table and filter expressions apply; this function is agnostic of the
 *   backing store.
 *
 * @returns The composed digest, or `null` when there is nothing worth
 *   narrating (empty span or no events that resolve to a recognised arc-shape).
 */
export const composeAwayDigest = async (
  fromTs: number,
  toTs: number,
  deps: { loadEvents: LoadEvents },
): Promise<AwayDigest | null> => {
  const events = await deps.loadEvents(fromTs, toTs)
  const lines = narrate(events)

  if (lines === null) return null

  return {
    lines,
    counts: {
      landed: lines.filter((l) => l.arcShape === 'landed').length,
      'stumbled-recovered': lines.filter((l) => l.arcShape === 'stumbled-recovered').length,
      'needs-you': lines.filter((l) => l.arcShape === 'needs-you').length,
    },
  }
}
