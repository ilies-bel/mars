/**
 * Narration types — pure data; no HTTP, DB, or UI references.
 *
 * Any application-service layer can construct NarrationEvent values from the
 * outbox or task store and pass them to narrate() without coupling the caller
 * to display or persistence concerns.
 */

/**
 * The kind of a single task-lifecycle event in a narration span.
 *
 * - `task.landed`   — the task reached the `done` state.
 * - `task.stumbled` — the task entered the `failed` state.
 * - `task.recovered`— a recovery task for `originId` reached the `done`
 *   state (the origin stumbled; this event marks the recovery as landed).
 * - `task.needs-you`— the task needs operator intervention (action-queue
 *   item raised, or the task is blocked without a recovery path).
 */
export type NarrationEventKind =
  | 'task.landed'
  | 'task.stumbled'
  | 'task.recovered'
  | 'task.needs-you'

export interface NarrationEvent {
  /** The id of this specific task (may be an origin or a recovery task). */
  taskId: string
  /**
   * For recovery tasks: the id of the origin task being recovered.
   * Absent for origin tasks where `taskId` IS the canonical arc root.
   */
  originId?: string
  /** Human-readable task title, used verbatim in the narration string. */
  title: string
  kind: NarrationEventKind
}

/** The three recognisable arc-shapes a span of events can resolve to. */
export type NarrationArcShape = 'landed' | 'stumbled-recovered' | 'needs-you'

export interface NarrationLine {
  /** The canonical origin task id for this arc. */
  taskId: string
  /** Human-readable title of the arc's root task. */
  title: string
  /** Classified arc-shape. */
  arcShape: NarrationArcShape
  /** The canonical, deterministic narration string for this arc. */
  text: string
}

/**
 * A digest composed for an away-span (a contiguous time window during which
 * the operator was absent). Contains the narration lines emitted for the span
 * plus per-shape counts so the caller can render a summary without re-scanning
 * the lines array.
 */
export interface AwayDigest {
  /** One narration line per resolved arc in the span, in first-seen order. */
  lines: NarrationLine[]
  /** Per-arc-shape counts. Each count is the number of arcs that resolved to
   * that shape in the span. */
  counts: {
    landed: number
    'stumbled-recovered': number
    'needs-you': number
  }
}
