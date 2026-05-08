import { describe, expect, it } from 'vitest'
import {
  computeFailureSignature,
  firstNonBlankLine,
} from '../failure-signature'

describe('computeFailureSignature', () => {
  it('produces identical signatures for identical inputs', () => {
    const a = computeFailureSignature('verify', 'TS2304: Cannot find name foo')
    const b = computeFailureSignature('verify', 'TS2304: Cannot find name foo')
    expect(a).toBe(b)
  })

  it('produces different signatures when first error lines differ', () => {
    const a = computeFailureSignature('verify', 'TS2304: Cannot find name foo')
    const b = computeFailureSignature('verify', 'TS2305: Cannot find name bar')
    expect(a).not.toBe(b)
  })

  it('ignores ANSI escape codes', () => {
    const plain = computeFailureSignature('verify', 'error: boom')
    const ansi = computeFailureSignature(
      'verify',
      '\x1B[31merror\x1B[0m: boom',
    )
    expect(plain).toBe(ansi)
  })

  it('ignores trailing whitespace and leading blank lines', () => {
    const a = computeFailureSignature('verify', 'error: boom')
    const b = computeFailureSignature('verify', '\n\n   error: boom   \n')
    expect(a).toBe(b)
  })

  it('produces different signatures when failing step differs', () => {
    const a = computeFailureSignature('verify', 'error: boom')
    const b = computeFailureSignature('merge', 'error: boom')
    expect(a).not.toBe(b)
  })

  it('returns 16-character hex signatures', () => {
    const sig = computeFailureSignature('verify', 'error: boom')
    expect(sig).toMatch(/^[0-9a-f]{16}$/)
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
