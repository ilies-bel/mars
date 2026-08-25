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
  // A signature is `<step>[:<substep>]/<error-class>`. Splitting on '/' alone
  // yields `code:context-exhausted`, which matches no phrase and leaks a raw
  // step id into operator copy ("code:context-exhausted failed"). The step
  // FAMILY is everything before the first ':' — that is what the phrase map is
  // keyed on, and what a bare `verify/unclassified` already resolved to.
  const step = (sig.split('/')[0] ?? '').split(':')[0] ?? ''
  const phrase = STEP_PHRASE[step] ?? (step ? `${step} failed` : 'failed')

  const excerpt = detail?.errorExcerpt ?? detail?.rawError
  if (excerpt) {
    const lastLine = excerpt
      .trim()
      .split('\n')
      .filter((l) => l.trim())
      .at(-1)
      ?.trim()
    // Floor guard: skip last lines that carry no useful signal — node boilerplate
    // hints, bare path(line,col): fragments with no message, very short punctuation
    // noise, or truncated "or" fragments.  These make the card harder to read, not
    // easier, so fall through to the signature-based fallback instead.
    const uninformative =
      !!lastLine &&
      (lastLine.startsWith('(Use ') ||
        /^\S+\(\d+,\d+\):\s*$/.test(lastLine) ||
        lastLine.replace(/\s/g, '').length < 10 ||
        (lastLine.startsWith('or') && lastLine.length < 5))
    if (!uninformative && lastLine && lastLine.length < 120) {
      return `${phrase}: ${lastLine}`
    }
  }

  // Fall back to the signature string
  return `${phrase} (${sig})`
}
