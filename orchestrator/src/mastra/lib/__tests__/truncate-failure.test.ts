import { describe, expect, it } from 'vitest'
import { truncateFailure } from '../truncate-failure'

describe('truncateFailure', () => {
  it('returns short input unchanged', () => {
    const input = 'Error: something went wrong\n  at foo (bar.ts:1:2)'
    expect(truncateFailure(input, 2000)).toBe(input)
  })

  it('keeps the tail and prepends a truncation marker for long input', () => {
    const tail = 'Error: the real failure\n  at actualStack (real.ts:42:7)'
    const input = 'x'.repeat(3000) + tail

    const result = truncateFailure(input, 2000)

    // Tail content is preserved
    expect(result).toContain('Error: the real failure')
    expect(result).toContain('at actualStack (real.ts:42:7)')

    // Head content is dropped
    expect(result.length).toBeLessThanOrEqual(2000 + 100) // marker overhead

    // Truncation marker is present
    expect(result).toMatch(/\[…truncated/)
  })
})
