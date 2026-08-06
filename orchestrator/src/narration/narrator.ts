/**
 * Narrator — pure narration library (application-service layer, ADR-0055).
 *
 * Turns a span of {@link NarrationEvent}[] into deterministic, zero-token
 * narration strings. No HTTP, DB, or UI imports; no clocks; no randomness;
 * no model calls. The same input always produces the same output.
 *
 * Usage:
 *
 *   import { narrate } from './narrator.js'
 *   const lines = narrate(spanEvents)   // NarrationLine[] | null
 */

import type { NarrationEvent, NarrationLine, NarrationArcShape } from './types.js'

// ─── Canonical strings ────────────────────────────────────────────────────────

/** Produces the canonical narration text for each arc-shape. */
const arcText: Record<NarrationArcShape, (title: string) => string> = {
  landed: (title) => `${title} landed.`,
  'stumbled-recovered': (title) => `${title} stumbled but recovered.`,
  'needs-you': (title) => `${title} needs attention.`,
}

// ─── Internal accumulator ─────────────────────────────────────────────────────

interface ArcState {
  title: string
  hasLanded: boolean
  hasStumbled: boolean
  hasRecovered: boolean
  hasNeedsYou: boolean
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Narrate a span of task-lifecycle events.
 *
 * Returns one {@link NarrationLine} per recognised arc-shape in the order the
 * arcs first appeared in `events`. Returns `null` when the span is empty or
 * contains no events that resolve to a narrable arc-shape.
 *
 * Arc-shape classification (per canonical origin id):
 *
 * - **stumbled-recovered** — at least one `task.stumbled` AND one
 *   `task.recovered` for the same origin (takes precedence over needs-you).
 * - **needs-you** — at least one `task.needs-you`, OR at least one
 *   `task.stumbled` with no `task.recovered` (unresolved failure).
 * - **landed** — at least one `task.landed` with no stumble or needs-you.
 *
 * The function is a pure transformation: no side effects, no external calls.
 */
export const narrate = (events: NarrationEvent[]): NarrationLine[] | null => {
  if (events.length === 0) return null

  // Build per-arc state, preserving first-seen order via Map insertion order.
  const arcs = new Map<string, ArcState>()

  for (const event of events) {
    const originId = event.originId ?? event.taskId

    if (!arcs.has(originId)) {
      arcs.set(originId, {
        title: event.title,
        hasLanded: false,
        hasStumbled: false,
        hasRecovered: false,
        hasNeedsYou: false,
      })
    }

    const state = arcs.get(originId)!

    // Keep the title from the origin task's own event (not a recovery task's
    // title, which may differ). An origin event has no originId field.
    if (event.originId === undefined) {
      state.title = event.title
    }

    switch (event.kind) {
      case 'task.landed':
        state.hasLanded = true
        break
      case 'task.stumbled':
        state.hasStumbled = true
        break
      case 'task.recovered':
        state.hasRecovered = true
        break
      case 'task.needs-you':
        state.hasNeedsYou = true
        break
    }
  }

  const lines: NarrationLine[] = []

  for (const [originId, state] of arcs) {
    let shape: NarrationArcShape | null = null

    if (state.hasStumbled && state.hasRecovered) {
      shape = 'stumbled-recovered'
    } else if (state.hasNeedsYou || state.hasStumbled) {
      shape = 'needs-you'
    } else if (state.hasLanded) {
      shape = 'landed'
    }

    if (shape !== null) {
      lines.push({
        taskId: originId,
        title: state.title,
        arcShape: shape,
        text: arcText[shape](state.title),
      })
    }
  }

  return lines.length > 0 ? lines : null
}
