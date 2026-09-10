/**
 * Splitting a deferred proposal into the part it shares with its siblings and
 * the part that is its own.
 *
 * When a PRD defers work, every resulting proposal opens with the same three
 * lines: which PRD it came from, a sentence of scaffolding, and only THEN the
 * blockquote describing this particular deliverable. Previewing the first ~200
 * characters therefore previewed the provenance, and a screen of deferred
 * siblings rendered as several stacked paragraphs of byte-identical text —
 * the distinguishing sentence sat below the fold in every one of them.
 *
 * The titles were always distinct. Only the preview lied.
 */

export interface ProposalProvenance {
  /** The PRD id, e.g. `cd54a867-make-mars-support-a-real-ddd-practice`. */
  prdId: string
  /** The PRD's readable title, when the sentence carried one. */
  prdTitle: string | null
}

export interface SplitProblem {
  /** Present only when the text opened with the deferral preamble. */
  provenance: ProposalProvenance | null
  /** The text worth previewing: this proposal's own description. */
  lead: string
}

const PREAMBLE = /^\s*Deferred from PRD\s+`([^`]+)`\s*/

/** Reads a parenthesised title, honouring nesting, from `text` at `open`. */
const balancedParen = (text: string, open: number): { body: string; end: number } | null => {
  if (text[open] !== '(') return null
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')') {
      depth--
      if (depth === 0) return { body: text.slice(open + 1, i), end: i }
    }
  }
  return null
}

/**
 * Separates the shared deferral preamble from this proposal's own text.
 *
 * Text that does not open with the preamble is returned untouched with a null
 * provenance, so a hand-written proposal is never reshaped by this.
 */
export const splitDeferredProblem = (problem: string | null | undefined): SplitProblem => {
  const raw = (problem ?? '').trim()
  if (raw === '') return { provenance: null, lead: '' }

  const m = PREAMBLE.exec(raw)
  if (m === null) return { provenance: null, lead: raw }

  let rest = raw.slice(m[0].length)
  let prdTitle: string | null = null

  const paren = balancedParen(rest, 0)
  if (paren !== null) {
    prdTitle = paren.body.trim() || null
    rest = rest.slice(paren.end + 1)
  }
  // Drop the sentence terminator the preamble ends on.
  rest = rest.replace(/^\s*[.:]\s*/, '')

  // Drop the scaffolding line. It says nothing a reader needs and it is
  // identical across every deferred proposal.
  rest = rest.replace(
    /^\s*The original out-of-scope entry that describes this deliverable:\s*/i,
    '',
  )

  // The deliverable is quoted. Unquote it so it reads as the proposal's own
  // words rather than as something being cited.
  const lead = rest
    .split('\n')
    .map((line) => line.replace(/^\s*>\s?/, ''))
    .join('\n')
    .trim()

  return {
    provenance: { prdId: m[1], prdTitle },
    // A preamble with nothing after it still has to preview as something.
    lead: lead === '' ? raw : lead,
  }
}

/** Short, stable label for a provenance line: `from PRD cd54a867`. */
export const provenanceLabel = (p: ProposalProvenance): string =>
  `from PRD ${p.prdId.split('-')[0]}`

/**
 * Drops a section's text from the front of `notes` when the notes literally
 * open with a verbatim copy of it.
 *
 * Observed on a real `failure-reflector` proposal: its Notes field is 2119
 * characters, the first 760 of which are its Problem field, byte for byte,
 * followed by a genuinely different note about a different task. Rendered as
 * two adjacent sections, the drawer read as if it were stuck — you scroll
 * past a paragraph you just finished reading to reach the new content.
 *
 * Only an exact prefix is removed, after whitespace normalisation. Notes that
 * merely restate the problem in other words are left alone: paraphrase is
 * authorship, and deciding it is redundant is not the renderer's call.
 */
export const stripRepeatedPrefix = (notes: string, ...sections: string[]): string => {
  let out = notes
  for (const section of sections) {
    const s = section.trim()
    if (s.length < 40) continue
    const head = out.trimStart()
    if (head.startsWith(s)) out = head.slice(s.length)
  }
  return out.trim()
}
