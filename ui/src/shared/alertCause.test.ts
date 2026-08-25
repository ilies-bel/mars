/**
 * deriveCause — the one-line failure cause under an alert headline.
 *
 * The bar is that it reads as English. A failure signature is
 * `<step>[:<substep>]/<error-class>`, and the operator-facing copy must name
 * the step in words, never echo the raw id back at them.
 */

import { describe, it, expect } from 'vitest'
import { deriveCause } from './alertCause'
import type { AlertHumanDetail } from '@/shared/schemas'

const detail = (over: Partial<AlertHumanDetail>): AlertHumanDetail =>
  ({ failureSignature: 'verify/unclassified', ...over }) as AlertHumanDetail

describe('deriveCause', () => {
  it('returns nothing when the row carries no signature', () => {
    expect(deriveCause(undefined)).toBeUndefined()
    expect(deriveCause(detail({ failureSignature: '' }))).toBeUndefined()
  })

  it('names the step family in words for a bare signature', () => {
    expect(deriveCause(detail({ failureSignature: 'verify/unclassified' }))).toContain(
      'verify failed',
    )
  })

  it('names the step family in words when the signature carries a substep', () => {
    // Splitting on '/' alone left `code:context-exhausted` as the "step", which
    // matched no phrase and produced "code:context-exhausted failed" — a raw
    // step id in operator copy, which the failure-kind registry explicitly
    // forbids for exactly this reason.
    const cause = deriveCause(detail({ failureSignature: 'code:context-exhausted/unclassified' }))
    expect(cause).toContain('coder failed')
    expect(cause).not.toContain('code:context-exhausted failed')
  })

  it('resolves a verify substep to the verify phrase', () => {
    const cause = deriveCause(detail({ failureSignature: 'verify:typecheck/typecheck-error' }))
    expect(cause).toContain('verify failed')
    expect(cause).not.toContain('verify:typecheck failed')
  })

  it('prefers the error excerpt over the bare signature', () => {
    const cause = deriveCause(
      detail({
        failureSignature: 'code:context-exhausted/unclassified',
        errorExcerpt: 'context budget exhausted (maxContextTokens) mid-code',
      }),
    )
    expect(cause).toBe('coder failed: context budget exhausted (maxContextTokens) mid-code')
  })

  it('falls back to the signature when no excerpt is available', () => {
    const cause = deriveCause(detail({ failureSignature: 'merge:conflict/unclassified' }))
    expect(cause).toBe('merge failed (merge:conflict/unclassified)')
  })
})

describe('floor guard', () => {
  it('strips node boilerplate "(Use ..." from the last line', () => {
    const cause = deriveCause(
      detail({
        failureSignature: 'verify/unclassified',
        errorExcerpt:
          'ReferenceError: x is not defined\n(Use `node --trace-warnings ...` to show where the warning was created)',
      }),
    )
    expect(cause).toBe('verify failed (verify/unclassified)')
  })

  it('strips a bare path(line,col): fragment with no message', () => {
    const cause = deriveCause(
      detail({
        failureSignature: 'verify/unclassified',
        errorExcerpt: 'some build output\nsrc/foo.ts(3,31):',
      }),
    )
    expect(cause).toBe('verify failed (verify/unclassified)')
  })

  it('strips a last line with fewer than 10 non-whitespace characters', () => {
    const cause = deriveCause(
      detail({
        failureSignature: 'verify/unclassified',
        errorExcerpt: 'Failed to compile\n...',
      }),
    )
    expect(cause).toBe('verify failed (verify/unclassified)')
  })

  it('strips a truncated "or" fragment under 5 chars', () => {
    const cause = deriveCause(
      detail({
        failureSignature: 'verify/unclassified',
        errorExcerpt: 'some error\nor',
      }),
    )
    expect(cause).toBe('verify failed (verify/unclassified)')
  })

  it('still appends a well-formed TypeScript error message', () => {
    const cause = deriveCause(
      detail({
        failureSignature: 'verify/unclassified',
        errorExcerpt:
          'src/foo.ts(3,31): error TS2339: Property x does not exist on type Y',
      }),
    )
    expect(cause).toBe(
      'verify failed: src/foo.ts(3,31): error TS2339: Property x does not exist on type Y',
    )
  })
})
