/**
 * Cross-arc lesson detector.
 *
 * Accepts a flat list of deep-reflect conclusion rows (one row = one saved
 * verdict from a single arc's reflection report) and returns only the lessons
 * that recur across 3 or more distinct arc origin IDs.  The function is pure
 * and deterministic — no I/O, no randomness.
 *
 * A CrossArcLesson is a recurring insight distilled from multiple arc
 * reflections — a pattern or practice worth encoding as a draft skill. It is
 * the hand-off type between this detector and `skill-forge-synthesizer.ts`,
 * which renders it into a draft SKILL.md.
 */

export interface DeepReflectRow {
  /** The arc (origin task ID) this conclusion came from. */
  originId: string
  /** Short imperative title of the saved suggestion. */
  title: string
  /**
   * Stable snake_case slug identifying the root cause category
   * (mirrors {@link VerdictedSuggestion.rootCauseKey} from reflector.ts).
   */
  rootCauseKey: string
  /** Human-readable summary / rationale for the lesson. */
  summary: string
}

export interface CrossArcLesson {
  /** Stable key derived from the slugified title and normalised root-cause. */
  key: string
  /** Human label for the lesson (taken from the first row in the cluster). */
  title: string
  /** Representative summary (taken from the first row in the cluster). */
  summary: string
  /**
   * Distinct arc origin IDs where this lesson was observed.
   * Always has length >= 3 (clusters with fewer are filtered out).
   */
  motivatingArcOriginIds: string[]
  /**
   * Phrases that should trigger the synthesized skill; included in the
   * description field. Optional — the detector does not infer trigger
   * phrases, so the synthesizer falls back to the lesson title.
   */
  triggerPhrases?: string[]
  /** Optional extended body content for the skill. Falls back to summary. */
  body?: string
}

const slugify = (text: string): string =>
  text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

const normaliseRootCauseKey = (key: string): string =>
  key.toLowerCase().trim().replace(/\s+/g, '-')

const deriveKey = (row: DeepReflectRow): string =>
  `${slugify(row.title)}::${normaliseRootCauseKey(row.rootCauseKey)}`

/**
 * Group `rows` by a stable lesson-key and return only the clusters that
 * appear in at least 3 distinct arc origin IDs.
 */
export const detectCrossArcLessons = (rows: DeepReflectRow[]): CrossArcLesson[] => {
  const groups = new Map<string, { title: string; summary: string; originIds: Set<string> }>()

  for (const row of rows) {
    const key = deriveKey(row)
    const existing = groups.get(key)
    if (existing) {
      existing.originIds.add(row.originId)
    } else {
      groups.set(key, { title: row.title, summary: row.summary, originIds: new Set([row.originId]) })
    }
  }

  const lessons: CrossArcLesson[] = []
  for (const [key, group] of groups) {
    if (group.originIds.size >= 3) {
      lessons.push({
        key,
        title: group.title,
        summary: group.summary,
        motivatingArcOriginIds: Array.from(group.originIds),
      })
    }
  }
  return lessons
}
