import { describe, expect, it } from 'bun:test'
import { splitDeferredProblem, provenanceLabel, stripRepeatedPrefix } from './proposalPreview'

const PRD = 'cd54a867-make-mars-support-a-real-ddd-practice'
const PREAMBLE =
  'Deferred from PRD `' +
  PRD +
  '` (Model the business behaviour each change alters as a Domain Flow, so the ' +
  'operator can steer a change’s domain impact at planning time instead of ' +
  'discovering it in the diff).\n\n' +
  'The original out-of-scope entry that describes this deliverable:\n\n'

const deferred = (own: string): string => PREAMBLE + '> ' + own

describe('splitDeferredProblem', () => {
  it('leads with the sentence that differs, not the shared preamble', () => {
    const own =
      'Giving glossary terms a bounded-context dimension. Filed separately ' +
      'after this session hit a real term collision.'
    const { lead } = splitDeferredProblem(deferred(own))
    expect(lead).toBe(own)
    expect(lead).not.toContain('Deferred from PRD')
    expect(lead).not.toContain('out-of-scope entry')
  })

  it('makes siblings distinguishable, which is the whole point', () => {
    // Three real siblings that previewed as byte-identical paragraphs.
    const a = splitDeferredProblem(deferred('Mars internal DDD hygiene.')).lead
    const b = splitDeferredProblem(deferred('Bounded-context dimension.')).lead
    const c = splitDeferredProblem(deferred('Aggregate derivation.')).lead
    expect(new Set([a, b, c]).size).toBe(3)
  })

  it('keeps the provenance rather than discarding it', () => {
    const { provenance } = splitDeferredProblem(deferred('Anything.'))
    expect(provenance?.prdId).toBe(PRD)
    expect(provenance?.prdTitle).toContain('Model the business behaviour')
    expect(provenanceLabel(provenance!)).toBe('from PRD cd54a867')
  })

  it('leaves a hand-written proposal completely alone', () => {
    const own = 'CONTEXT.md holds ~165 terms in a single flat section.'
    expect(splitDeferredProblem(own)).toEqual({ provenance: null, lead: own })
  })

  it('survives a preamble whose title contains brackets', () => {
    const text =
      'Deferred from PRD `x-y` (Merge trains (batched rebase+verify+ff)).\n\n> Do the thing.'
    const { provenance, lead } = splitDeferredProblem(text)
    expect(provenance?.prdTitle).toBe('Merge trains (batched rebase+verify+ff)')
    expect(lead).toBe('Do the thing.')
  })

  it('never previews as empty when the preamble is all there is', () => {
    const onlyPreamble = 'Deferred from PRD `x-y` (A title).'
    expect(splitDeferredProblem(onlyPreamble).lead).toBe(onlyPreamble)
  })

  it('handles absent and blank input', () => {
    expect(splitDeferredProblem(null).lead).toBe('')
    expect(splitDeferredProblem(undefined).lead).toBe('')
    expect(splitDeferredProblem('   ').lead).toBe('')
  })

  it('handles a preamble with no parenthesised title', () => {
    const { provenance, lead } = splitDeferredProblem(
      'Deferred from PRD `x-y`.\n\n> Just this.',
    )
    expect(provenance?.prdTitle).toBeNull()
    expect(lead).toBe('Just this.')
  })
})

describe('stripRepeatedPrefix', () => {
  const problem = 'A frozen-lockfile install failure indicates a network or cache environment fault when the lockfile matches HEAD.'

  it('drops a verbatim leading copy of the problem', () => {
    const notes = `${problem}\n\nSeparately: fix-5959d8c7 failed with an API-unreachable message.`
    expect(stripRepeatedPrefix(notes, problem)).toBe(
      'Separately: fix-5959d8c7 failed with an API-unreachable message.',
    )
  })

  it('leaves notes that merely paraphrase the problem alone', () => {
    // Paraphrase is authorship. Deciding it is redundant is not the
    // renderer's call — only an exact prefix is removed.
    const notes = 'The lockfile problem above is really an environment fault.'
    expect(stripRepeatedPrefix(notes, problem)).toBe(notes)
  })

  it('leaves a copy that is not at the front alone', () => {
    const notes = `Context first.\n\n${problem}`
    expect(stripRepeatedPrefix(notes, problem)).toBe(notes)
  })

  it('ignores sections too short to be meaningful duplicates', () => {
    // A 12-character "problem" prefixing the notes is a coincidence, not a
    // duplication, and stripping it would eat real text.
    const notes = 'See ADR-0094 for the reasoning behind the two row kinds.'
    expect(stripRepeatedPrefix(notes, 'See ADR-0094')).toBe(notes)
  })

  it('strips the problem and the solution independently', () => {
    const solution = 'Add a pattern for install-frozen-lockfile that maps to a new infra class.'
    const notes = `${problem}\n${solution}\nAnd the genuinely new remark.`
    expect(stripRepeatedPrefix(notes, problem, solution)).toBe('And the genuinely new remark.')
  })

  it('returns an empty string when the notes are nothing but the copy', () => {
    expect(stripRepeatedPrefix(problem, problem)).toBe('')
  })
})
