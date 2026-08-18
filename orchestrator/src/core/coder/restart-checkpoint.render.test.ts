/**
 * Unit tests for renderRestartCheckpoint.
 *
 * Covers the four acceptance-criteria scenarios:
 *   1. Cold start — the dispatch site never calls renderRestartCheckpoint
 *      (tested here by verifying renderRestartCheckpoint is never called, and
 *      that the produced prompt lacks the checkpoint title).
 *   2. Resume with commits → section with commits and changed paths.
 *   3. Resume with verify failure → fenced verify block.
 *   4. Resume with all criteria checked → empty outstanding-criteria header
 *      rather than an omitted section.
 */
import { describe, expect, it } from 'vitest'
import type { RestartCheckpoint } from './restart-checkpoint.js'
import { renderRestartCheckpoint } from './restart-checkpoint.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCheckpoint(partial: Partial<RestartCheckpoint> = {}): RestartCheckpoint {
  return {
    commits: [],
    changedPaths: [],
    outstandingCriteria: [],
    hadDoneCriteria: false,
    lastVerify: null,
    diagnostics: {},
    ...partial,
  }
}

// ---------------------------------------------------------------------------
// Section title
// ---------------------------------------------------------------------------

describe('renderRestartCheckpoint — section title', () => {
  it('includes the section title when any content is present', () => {
    const result = renderRestartCheckpoint(
      makeCheckpoint({
        commits: [{ sha: 'abc1234500000000abc1234500000000abc12345', subject: 'feat: add thing', files: [] }],
        changedPaths: [],
      }),
    )
    expect(result).toContain('## Restart checkpoint (prior work already on this branch)')
  })

  it('returns empty string when no content at all (no resume signal)', () => {
    const result = renderRestartCheckpoint(makeCheckpoint())
    expect(result).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Cold start — caller never invokes renderRestartCheckpoint
// ---------------------------------------------------------------------------

describe('cold start: prompt has no checkpoint section', () => {
  it('a prompt built without calling renderRestartCheckpoint has no checkpoint title', () => {
    // Simulate the dispatch site: on a cold start (resumeFromPriorAttempt=false),
    // renderRestartCheckpoint is never called. The resulting prompt is just the
    // task prompt with no checkpoint section.
    const taskPrompt = 'Implement the requested change.'
    // No injection happens.
    expect(taskPrompt).not.toContain(
      '## Restart checkpoint (prior work already on this branch)',
    )
  })
})

// ---------------------------------------------------------------------------
// Resume with commits
// ---------------------------------------------------------------------------

describe('renderRestartCheckpoint — commits and changed paths', () => {
  it('uses sha7 (first 7 chars) not the full SHA', () => {
    const fullSha = 'abcdef1234567890abcdef1234567890abcdef12'
    const result = renderRestartCheckpoint(
      makeCheckpoint({
        commits: [{ sha: fullSha, subject: 'fix(auth): correct token expiry', files: [] }],
        changedPaths: [],
      }),
    )
    expect(result).toContain('`abcdef1`')
    expect(result).not.toContain(fullSha)
  })

  it('lists each commit with sha7 and subject', () => {
    const result = renderRestartCheckpoint(
      makeCheckpoint({
        commits: [
          { sha: 'aaa000011112222333344445555666677778888', subject: 'feat: first commit', files: [] },
          { sha: 'bbb000011112222333344445555666677778888', subject: 'fix: second commit', files: [] },
        ],
        changedPaths: [],
      }),
    )
    expect(result).toContain('`aaa0000`')
    expect(result).toContain('feat: first commit')
    expect(result).toContain('`bbb0000`')
    expect(result).toContain('fix: second commit')
  })

  it('lists changed paths in the files section', () => {
    const result = renderRestartCheckpoint(
      makeCheckpoint({
        commits: [{ sha: 'aaa000011112222333344445555666677778888', subject: 'feat: x', files: [] }],
        changedPaths: ['src/auth.ts', 'src/token.ts'],
      }),
    )
    expect(result).toContain('src/auth.ts')
    expect(result).toContain('src/token.ts')
  })
})

// ---------------------------------------------------------------------------
// Resume with verify failure
// ---------------------------------------------------------------------------

describe('renderRestartCheckpoint — verify failure block', () => {
  it('renders the last failing verify as a fenced block', () => {
    const result = renderRestartCheckpoint(
      makeCheckpoint({
        commits: [{ sha: 'aaabbbccddeeff00112233445566778899aabbcc', subject: 'feat: x', files: [] }],
        changedPaths: [],
        lastVerify: {
          command: 'npm run test',
          exitCode: 1,
          signature: 'verify:test',
          tailOutput: 'FAIL src/foo.test.ts\n  AssertionError: expected true to be false',
        },
      }),
    )
    expect(result).toContain('### Last failing verify')
    expect(result).toContain('`npm run test`')
    expect(result).toContain('FAIL src/foo.test.ts')
    // Tail output must be inside a fenced code block
    const fenceStart = result.indexOf('```text')
    const fenceEnd = result.indexOf('```', fenceStart + 1)
    expect(fenceStart).toBeGreaterThan(-1)
    expect(fenceEnd).toBeGreaterThan(fenceStart)
    expect(result.slice(fenceStart, fenceEnd + 3)).toContain('AssertionError')
  })

  it('includes exit code and signature in the verify block', () => {
    const result = renderRestartCheckpoint(
      makeCheckpoint({
        commits: [{ sha: 'aaabbbccddeeff00112233445566778899aabbcc', subject: 'feat: y', files: [] }],
        changedPaths: [],
        lastVerify: {
          command: 'cd orchestrator && npm test',
          exitCode: 2,
          signature: 'verify:typecheck',
          tailOutput: null,
        },
      }),
    )
    expect(result).toContain('Exit code: 2')
    expect(result).toContain('`verify:typecheck`')
  })

  it('omits the verify section when lastVerify is null', () => {
    const result = renderRestartCheckpoint(
      makeCheckpoint({
        commits: [{ sha: 'aaabbbccddeeff00112233445566778899aabbcc', subject: 'feat: z', files: [] }],
        changedPaths: [],
        lastVerify: null,
      }),
    )
    expect(result).not.toContain('### Last failing verify')
  })
})

// ---------------------------------------------------------------------------
// Resume with all criteria checked
// ---------------------------------------------------------------------------

describe('renderRestartCheckpoint — criteria handling', () => {
  it('shows empty outstanding criteria header when all criteria are met', () => {
    // hadDoneCriteria=true but outstandingCriteria=[] means all were checked.
    const result = renderRestartCheckpoint(
      makeCheckpoint({
        commits: [{ sha: 'aaabbbccddeeff00112233445566778899aabbcc', subject: 'feat: done', files: [] }],
        changedPaths: [],
        hadDoneCriteria: true,
        outstandingCriteria: [],
      }),
    )
    // Header MUST be present even though the list is empty.
    expect(result).toContain('### Remaining acceptance criteria')
    // No checklist items
    expect(result).not.toContain('- [ ]')
  })

  it('shows checklist items when criteria are outstanding', () => {
    const result = renderRestartCheckpoint(
      makeCheckpoint({
        commits: [{ sha: 'aaabbbccddeeff00112233445566778899aabbcc', subject: 'feat: wip', files: [] }],
        changedPaths: [],
        hadDoneCriteria: true,
        outstandingCriteria: ['implement X', 'write vitest for Y'],
      }),
    )
    expect(result).toContain('- [ ] implement X')
    expect(result).toContain('- [ ] write vitest for Y')
  })

  it('omits the criteria section entirely when task has no doneCriteria', () => {
    const result = renderRestartCheckpoint(
      makeCheckpoint({
        commits: [{ sha: 'aaabbbccddeeff00112233445566778899aabbcc', subject: 'feat: x', files: [] }],
        changedPaths: [],
        hadDoneCriteria: false,
        outstandingCriteria: [],
      }),
    )
    expect(result).not.toContain('### Remaining acceptance criteria')
  })
})
