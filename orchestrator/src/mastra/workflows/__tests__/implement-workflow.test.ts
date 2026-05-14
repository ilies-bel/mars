import { describe, it, expect } from 'vitest'
import { COMMIT_FOOTER, composePrompt } from '../implement-workflow'

describe('composePrompt', () => {
  it('appends the commit footer to a bare prompt', () => {
    const out = composePrompt('do the thing', null)
    expect(out.endsWith(COMMIT_FOOTER)).toBe(true)
    expect(out.startsWith('do the thing')).toBe(true)
  })

  it('appends the commit footer after the plan sections', () => {
    const out = composePrompt('do the thing', {
      functional: 'F',
      technical: 'T',
    })
    expect(out.endsWith(COMMIT_FOOTER)).toBe(true)
    const fIdx = out.indexOf('## Functional plan')
    const tIdx = out.indexOf('## Technical plan')
    const cIdx = out.indexOf(COMMIT_FOOTER)
    expect(fIdx).toBeGreaterThan(-1)
    expect(tIdx).toBeGreaterThan(fIdx)
    expect(cIdx).toBeGreaterThan(tIdx)
  })

  it('mentions git add and git commit explicitly', () => {
    expect(COMMIT_FOOTER).toContain('git add')
    expect(COMMIT_FOOTER).toContain('git commit')
  })

  it('warns about the no-commits-ahead failure signature', () => {
    expect(COMMIT_FOOTER).toContain('verify:has-diff/no-commits-ahead')
  })
})
