import { describe, it, expect } from 'vitest'
import { shortId } from '../short-id'

describe('shortId', () => {
  it('keeps the mars- prefix and 8 hex chars', () => {
    expect(shortId('mars-2e2bf341')).toBe('mars-2e2bf341')
    expect(shortId('mars-2e2bf3411111')).toBe('mars-2e2bf341')
  })

  it('keeps other kind-prefixes (reflect-)', () => {
    expect(shortId('reflect-09abf133')).toBe('reflect-09abf133')
  })

  it('takes 8 chars from a bare hex id', () => {
    expect(shortId('79dc0844')).toBe('79dc0844')
    expect(shortId('79dc08440000')).toBe('79dc0844')
  })

  it('treats hex-prefix-then-slug ids (idea ids) as bare 8-hex', () => {
    expect(shortId('578ab441-design-a-per-blocked-task-recovery-timel')).toBe('578ab441')
    expect(shortId('48c598b7-fix-git-worktree-remove-crash-on-missing')).toBe('48c598b7')
  })
})
