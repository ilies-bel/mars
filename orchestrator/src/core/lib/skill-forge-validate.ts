/**
 * Adversarial validation of a synthesized skill against a motivating arc.
 *
 * Accepts the SKILL.md text and a slice of deep-reflect rows (one arc's
 * conclusions) and returns a verdict indicating whether the arc's content
 * actually supports the skill's trigger phrases.
 *
 * Pure function — no I/O, no side effects.
 */

import type { DeepReflectRow } from './skill-forge-detector'

export type ValidationVerdict = 'applies' | 'misses'

export interface ValidationResult {
  verdict: ValidationVerdict
  evidence: string
}

/**
 * Extract trigger keywords from the frontmatter `description:` field.
 *
 * The synthesizer writes descriptions in the form:
 *   "<summary> Use when the user mentions: <kw1>, <kw2>, ..."
 *
 * This function extracts the comma-separated keywords after that sentinel.
 * If the sentinel is absent it falls back to the full description as a
 * single keyword.
 */
function parseTriggerKeywords(skillMarkdown: string): string[] {
  const descMatch = skillMarkdown.match(/^description:\s*(.+)$/m)
  if (!descMatch) return []

  const description = descMatch[1].trim()

  const mentionsMatch = description.match(/Use when the user mentions:\s*(.+?)\.?\s*$/)
  if (!mentionsMatch) {
    return [description]
  }

  const triggerPart = mentionsMatch[1].trim().replace(/\.$/, '')
  return triggerPart
    .split(/,\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Check whether any deep-reflect row's `summary` (the arc conclusion text)
 * mentions at least one of the skill's trigger keywords.
 *
 * Returns `'applies'` with the matching snippet as evidence when a keyword
 * is found, or `'misses'` with a diagnostic string when nothing matches.
 */
export function validateSkillAgainstArc(
  skillMarkdown: string,
  arcRows: DeepReflectRow[],
): ValidationResult {
  const keywords = parseTriggerKeywords(skillMarkdown)

  if (keywords.length === 0) {
    return {
      verdict: 'misses',
      evidence: 'no trigger keywords could be parsed from skill description',
    }
  }

  for (const row of arcRows) {
    const conclusion = row.summary.toLowerCase()
    for (const keyword of keywords) {
      if (conclusion.includes(keyword.toLowerCase())) {
        const snippet =
          row.summary.length > 120 ? row.summary.slice(0, 120) + '…' : row.summary
        return { verdict: 'applies', evidence: snippet }
      }
    }
  }

  return {
    verdict: 'misses',
    evidence: `no arc row conclusion mentions any of: ${keywords.join(', ')}`,
  }
}
