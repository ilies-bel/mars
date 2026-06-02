import { describe, expect, it } from 'vitest'
import { detectNoCommitMarker } from '../no-commit-marker'

describe('detectNoCommitMarker', () => {
  it('rejects the exact phrasing from the mars-ffea2b19 recovery-loop incident', () => {
    const prompt = [
      'Rebuild and reinstall the `mars` CLI binary.',
      '',
      'There is no source-code edit in this task — it is a build/install-only',
      'operation. Nothing to commit.',
    ].join('\n')
    expect(detectNoCommitMarker(prompt)).not.toBeNull()
  })

  it('matches "Nothing to commit" case-insensitively', () => {
    expect(detectNoCommitMarker('foo. nothing to commit. bar.')).not.toBeNull()
    expect(detectNoCommitMarker('NOTHING TO COMMIT here')).not.toBeNull()
  })

  it('matches "build-only operation" variants', () => {
    expect(detectNoCommitMarker('this is a build-only operation')).not.toBeNull()
    expect(detectNoCommitMarker('build/install-only operation')).not.toBeNull()
    expect(detectNoCommitMarker('install only operation')).not.toBeNull()
  })

  it('matches "no commit expected/required/produced" phrasings', () => {
    expect(detectNoCommitMarker('no commit expected')).not.toBeNull()
    expect(detectNoCommitMarker('no commit is required')).not.toBeNull()
    expect(detectNoCommitMarker('No commit produced.')).not.toBeNull()
  })

  it('returns null for ordinary prompts that mention commits', () => {
    expect(detectNoCommitMarker('Add a commit hook that lints staged files')).toBeNull()
    expect(detectNoCommitMarker('Fix the bug in src/foo.ts and commit')).toBeNull()
    expect(detectNoCommitMarker('Refactor verify step; produce a commit per file')).toBeNull()
  })

  it('returns the matched phrase so the caller can surface it', () => {
    const m = detectNoCommitMarker('… Nothing to commit. …')
    expect(m).toMatch(/Nothing to commit/i)
  })
})
