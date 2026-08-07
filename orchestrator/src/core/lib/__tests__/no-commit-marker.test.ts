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

  it('matches "read-only, report only, no edits" batch task phrasing', () => {
    expect(
      detectNoCommitMarker(
        'Read one source file and summarize it in 2 lines. Read-only, report only, no edits. (batch 6)',
      ),
    ).not.toBeNull()
    expect(
      detectNoCommitMarker('Read-only, report only, no edits.'),
    ).not.toBeNull()
    expect(
      detectNoCommitMarker('read only, report only, no-edits'),
    ).not.toBeNull()
  })

  it('returns the matched phrase so the caller can surface it', () => {
    const m = detectNoCommitMarker('… Nothing to commit. …')
    expect(m).toMatch(/Nothing to commit/i)
  })

  // -------------------------------------------------------------------------
  // Quoted-material stripping — the phrase in a fenced block or backtick span
  // is quoting the world, not declaring intent.
  // -------------------------------------------------------------------------

  it('does not trigger on "nothing to commit" inside a fenced code block', () => {
    const prompt = [
      'Fix the bug where git emits an unexpected message.',
      '',
      'The relevant git output:',
      '```',
      '$ git status',
      'nothing to commit, working tree clean',
      '```',
      '',
      'The fix involves updating src/core/queue.ts.',
    ].join('\n')
    expect(detectNoCommitMarker(prompt)).toBeNull()
  })

  it('does not trigger on "Nothing to commit" inside a tilde-fenced block', () => {
    const prompt = [
      'Fix the orchestrator stall described below.',
      '~~~',
      'Nothing to commit.',
      '~~~',
      'Implement the fix in queue.ts.',
    ].join('\n')
    expect(detectNoCommitMarker(prompt)).toBeNull()
  })

  it('does not trigger on "nothing to commit" inside an inline backtick span', () => {
    const prompt =
      'Fix the case where the CLI prints `nothing to commit` on clean trees. Edit queue.ts.'
    expect(detectNoCommitMarker(prompt)).toBeNull()
  })

  it('still triggers on "nothing to commit" in plain prose (heading, body)', () => {
    // Headings are NOT quoted spans — the structural-evidence bypass in the CLI
    // caller handles that case; detectNoCommitMarker itself still matches.
    const prompt = '# Fix the nothing to commit stall\n\nSome body text.'
    expect(detectNoCommitMarker(prompt)).not.toBeNull()
  })

  it('still triggers when phrase appears both in prose and a fenced block (prose match wins)', () => {
    const prompt = [
      'Nothing to commit — fix the stall described below.',
      '```',
      '$ git status',
      'nothing to commit',
      '```',
    ].join('\n')
    expect(detectNoCommitMarker(prompt)).not.toBeNull()
  })
})
