/**
 * Plain-English phrasing for the daemon's failure signatures and cause codes.
 *
 * These are pure string functions with no React and no I/O, but they lived in
 * AlertCard.tsx — a component module — and four other modules imported them
 * from there. Every test that rendered one of those four had to mock the whole
 * card just to reach a `replace`, and adding a second helper immediately broke
 * four unrelated suites on a missing mock export. Text rules belong beside the
 * other text rules, not inside the largest component that happens to use them.
 *
 * The rule these encode (DEC-18): a raw slug never appears on the face of a
 * card. It may appear behind the "Technical details" disclosure, where the
 * reader has asked for the machine's own words.
 */
// ---------------------------------------------------------------------------
// Signature family → plain phrase mapping (DEC-18: slugs stay behind disclosure)
// ---------------------------------------------------------------------------

/**
 * Map a failure signature (e.g. "merge:hard-timeout") to a plain English phrase
 * shown as the secondary headline on task-failure cards.
 * Exact match is tried first; on miss, only the family prefix before ":" is used.
 * Raw slugs must NEVER appear on the face of the card — only behind the
 * "Technical details" disclosure.
 */
const SIGNATURE_FAMILY_PHRASES: Record<string, string> = {
  'merge:hard-timeout': 'Could not be merged — the merge step timed out',
  'merge:conflict':     'Could not be merged — there were conflicts',
  'merge:dirty-main':   'Could not be merged — the integration branch was dirty',
  'merge:crashed':      'Merge failed inside Mars (internal error)',
  merge:               'Could not be merged',
  'verify:has-diff':   'Verification failed — the branch has uncommitted changes',
  'verify:dirty-main': 'Verification failed — integration branch was dirty',
  verify:             'Verification failed',
  'code:timeout':     'Coding step timed out',
  code:              'Coding step failed',
  'setup:':           'Setup step failed',
  setup:             'Setup step failed',
  'done-with-unverifiable-merge': 'Merged, but the merge could not be verified',
}

export const signatureFamilyPhrase = (sig: string | undefined): string | undefined => {
  if (!sig) return undefined
  if (SIGNATURE_FAMILY_PHRASES[sig]) return SIGNATURE_FAMILY_PHRASES[sig]
  // Signatures can carry an error-class suffix after '/' (e.g. 'merge:crashed/unclassified').
  // Strip the error-class first so 'merge:crashed' is matched before falling
  // back to the bare gate-family prefix before ':'.
  const step = sig.split('/')[0]!
  if (SIGNATURE_FAMILY_PHRASES[step]) return SIGNATURE_FAMILY_PHRASES[step]
  const gate = step.split(':')[0]!
  // Try the bare family name with and without the trailing ':' sentinel the
  // lookup table uses (e.g. 'verify:' matches 'verify' after stripping).
  return SIGNATURE_FAMILY_PHRASES[gate] ?? SIGNATURE_FAMILY_PHRASES[gate + ':']
}

// ---------------------------------------------------------------------------
// Cause-group phrasing
// ---------------------------------------------------------------------------

/**
 * True when `text` is a machine identifier rather than something written for a
 * person: a lowercase slug with no spaces, joined by `-`, `/`, `:` or `_`.
 * `unclassified`, `code/unclassified` and `done-with-unverifiable-merge` all
 * match; `slice workflow failed — error: ...` does not.
 */
const isSlug = (text: string): boolean => /^[a-z0-9]+(?:[-/:_][a-z0-9]+)*$/.test(text)

/**
 * Make one raw cause string readable without inventing meaning it does not
 * carry. Two shapes arrive from the daemon:
 *
 *  - a slug (`done-with-unverifiable-merge`) — separators become spaces and
 *    the first letter is capitalised. Still terse, but English.
 *  - a truncated error blob (`slice workflow failed — error: provider worker
 *    exited 1: API Error: Connectio…`) — the `error:` label is dropped and the
 *    fragment the daemon cut mid-word is removed, because half a word carries
 *    no information and reads as a rendering bug.
 *
 * Neither branch paraphrases: the words that survive are the daemon's own.
 */
const humanizeCause = (raw: string): string => {
  let text = raw.trim()
  if (isSlug(text)) {
    text = text.replace(/[-/:_]+/g, ' ')
  } else {
    // Drop a trailing fragment the daemon truncated mid-word ("… Connectio…").
    text = text.replace(/\s*[—:-]?\s*[^\s:—]*…\s*$/, '')
    // "— error: provider worker exited" reads as "— provider worker exited".
    text = text.replace(/\berror:\s*/gi, '')
    text = text.replace(/\s{2,}/g, ' ').replace(/[\s—:-]+$/, '')
  }
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * The sentence a cause-group row shows on its face.
 *
 * The mapped phrase wins over the daemon's `causeLabel`, which is the reverse
 * of the order this row used to apply. `causeLabel` is frequently the raw
 * failure slug — a live queue showed `unclassified` and
 * `done-with-unverifiable-merge` printed verbatim on three cards — and
 * preferring it meant a good phrase already sitting in the table below was
 * never reached: `signatureFamilyPhrase('code/unclassified')` returns
 * "Coding step failed", but `causeLabel` shadowed it with "unclassified".
 *
 * That also restores the rule this module states for task cards — raw slugs
 * never appear on the face, only behind the disclosure — to the group rows,
 * which were the one surface still breaking it.
 */
export const causeGroupPhrase = (
  signature: string | undefined,
  causeLabel: string | undefined,
): string => {
  const mapped = signatureFamilyPhrase(signature)
  if (mapped) {
    // `code/unclassified` means the coder failed and nothing recognised why.
    // The mapped phrase alone ("Coding step failed") silently drops that, and
    // an operator reading it cannot tell whether Mars diagnosed the failure or
    // gave up on it — which is the difference between "read the details" and
    // "nobody has looked at this yet".
    return signature?.endsWith('/unclassified') === true
      ? `${mapped} — cause not identified`
      : mapped
  }
  if (causeLabel?.trim()) return humanizeCause(causeLabel)
  if (signature?.trim()) return humanizeCause(signature)
  return 'Cause not identified'
}
