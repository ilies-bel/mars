import { describe, expect, it } from 'vitest'
import {
  classifyError,
  computeFailureSignature,
  errorClassRules,
  firstNonBlankLine,
  isUnclassifiedSignature,
  UNCLASSIFIED_ERROR_CLASS,
} from '../failure-signature'

describe('computeFailureSignature', () => {
  it('produces stable technical-key signatures of shape <failingStep>/<error-class>', () => {
    const sig = computeFailureSignature(
      'verify:has-diff',
      'no commits ahead of integration branch — task did not produce any changes',
    )
    expect(sig).toBe('verify:has-diff/no-commits-ahead')
  })

  it('matches the documented signatures from the cascade incident', () => {
    expect(
      computeFailureSignature(
        'verify:has-diff',
        'no commits ahead of integration branch',
      ),
    ).toBe('verify:has-diff/no-commits-ahead')
    expect(
      computeFailureSignature(
        'merge:preflight',
        'merge target /tmp/foo has uncommitted changes that block a fast-forward',
      ),
    ).toBe('merge:preflight/uncommitted-changes')
    expect(
      computeFailureSignature(
        'merge:preflight',
        'tracked changes on paths the fast-forward would update:\n M A\n',
      ),
    ).toBe('merge:preflight/uncommitted-changes')
    expect(
      computeFailureSignature(
        'merge:preflight',
        'task branch task/x is not a fast-forward of main (diverged or behind)',
      ),
    ).toBe('merge:preflight/not-fast-forward')
  })

  it('returns the unclassified slug when no rule matches', () => {
    const sig = computeFailureSignature(
      'verify:test',
      'something nobody has written a rule for yet',
    )
    expect(sig).toBe(`verify:test/${UNCLASSIFIED_ERROR_CLASS}`)
    expect(isUnclassifiedSignature(sig)).toBe(true)
  })

  it('produces identical signatures for identical inputs', () => {
    const a = computeFailureSignature(
      'verify:typecheck',
      'TS2304: Cannot find name foo',
    )
    const b = computeFailureSignature(
      'verify:typecheck',
      'TS2304: Cannot find name foo',
    )
    expect(a).toBe(b)
  })

  it('different first-line errors map to different classes', () => {
    expect(
      computeFailureSignature('verify:typecheck', 'TS2304: cannot find name'),
    ).toBe('verify:typecheck/typecheck-cannot-find-name')
    expect(
      computeFailureSignature(
        'verify:typecheck',
        'TS2307: cannot find module',
      ),
    ).toBe('verify:typecheck/typecheck-cannot-find-module')
  })

  it('classifies realistic tsc lines that prefix the TSxxxx code with a file location', () => {
    expect(
      classifyError(
        "src/foo.ts(1,1): error TS2322: Type 'x' is not assignable to type 'y'.",
      ),
    ).toBe('typecheck-type-mismatch')
    expect(
      classifyError("src/foo.ts(12,3): error TS2304: Cannot find name 'bar'."),
    ).toBe('typecheck-cannot-find-name')
    expect(
      classifyError(
        "src/foo.ts(4,8): error TS2307: Cannot find module 'baz' or its corresponding type declarations.",
      ),
    ).toBe('typecheck-cannot-find-module')
  })

  it('ignores ANSI escape codes when matching rules', () => {
    const plain = computeFailureSignature(
      'verify:has-diff',
      'no commits ahead of integration branch',
    )
    const ansi = computeFailureSignature(
      'verify:has-diff',
      '\x1B[31mno commits ahead of integration branch\x1B[0m',
    )
    expect(plain).toBe(ansi)
  })

  it('different failing steps produce different signatures even for the same error class', () => {
    const a = computeFailureSignature('verify:test', 'mystery boom')
    const b = computeFailureSignature('merge:crashed', 'mystery boom')
    expect(a).not.toBe(b)
  })
})

describe('classifyError', () => {
  it('returns the rule errorClass on first match (rule order wins)', () => {
    expect(classifyError('no commits ahead of integration branch')).toBe(
      'no-commits-ahead',
    )
  })

  it('returns unclassified for empty input', () => {
    expect(classifyError('')).toBe(UNCLASSIFIED_ERROR_CLASS)
    expect(classifyError('   \n\n  ')).toBe(UNCLASSIFIED_ERROR_CLASS)
  })
})

describe('errorClassRules registry', () => {
  it('every rule slug is kebab-case with no whitespace', () => {
    for (const rule of errorClassRules) {
      expect(rule.errorClass).toMatch(/^[a-z][a-z0-9-]*$/)
    }
  })

  it('errorClass slugs are unique', () => {
    const seen = new Set<string>()
    for (const rule of errorClassRules) {
      expect(seen.has(rule.errorClass)).toBe(false)
      seen.add(rule.errorClass)
    }
  })
})

describe('firstNonBlankLine', () => {
  it('returns the first non-blank trimmed line', () => {
    expect(firstNonBlankLine('\n   \n  hello\nworld')).toBe('hello')
  })

  it('returns empty string for all-blank input', () => {
    expect(firstNonBlankLine('   \n\n\t\n')).toBe('')
  })

  it('strips ANSI codes', () => {
    expect(firstNonBlankLine('\x1B[31mboom\x1B[0m')).toBe('boom')
  })
})
