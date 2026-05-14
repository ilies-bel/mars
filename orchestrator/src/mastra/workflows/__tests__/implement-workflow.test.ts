import { describe, it, expect } from 'vitest'
import {
  COMMIT_FOOTER,
  WRITER_FOOTER,
  WRITER_SYSTEM_PROMPT,
  composePrompt,
} from '../implement-workflow'

describe('composePrompt — coder default', () => {
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

  it('defaults to the coder footer when no tag is supplied', () => {
    const out = composePrompt('do the thing', null)
    expect(out).toContain('git add')
    expect(out).not.toContain('mars glossary set')
  })
})

describe('composePrompt — writer routing', () => {
  it('appends the writer footer (not the coder commit footer) when tag is "writer"', () => {
    const out = composePrompt('add glossary terms', null, 'writer')
    expect(out.endsWith(WRITER_FOOTER)).toBe(true)
    expect(out).not.toContain(COMMIT_FOOTER)
  })

  it('writer footer names the canonical structured-write verbs', () => {
    expect(WRITER_FOOTER).toContain('mars glossary set')
    expect(WRITER_FOOTER).toContain('mars glossary remove')
    expect(WRITER_FOOTER).toContain('mars adr add')
  })

  it('writer footer makes clear the agent does not commit from the worktree', () => {
    expect(WRITER_FOOTER).toMatch(/daemon owns the commit|do not run `git/i)
  })

  it('writer system prompt disables Edit/Write/NotebookEdit explicitly', () => {
    expect(WRITER_SYSTEM_PROMPT).toContain('Edit, Write, and NotebookEdit are disabled')
  })

  it('writer system prompt names every supported verb so the agent has a closed list', () => {
    expect(WRITER_SYSTEM_PROMPT).toContain('mars glossary set')
    expect(WRITER_SYSTEM_PROMPT).toContain('mars glossary remove')
    expect(WRITER_SYSTEM_PROMPT).toContain('mars adr add')
  })
})
