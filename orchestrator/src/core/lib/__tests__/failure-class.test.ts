import { describe, expect, it } from 'vitest'
import {
  classifyFailure,
  isNonCodeFailure,
  requiresWorktreeRebuild,
  type FailureCategory,
} from '../failure-class'

describe('classifyFailure — connectivity', () => {
  it('classifies /api-unreachable as connectivity', () => {
    expect(classifyFailure('code:coder-exit-nonzero/api-unreachable')).toBe<FailureCategory>(
      'connectivity',
    )
  })

  it('classifies /test-pg-connection-refused as connectivity', () => {
    expect(classifyFailure('verify:test/test-pg-connection-refused')).toBe<FailureCategory>(
      'connectivity',
    )
  })

  it('requires the suffix to be at end — mid-string does not match', () => {
    expect(
      classifyFailure('verify:test/api-unreachable/extra'),
    ).toBe<FailureCategory>('code')
  })
})

describe('classifyFailure — orchestration', () => {
  it('classifies /rebase-no-in-progress-state as orchestration', () => {
    expect(
      classifyFailure('merge:vcs-supervisor-aborted/rebase-no-in-progress-state'),
    ).toBe<FailureCategory>('orchestration')
  })

  it('classifies /worktree-missing as orchestration', () => {
    expect(classifyFailure('verify:worktree-hygiene/worktree-missing')).toBe<FailureCategory>(
      'orchestration',
    )
  })

  it('classifies /not-fast-forward as orchestration', () => {
    expect(classifyFailure('merge:preflight/not-fast-forward')).toBe<FailureCategory>(
      'orchestration',
    )
  })

  it('classifies /index-lock-contention as orchestration', () => {
    expect(classifyFailure('merge:crashed/index-lock-contention')).toBe<FailureCategory>(
      'orchestration',
    )
  })

  it('classifies setup:origin-worktree-missing/unclassified as orchestration', () => {
    // A recovery task whose origin worktree is gone cannot be fixed by code
    // edits; it is a pure orchestration condition.
    expect(
      classifyFailure('setup:origin-worktree-missing/unclassified'),
    ).toBe<FailureCategory>('orchestration')
  })

  it('classifies any setup:origin-worktree-missing/* variant as orchestration', () => {
    expect(
      classifyFailure('setup:origin-worktree-missing/some-other-class'),
    ).toBe<FailureCategory>('orchestration')
  })
})

describe('classifyFailure — infra', () => {
  it('classifies phantom-task watchdog: prefix as infra', () => {
    expect(
      classifyFailure('phantom-task watchdog: task mars-abc123 exceeded time limit'),
    ).toBe<FailureCategory>('infra')
  })

  it('classifies /install-timeout as infra', () => {
    expect(classifyFailure('setup:install-failed/install-timeout')).toBe<FailureCategory>(
      'infra',
    )
  })

  it('phantom-task watchdog prefix beats other rules', () => {
    // Even if it happened to end with an orchestration slug, the prefix wins
    expect(
      classifyFailure('phantom-task watchdog: not-fast-forward'),
    ).toBe<FailureCategory>('infra')
  })

  it('classifies code:killed/sigterm as infra', () => {
    // A SIGTERM-killed coder is process death, not a code defect.
    expect(classifyFailure('code:killed/sigterm')).toBe<FailureCategory>('infra')
  })

  it('classifies code:killed/sigkill as infra', () => {
    // A SIGKILL-killed coder is process death (typically OOM), not a code defect.
    expect(classifyFailure('code:killed/sigkill')).toBe<FailureCategory>('infra')
  })
})

describe('classifyFailure — code (default)', () => {
  it('classifies unclassified signatures as code', () => {
    expect(classifyFailure('verify:typecheck/unclassified')).toBe<FailureCategory>('code')
  })

  it('classifies known code-level typecheck errors as code', () => {
    expect(
      classifyFailure('verify:typecheck/typecheck-cannot-find-name'),
    ).toBe<FailureCategory>('code')
  })

  it('classifies test-assertion-error as code', () => {
    expect(classifyFailure('verify:test/test-assertion-error')).toBe<FailureCategory>('code')
  })

  it('classifies merge-conflict-unresolved as code', () => {
    expect(
      classifyFailure('merge:vcs-supervisor-aborted/merge-conflict-unresolved'),
    ).toBe<FailureCategory>('code')
  })

  it('classifies an empty signature as code', () => {
    expect(classifyFailure('')).toBe<FailureCategory>('code')
  })

  it('classifies a bare "unclassified" string as code', () => {
    expect(classifyFailure('unclassified')).toBe<FailureCategory>('code')
  })
})

describe('isNonCodeFailure', () => {
  it('returns true for connectivity signatures', () => {
    expect(isNonCodeFailure('code:coder-exit-nonzero/api-unreachable')).toBe(true)
    expect(isNonCodeFailure('verify:test/test-pg-connection-refused')).toBe(true)
  })

  it('returns true for orchestration signatures', () => {
    expect(isNonCodeFailure('verify:worktree-hygiene/worktree-missing')).toBe(true)
    expect(isNonCodeFailure('merge:preflight/not-fast-forward')).toBe(true)
  })

  it('returns true for infra signatures', () => {
    expect(isNonCodeFailure('setup:install-failed/install-timeout')).toBe(true)
    expect(
      isNonCodeFailure('phantom-task watchdog: exceeded wall-clock limit'),
    ).toBe(true)
  })

  it('returns false for code signatures', () => {
    expect(isNonCodeFailure('verify:typecheck/unclassified')).toBe(false)
    expect(isNonCodeFailure('verify:test/test-assertion-error')).toBe(false)
  })
})

describe('requiresWorktreeRebuild', () => {
  // The question is narrower than "is this orchestration?": it is "would a bare
  // re-queue help?". A re-queue resumes the durable run, so a completed setup
  // step short-circuits and no worktree is rebuilt — these signatures must be
  // paired with a restart-from-setup reset or the retry loops on itself.
  it('returns true for the resume-preflight signatures (directory and branch both gone)', () => {
    expect(requiresWorktreeRebuild('verify:worktree-missing/unclassified')).toBe(true)
    expect(requiresWorktreeRebuild('code:worktree-missing/unclassified')).toBe(true)
  })

  it('returns true for the /worktree-missing error class on any step', () => {
    expect(requiresWorktreeRebuild('verify:worktree-hygiene/worktree-missing')).toBe(true)
    expect(requiresWorktreeRebuild('verify:has-diff/worktree-missing')).toBe(true)
  })

  it('returns false for environmental failures that leave the worktree intact', () => {
    // These hold the coder's committed work — discarding it would destroy the
    // very thing the retry exists to resume.
    expect(requiresWorktreeRebuild('code:coder-exit-nonzero/api-unreachable')).toBe(false)
    expect(requiresWorktreeRebuild('setup:install-failed/install-timeout')).toBe(false)
    expect(requiresWorktreeRebuild('merge:preflight/index-lock-contention')).toBe(false)
    // Deliberately excluded: the worktree still exists, so discarding it is a
    // heavier remedy than the condition warrants.
    expect(requiresWorktreeRebuild('verify:worktree-hygiene/branch-drift')).toBe(false)
    expect(requiresWorktreeRebuild('verify:worktree-hygiene/stale-rebase-state')).toBe(false)
  })

  it('returns false for ordinary code failures', () => {
    expect(requiresWorktreeRebuild('verify:typecheck/unclassified')).toBe(false)
    expect(requiresWorktreeRebuild('verify:test/test-assertion-error')).toBe(false)
  })
})
