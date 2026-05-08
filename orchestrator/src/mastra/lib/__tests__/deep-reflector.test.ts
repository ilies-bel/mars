import { describe, expect, it } from 'vitest'
import { parseDeepReflectionReport } from '../deep-reflector'

describe('parseDeepReflectionReport', () => {
  it('parses a well-formed reflector output', () => {
    const text = JSON.stringify({
      summary: 'task succeeded but did not finish refactor',
      toolCallStats: { total: 12, byName: { Edit: 4, Bash: 3, Read: 5 } },
      dissonantCalls: [
        {
          eventIndex: 7,
          tool: 'Edit',
          stated_intent: 'remove the catch block',
          actual_outcome: 'catch block still present in patched file',
          severity: 'high',
          evidence: '"catch (err) {"',
        },
        {
          eventIndex: 11,
          tool: 'Bash',
          stated_intent: 'commit changes',
          actual_outcome: '"nothing to commit, working tree clean"',
          severity: 'high',
          evidence: '"nothing to commit"',
        },
      ],
      verifyMismatch: {
        claimed: 'tests pass',
        actual: 'typecheck failed: TS2304',
        severity: 'high',
      },
      thrashingPatterns: [
        { pattern: 'same file Read 5+ times', occurrences: 6, evidence: 'src/foo.ts' },
      ],
      rootCause: 'edit landed on the wrong line',
      suggestions: [
        {
          title: 'Add catch-block-removal regression test',
          prompt: 'Add a test in src/foo.test.ts that... Save your work.',
          rationale: 'event 7, 11',
          verdict: 'save',
          target_id: null,
          dup_of: null,
        },
        {
          title: 'Trivial nit',
          prompt: 'fix typo. Save your work.',
          rationale: 'minor',
          verdict: 'drop',
        },
      ],
    })
    const report = parseDeepReflectionReport(text)
    expect(report).not.toBeNull()
    expect(report?.summary).toMatch(/refactor/)
    expect(report?.toolCallStats.total).toBe(12)
    expect(report?.toolCallStats.byName.Edit).toBe(4)
    expect(report?.dissonantCalls).toHaveLength(2)
    expect(report?.dissonantCalls[0].severity).toBe('high')
    expect(report?.verifyMismatch?.severity).toBe('high')
    expect(report?.thrashingPatterns).toHaveLength(1)
    expect(report?.suggestions).toHaveLength(2)
    expect(report?.suggestions[0].verdict).toBe('save')
    expect(report?.suggestions[1].verdict).toBe('drop')
  })

  it('filters out dissonantCalls missing required fields without crashing', () => {
    const text = JSON.stringify({
      summary: 'partial output',
      toolCallStats: { total: 3, byName: { Edit: 3 } },
      dissonantCalls: [
        // valid
        {
          eventIndex: 1,
          tool: 'Edit',
          stated_intent: 'x',
          actual_outcome: 'y',
          severity: 'low',
          evidence: 'q',
        },
        // missing eventIndex
        {
          tool: 'Edit',
          stated_intent: 'x',
          actual_outcome: 'y',
          severity: 'low',
          evidence: 'q',
        },
        // missing severity
        {
          eventIndex: 2,
          tool: 'Edit',
          stated_intent: 'x',
          actual_outcome: 'y',
          evidence: 'q',
        },
        // bad severity value
        {
          eventIndex: 3,
          tool: 'Edit',
          stated_intent: 'x',
          actual_outcome: 'y',
          severity: 'critical',
          evidence: 'q',
        },
        // not an object
        'not an object',
        null,
      ],
      verifyMismatch: null,
      thrashingPatterns: [],
      rootCause: '',
      suggestions: [],
    })
    const report = parseDeepReflectionReport(text)
    expect(report).not.toBeNull()
    expect(report?.dissonantCalls).toHaveLength(1)
    expect(report?.dissonantCalls[0].eventIndex).toBe(1)
  })

  it('returns null for unparseable input', () => {
    expect(parseDeepReflectionReport('not json')).toBeNull()
  })

  it('handles empty arrays gracefully', () => {
    const text = JSON.stringify({
      summary: 'nothing to report',
      toolCallStats: { total: 0, byName: {} },
      dissonantCalls: [],
      verifyMismatch: null,
      thrashingPatterns: [],
      rootCause: 'no signal',
      suggestions: [],
    })
    const report = parseDeepReflectionReport(text)
    expect(report).not.toBeNull()
    expect(report?.dissonantCalls).toEqual([])
    expect(report?.suggestions).toEqual([])
    expect(report?.verifyMismatch).toBeNull()
  })

  it('coerces unknown verdicts to "save" and skips suggestions missing title or prompt', () => {
    const text = JSON.stringify({
      summary: '',
      toolCallStats: { total: 0, byName: {} },
      dissonantCalls: [],
      verifyMismatch: null,
      thrashingPatterns: [],
      rootCause: '',
      suggestions: [
        { title: 'Good', prompt: 'do thing. Save your work.', verdict: 'foo' },
        { title: '', prompt: 'no title' },
        { title: 'No prompt' },
      ],
    })
    const report = parseDeepReflectionReport(text)
    expect(report?.suggestions).toHaveLength(1)
    expect(report?.suggestions[0].verdict).toBe('save')
  })
})
