import { describe, expect, it } from 'vitest'
import { buildDiagnoseChorePrompt } from '../diagnose-chore'
import type { ReadSpanTrace } from '../read-span-watch'

const TRACE: readonly ReadSpanTrace[] = [
  { tool: 'Read', target: 'src/foo.ts' },
  { tool: 'Read', target: 'src/bar.ts' },
  { tool: 'Grep', target: 'fooImpl' },
  { tool: 'Read', target: 'src/baz.ts' },
  { tool: 'Glob', target: 'src/**/*.ts' },
]

describe('buildDiagnoseChorePrompt', () => {
  it('includes the parent task id, parent prompt, and read trail', () => {
    const out = buildDiagnoseChorePrompt(
      'mars-12345678',
      'Add a new helper to src/foo.ts that does X.',
      TRACE,
    )
    expect(out).toContain('mars-12345678')
    expect(out).toContain('Add a new helper to src/foo.ts that does X.')
    expect(out).toContain('## Read trail before abort')
    expect(out).toContain('src/foo.ts')
    expect(out).toContain('Grep')
  })

  it('forbids attempting the parent task or making the fix', () => {
    const out = buildDiagnoseChorePrompt('mars-aaaaaaaa', 'parent', TRACE)
    expect(out).toMatch(/MUST NOT/)
    expect(out).toMatch(/attempt the parent task/)
    expect(out).toMatch(/make the fix yourself/)
  })

  it('instructs the agent to record exactly one verdict via mars diagnose set', () => {
    const out = buildDiagnoseChorePrompt('mars-aaaaaaaa', 'parent', TRACE)
    expect(out).toMatch(/mars diagnose set mars-aaaaaaaa --from -/)
    expect(out).toMatch(/"kind": "root-cause-found"/)
    expect(out).toMatch(/"kind": "inconclusive"/)
  })

  it('forbids spawning another diagnose Chore', () => {
    const out = buildDiagnoseChorePrompt('mars-aaaaaaaa', 'parent', TRACE)
    expect(out).toMatch(/spawn another diagnose Chore|any other follow-up task/)
  })

  it('does not include the legacy three-way "note or small fix or file an idea" wording', () => {
    const out = buildDiagnoseChorePrompt('mars-aaaaaaaa', 'parent', TRACE)
    // Legacy wording from buildTooHardChildPrompt that the PRD explicitly
    // retires (see commit dff86c2 and PRD 06e677fb out-of-scope notes):
    // verify none of those three options survived into the diagnose prompt.
    expect(out).not.toMatch(/produce a concise note/i)
    expect(out).not.toMatch(/small surgical change/i)
    expect(out).not.toMatch(/mars idea add/i)
    expect(out).not.toMatch(/file a `mars idea/i)
  })

  it('tells the agent it is exempt from the read-span guard', () => {
    const out = buildDiagnoseChorePrompt('mars-aaaaaaaa', 'parent', TRACE)
    expect(out).toMatch(/exempt from the read-span guard/)
  })
})
