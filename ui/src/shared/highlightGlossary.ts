import type { GlossaryTerm } from './schemas'

export type GlossaryHighlightSegment =
  | { kind: 'text'; value: string }
  | { kind: 'term'; value: string; term: GlossaryTerm }

/**
 * Splits transcript text into plain and glossary-term segments. Surface forms
 * are ordered longest-first so a phrase wins over a matching word within it.
 */
export function highlightGlossary(
  text: string,
  terms: GlossaryTerm[],
): GlossaryHighlightSegment[] {
  const surfaceForms = terms
    .flatMap((term) =>
      term.surfaceForms
        .filter((surfaceForm) => surfaceForm.length > 0)
        .map((surfaceForm) => ({ surfaceForm, term })),
    )
    .sort((a, b) => b.surfaceForm.length - a.surfaceForm.length)

  if (surfaceForms.length === 0) return [{ kind: 'text', value: text }]

  const pattern = surfaceForms
    .map(({ surfaceForm }) => surfaceForm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
  const matcher = new RegExp(`\\b(?:${pattern})\\b`, 'gi')
  const segments: GlossaryHighlightSegment[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = matcher.exec(text)) !== null) {
    const matchedValue = match[0]
    if (match.index > lastIndex) {
      segments.push({ kind: 'text', value: text.slice(lastIndex, match.index) })
    }

    const entry = surfaceForms.find(
      ({ surfaceForm }) => surfaceForm.toLowerCase() === matchedValue.toLowerCase(),
    )
    if (entry) {
      segments.push({ kind: 'term', value: matchedValue, term: entry.term })
    }

    lastIndex = matcher.lastIndex
  }

  if (lastIndex === 0) return [{ kind: 'text', value: text }]
  if (lastIndex < text.length) {
    segments.push({ kind: 'text', value: text.slice(lastIndex) })
  }

  return segments
}
