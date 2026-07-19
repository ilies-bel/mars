/**
 * Types for the skill-forge pipeline.
 *
 * A CrossArcLesson is a recurring insight distilled from multiple arc
 * reflections — a pattern or practice worth encoding as a draft skill.
 */

export interface CrossArcLesson {
  /** Human-readable title; used to derive the skill slug. */
  title: string
  /** One-paragraph summary of the lesson. Used in the skill description. */
  summary: string
  /** Phrases that should trigger the skill; included in the description field. */
  triggerPhrases: string[]
  /** Optional extended body content for the skill. Falls back to summary. */
  body?: string
}
