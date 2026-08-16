/**
 * deriveCause — shared plain-language failure cause derivation.
 *
 * Used by AlertCard (chat view) and TriagePage (triage view) so both render
 * the same failure description from the same detail fields.
 */

import type { AlertHumanDetail } from '@/shared/schemas'

/** Step-prefix → human-readable phrase. */
const STEP_PHRASE: Record<string, string> = {
  verify: 'verify failed',
  code: 'coder failed',
  setup: 'setup failed',
  merge: 'merge failed',
  'behaviour-verify': 'behaviour check failed',
}

/**
 * Derive a plain-language cause string from the failure signature and error
 * excerpt.  Returns undefined when neither is available.
 *
 * Format: "verify failed: <last meaningful error line>" when an excerpt is
 * present, or "verify failed (verify/unclassified)" as a fallback.
 */
export const deriveCause = (detail: AlertHumanDetail | undefined): string | undefined => {
  const sig = detail?.failureSignature
  if (!sig) return undefined
  const step = sig.split('/')[0] ?? ''
  const phrase = STEP_PHRASE[step] ?? (step ? `${step} failed` : 'failed')

  const excerpt = detail?.errorExcerpt ?? detail?.rawError
  if (excerpt) {
    const lastLine = excerpt
      .trim()
      .split('\n')
      .filter((l) => l.trim())
      .at(-1)
      ?.trim()
    if (lastLine && lastLine.length < 120) {
      return `${phrase}: ${lastLine}`
    }
  }

  // Fall back to the signature string
  return `${phrase} (${sig})`
}
