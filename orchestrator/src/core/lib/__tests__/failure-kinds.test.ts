import { describe, expect, it } from 'vitest'
import {
  FAILURE_KINDS,
  GENERIC_FAILURE_LABEL,
  WORKTREE_MISSING_ACTIONS,
  failedTaskTitle,
  isGenericFailureLabel,
  isEnvironmentalSignature,
  isSignatureStormExempt,
  lookupFailureKind,
  unknownFailureKind,
} from '../failure-kinds'
import { DAEMON_KILLED_SIGNATURE } from '../retry-budget'

describe('FAILURE_KINDS registry', () => {
  it('contains an entry for every expected setup:install signature', () => {
    const sigs = FAILURE_KINDS.map((k) => k.signature)
    expect(sigs).toContain('setup:install/install-frozen-lockfile')
    expect(sigs).toContain('setup:install/install-timeout')
    expect(sigs).toContain('setup:install/install-missing-peer')
  })

  it('contains an entry for code:no-edits-made/unclassified', () => {
    expect(FAILURE_KINDS.map((k) => k.signature)).toContain(
      'code:no-edits-made/unclassified',
    )
  })

  it('contains an entry for verify:has-diff/no-commits-ahead', () => {
    expect(FAILURE_KINDS.map((k) => k.signature)).toContain(
      'verify:has-diff/no-commits-ahead',
    )
  })

  it('labels SIGTERM-killed verification as an environmental kill', () => {
    const entry = lookupFailureKind('verify:killed/sigterm')
    expect(entry?.warmTitle).toBe('Verification was killed before it could finish')
    expect(isEnvironmentalSignature('verify:killed/sigterm')).toBe(true)
  })

  it('labels SIGTERM-killed coder (exit 143) as an environmental kill', () => {
    const entry = lookupFailureKind('code:killed/sigterm')
    expect(entry).not.toBeNull()
    expect(entry!.warmTitle).toBeTruthy()
    expect(isEnvironmentalSignature('code:killed/sigterm')).toBe(true)
  })

  it('labels SIGKILL-killed coder (exit 137) as an environmental kill', () => {
    const entry = lookupFailureKind('code:killed/sigkill')
    expect(entry).not.toBeNull()
    expect(entry!.warmTitle).toBeTruthy()
    expect(isEnvironmentalSignature('code:killed/sigkill')).toBe(true)
  })

  it('contains an entry for verify:worktree-hygiene/worktree-missing', () => {
    expect(FAILURE_KINDS.map((k) => k.signature)).toContain(
      'verify:worktree-hygiene/worktree-missing',
    )
  })

  it('contains one entry for the code:timeout SIGKILL/137 class', () => {
    const entry = FAILURE_KINDS.find((k) =>
      k.signature.startsWith('code:timeout/'),
    )
    expect(entry).toBeDefined()
    expect(entry!.signature).toBe('code:timeout/install-timeout')
  })

  it('contains an entry for code:over-budget', () => {
    expect(
      FAILURE_KINDS.some((k) => k.signature.startsWith('code:over-budget/')),
    ).toBe(true)
  })

  it('contains one entry per registered typecheck-* error class plus unclassified', () => {
    const typecheckSigs = FAILURE_KINDS.filter((k) =>
      k.signature.startsWith('verify:typecheck/'),
    ).map((k) => k.signature)

    expect(typecheckSigs).toContain('verify:typecheck/typecheck-property-not-exist')
    expect(typecheckSigs).toContain('verify:typecheck/typecheck-cannot-find-name')
    expect(typecheckSigs).toContain('verify:typecheck/typecheck-cannot-find-module')
    expect(typecheckSigs).toContain('verify:typecheck/typecheck-type-mismatch')
    expect(typecheckSigs).toContain('verify:typecheck/typecheck-arg-type-mismatch')
    expect(typecheckSigs).toContain('verify:typecheck/typecheck-excess-property')
    expect(typecheckSigs).toContain('verify:typecheck/typecheck-missing-export')
    expect(typecheckSigs).toContain('verify:typecheck/unclassified')
  })

  it('contains entries for merge:vcs-supervisor-aborted', () => {
    expect(
      FAILURE_KINDS.some((k) =>
        k.signature.startsWith('merge:vcs-supervisor-aborted/'),
      ),
    ).toBe(true)
  })

  it('contains an entry for the daemon-killed signature', () => {
    expect(FAILURE_KINDS.map((k) => k.signature)).toContain(
      DAEMON_KILLED_SIGNATURE,
    )
  })

  it('contains an operational entry for the re-queue time ceiling', () => {
    const entry = lookupFailureKind('requeue:time-bound-exceeded/unclassified')

    expect(entry).not.toBeNull()
    expect(entry!.warmTitle).toBe(
      'The task was repeatedly re-dispatched but did not finish',
    )
    expect(entry!.verboseReason).toContain('paused or restarted')
    expect(entry!.recipe).toBeNull()
    expect(entry!.actions.map((action) => action.op)).toEqual([
      'diagnose-failure',
      'restart',
      'purge',
    ])
  })

  it('exempts main-committer dirty-main failures from the global storm breaker', () => {
    expect(isSignatureStormExempt('orchestration:main-committer-still-dirty')).toBe(true)
    expect(isSignatureStormExempt('orchestration:main-committer-still-dirty/unclassified')).toBe(true)
    expect(isSignatureStormExempt('merge:preflight/uncommitted-changes')).toBe(false)
  })
})

describe('warmTitle values match the PRD-agreed copy', () => {
  it('setup:install/* → "The coding environment could not be set up"', () => {
    const entries = FAILURE_KINDS.filter((k) =>
      k.signature.startsWith('setup:install/'),
    )
    expect(entries.length).toBeGreaterThan(0)
    for (const e of entries) {
      expect(e.warmTitle).toBe('The coding environment could not be set up')
    }
  })

  it('code:no-edits-made/* → "The coder stopped before starting to write"', () => {
    const entry = lookupFailureKind('code:no-edits-made/unclassified')
    expect(entry).not.toBeNull()
    expect(entry!.warmTitle).toBe('The coder stopped before starting to write')
  })

  it('verify:has-diff/no-commits-ahead → "The coder stopped mid-task"', () => {
    const entry = lookupFailureKind('verify:has-diff/no-commits-ahead')
    expect(entry).not.toBeNull()
    expect(entry!.warmTitle).toBe('The coder stopped mid-task')
  })

  it('code:timeout/* → "The coder took too long"', () => {
    const entry = lookupFailureKind('code:timeout/install-timeout')
    expect(entry).not.toBeNull()
    expect(entry!.warmTitle).toBe('The coder took too long')
  })

  it('code:over-budget/* → "The task was too large for the coder to finish in one run"', () => {
    const entries = FAILURE_KINDS.filter((k) =>
      k.signature.startsWith('code:over-budget/'),
    )
    expect(entries.length).toBeGreaterThan(0)
    for (const e of entries) {
      expect(e.warmTitle).toBe(
        'The task was too large for the coder to finish in one run',
      )
    }
  })

  it('verify:typecheck/* → "The changes did not pass type-checking"', () => {
    const entries = FAILURE_KINDS.filter((k) =>
      k.signature.startsWith('verify:typecheck/'),
    )
    expect(entries.length).toBeGreaterThan(0)
    for (const e of entries) {
      expect(e.warmTitle).toBe('The changes did not pass type-checking')
    }
  })

  it('merge:vcs-supervisor-aborted/* conflict entries → "The changes clashed with main and were too hard to merge"', () => {
    // The dirty-worktree and rebase-no-in-progress-state entries have distinct
    // warmTitles (worktree/rebase-state conditions, not conflicts), so this
    // assertion is scoped to the conflict-resolution sub-classes only.
    const entries = FAILURE_KINDS.filter(
      (k) =>
        k.signature.startsWith('merge:vcs-supervisor-aborted/') &&
        k.signature !== 'merge:vcs-supervisor-aborted/rebase-dirty-worktree' &&
        k.signature !== 'merge:vcs-supervisor-aborted/rebase-no-in-progress-state',
    )
    expect(entries.length).toBeGreaterThan(0)
    for (const e of entries) {
      expect(e.warmTitle).toBe(
        'The changes clashed with main and were too hard to merge',
      )
    }
  })

  it('daemon-killed → "Mars was shut down while this task was still running"', () => {
    const entry = lookupFailureKind(DAEMON_KILLED_SIGNATURE)
    expect(entry).not.toBeNull()
    expect(entry!.warmTitle).toBe(
      'Mars was shut down while this task was still running',
    )
  })
})

describe('lookupFailureKind', () => {
  it('returns the matching record for a registered signature', () => {
    const entry = lookupFailureKind('setup:install/install-frozen-lockfile')
    expect(entry).not.toBeNull()
    expect(entry!.signature).toBe('setup:install/install-frozen-lockfile')
  })

  it('returns null for verify:test/unclassified (intentionally unregistered)', () => {
    // verify:test failures are left unclassified by design — each test failure
    // has a unique root cause that a single mechanical recipe cannot cover.
    // See failure-signature.ts for the investigated rationale.
    expect(lookupFailureKind('verify:test/unclassified')).toBeNull()
  })

  it('returns null for any other unregistered signature', () => {
    expect(lookupFailureKind('made-up:step/made-up-class')).toBeNull()
  })

  it('returns null for an empty string', () => {
    expect(lookupFailureKind('')).toBeNull()
  })

  it('is case-sensitive (upper-case variant misses)', () => {
    expect(lookupFailureKind('SETUP:INSTALL/INSTALL-FROZEN-LOCKFILE')).toBeNull()
  })
})

describe('unknownFailureKind', () => {
  it('opens verboseReason with the first non-blank line of the error', () => {
    const kind = unknownFailureKind('setup:install', 'EACCES: permission denied')
    expect(kind.verboseReason).toMatch(/^EACCES: permission denied/)
  })

  it('strips leading blank lines from capturedError before using it', () => {
    const kind = unknownFailureKind(
      'code:timeout',
      '\n\n  \nactual error here',
    )
    expect(kind.verboseReason).toMatch(/^actual error here/)
  })

  it('uses a fallback verboseReason when capturedError is entirely blank', () => {
    const kind = unknownFailureKind('setup:install', '   \n\n  ')
    expect(kind.verboseReason.length).toBeGreaterThan(0)
  })

  it('includes default actions', () => {
    const kind = unknownFailureKind('merge:preflight', 'some error')
    expect(kind.actions.some((a) => a.op === 'restart')).toBe(true)
    expect(kind.actions.some((a) => a.op === 'purge')).toBe(true)
  })
})

describe('unknownFailureKind — plain-English fallback (no raw step ids, no jargon)', () => {
  it('warmTitle for verify:has-diff does not contain the raw step id', () => {
    const kind = unknownFailureKind('verify:has-diff', '')
    expect(kind.warmTitle).not.toContain('verify:has-diff')
  })

  it('warmTitle for "unknown" step admits uncertainty without technical jargon', () => {
    const kind = unknownFailureKind('unknown', '')
    expect(kind.warmTitle).toBe('Mars could not determine why this task failed')
  })

  it('verboseReason fallback does not contain raw step ids', () => {
    const kind = unknownFailureKind('verify:has-diff', '')
    expect(kind.verboseReason).not.toContain('verify:has-diff')
  })

  it('verboseReason fallback does not contain "unrecognised"', () => {
    const kind = unknownFailureKind('verify:has-diff', '')
    expect(kind.verboseReason).not.toContain('unrecognised')
  })

  it('verboseReason fallback for null-signature path does not say "unrecognised"', () => {
    const kind = unknownFailureKind('unknown', '')
    expect(kind.verboseReason).not.toContain('unrecognised')
    expect(kind.verboseReason).not.toMatch(/\bunknown\b/i)
  })

  it('verify:* step maps to a verification-themed warm title', () => {
    const kind = unknownFailureKind('verify:lint', '')
    expect(kind.warmTitle).toMatch(/verification|check/i)
    expect(kind.warmTitle).not.toContain('verify:lint')
  })

  it('setup:* step maps to an environment-setup warm title', () => {
    const kind = unknownFailureKind('setup:install', '')
    expect(kind.warmTitle).toMatch(/environment|set up/i)
    expect(kind.warmTitle).not.toContain('setup:install')
  })

  it('code:* step maps to a coder warm title', () => {
    const kind = unknownFailureKind('code:timeout', '')
    expect(kind.warmTitle).toMatch(/coder/i)
    expect(kind.warmTitle).not.toContain('code:timeout')
  })

  it('merge:* step maps to a merge warm title', () => {
    const kind = unknownFailureKind('merge:preflight', '')
    expect(kind.warmTitle).toMatch(/merge|changes/i)
    expect(kind.warmTitle).not.toContain('merge:preflight')
  })

  it('unrecognised step prefix yields a generic pipeline title', () => {
    const kind = unknownFailureKind('xyzzy:warp', '')
    expect(kind.warmTitle.length).toBeGreaterThan(0)
    expect(kind.warmTitle).not.toContain('xyzzy:warp')
  })
})

describe('new catalog entries for previously-unmatched signatures', () => {
  it('setup:install/unclassified is registered with a plain-English warm title', () => {
    const entry = lookupFailureKind('setup:install/unclassified')
    expect(entry).not.toBeNull()
    expect(entry!.warmTitle).toBe('The coding environment could not be set up')
  })

  it('setup:install/unclassified verboseReason does not say "unrecognised"', () => {
    const entry = lookupFailureKind('setup:install/unclassified')
    expect(entry).not.toBeNull()
    expect(entry!.verboseReason).not.toContain('unrecognised')
  })

  it('verify:has-diff/unclassified is registered with a plain-English warm title', () => {
    const entry = lookupFailureKind('verify:has-diff/unclassified')
    expect(entry).not.toBeNull()
    expect(entry!.warmTitle).not.toContain('verify:has-diff')
  })

  it('verify:has-diff/unclassified verboseReason does not say "unrecognised"', () => {
    const entry = lookupFailureKind('verify:has-diff/unclassified')
    expect(entry).not.toBeNull()
    expect(entry!.verboseReason).not.toContain('unrecognised')
  })

  it('verify:worktree-hygiene/worktree-missing has the infrastructure-condition warm title', () => {
    const entry = lookupFailureKind('verify:worktree-hygiene/worktree-missing')
    expect(entry).not.toBeNull()
    expect(entry!.warmTitle).toBe('Task worktree disappeared before verify could run')
  })

  it('verify:worktree-hygiene/worktree-missing verboseReason mentions infrastructure and restart, not coder error', () => {
    const entry = lookupFailureKind('verify:worktree-hygiene/worktree-missing')
    expect(entry).not.toBeNull()
    expect(entry!.verboseReason.toLowerCase()).toContain('infrastructure')
    expect(entry!.verboseReason.toLowerCase()).toContain('restart')
    expect(entry!.verboseReason.toLowerCase()).not.toContain('coder may have')
  })

  it('verify:worktree-hygiene/worktree-missing does NOT render the misleading "did not produce any changes" copy', () => {
    const entry = lookupFailureKind('verify:worktree-hygiene/worktree-missing')
    expect(entry).not.toBeNull()
    expect(entry!.warmTitle).not.toBe('The coder did not produce any changes')
    expect(entry!.verboseReason).not.toContain('The coder may have encountered an error')
  })

  it('verify:worktree-hygiene/worktree-missing action list has no diagnose-failure and contains exactly restart and purge', () => {
    // When the worktree is gone there is nothing left to investigate — the
    // only meaningful repairs are re-provisioning (restart) or dropping
    // (purge). The Investigate action must NOT appear in this menu.
    const entry = lookupFailureKind('verify:worktree-hygiene/worktree-missing')
    expect(entry).not.toBeNull()
    expect(entry!.actions.every((a) => a.op !== 'diagnose-failure')).toBe(true)
    const ops = entry!.actions.map((a) => a.op)
    expect(ops).toContain('restart')
    expect(ops).toContain('purge')
    expect(ops).toHaveLength(2)
  })

  it('WORKTREE_MISSING_ACTIONS export contains exactly restart and purge', () => {
    const ops = WORKTREE_MISSING_ACTIONS.map((a) => a.op)
    expect(ops).toContain('restart')
    expect(ops).toContain('purge')
    expect(ops).toHaveLength(2)
    expect(WORKTREE_MISSING_ACTIONS.every((a) => a.op !== 'diagnose-failure')).toBe(true)
  })

  it('code:coder-exit-nonzero/api-unreachable is registered with an environmental human explanation', () => {
    // Verifies the "recipe lookup" produces a human sentence rather than falling
    // through to an unknownFailureKind / generic "no recipe" fallback.
    const entry = lookupFailureKind('code:coder-exit-nonzero/api-unreachable')
    expect(entry).not.toBeNull()
    // warmTitle must mention the API — not a generic "stopped" or "crash" label
    expect(entry!.warmTitle.toLowerCase()).toMatch(/api/)
    // verboseReason must explain the cause is network/DNS, not a code defect
    expect(entry!.verboseReason.toLowerCase()).toMatch(/api|connect/)
    expect(entry!.verboseReason.toLowerCase()).toContain('not at fault')
    // staticEncodable must be environmental (not a gate-encodable command check)
    expect(entry!.staticEncodable).toEqual({ encodable: false, reason: 'environmental' })
    // Actions must not include "Investigate" — there is nothing to diagnose
    expect(entry!.actions.every((a) => a.op !== 'diagnose-failure')).toBe(true)
    // Must have restart and purge actions
    expect(entry!.actions.some((a) => a.op === 'restart')).toBe(true)
    expect(entry!.actions.some((a) => a.op === 'purge')).toBe(true)
  })

  it('merge:vcs-supervisor-aborted/rebase-dirty-worktree is registered with restart-first actions and no diagnose-failure', () => {
    // This failure is a worktree hygiene condition, not a code defect: the
    // task worktree had uncommitted changes when the rebase attempted to start.
    // The correct resolution is to restart the task (which re-provisions the
    // worktree from scratch), not to spawn an Investigator that would chase a
    // phantom code bug.
    const entry = lookupFailureKind('merge:vcs-supervisor-aborted/rebase-dirty-worktree')
    expect(entry).not.toBeNull()
    expect(entry!.signature).toBe('merge:vcs-supervisor-aborted/rebase-dirty-worktree')
    // warmTitle must name the dirty-worktree cause, not a generic merge failure
    expect(entry!.warmTitle).toBe('The task worktree had uncommitted changes when the rebase started')
    // verboseReason must explain the worktree hygiene cause
    expect(entry!.verboseReason.toLowerCase()).toMatch(/worktree|uncommitted|dirty/)
    // recipe must be null — this is a state failure, not a code defect with a recipe
    expect(entry!.recipe).toBeNull()
    // staticEncodable must be orchestration (infrastructure condition)
    expect(entry!.staticEncodable).toEqual({ encodable: false, reason: 'orchestration' })
    // Actions must NOT include diagnose-failure — there is nothing to diagnose
    expect(entry!.actions.every((a) => a.op !== 'diagnose-failure')).toBe(true)
    // Must have restart (to re-provision the worktree) and purge
    expect(entry!.actions.some((a) => a.op === 'restart')).toBe(true)
    expect(entry!.actions.some((a) => a.op === 'purge')).toBe(true)
  })

  it('merge:vcs-supervisor-aborted/rebase-no-in-progress-state is registered with restart/purge actions and no diagnose-failure', () => {
    // This failure is a git worktree/rebase-state condition: git rebase exited
    // non-zero without leaving a rebase state directory, meaning the rebase could
    // not start (e.g. uncommitted changes, invalid upstream ref). The correct
    // resolution is to restart the task, not to spawn an Investigator that would
    // chase a phantom code bug.
    const entry = lookupFailureKind('merge:vcs-supervisor-aborted/rebase-no-in-progress-state')
    expect(entry).not.toBeNull()
    expect(entry!.signature).toBe('merge:vcs-supervisor-aborted/rebase-no-in-progress-state')
    // warmTitle must name the rebase-state cause, not a generic merge-conflict failure
    expect(entry!.warmTitle).toBe('The rebase could not start (no in-progress state)')
    // verboseReason must explain the rebase-state / worktree condition
    expect(entry!.verboseReason.toLowerCase()).toMatch(/rebase|worktree/)
    // recipe must be null — this is a state failure, not a code defect with a recipe
    expect(entry!.recipe).toBeNull()
    // staticEncodable must be orchestration (not a gate-encodable check)
    expect(entry!.staticEncodable).toEqual({ encodable: false, reason: 'orchestration' })
    // Actions must NOT include diagnose-failure — there is nothing to diagnose
    expect(entry!.actions.every((a) => a.op !== 'diagnose-failure')).toBe(true)
    // Must have restart (to re-provision the worktree) and purge
    expect(entry!.actions.some((a) => a.op === 'restart')).toBe(true)
    expect(entry!.actions.some((a) => a.op === 'purge')).toBe(true)
  })

  it('registers verify:test/test-assertion-error and links it to its recovery recipe', () => {
    const entry = lookupFailureKind('verify:test/test-assertion-error')
    expect(entry).not.toBeNull()
    expect(entry!.warmTitle).toBe('The changes did not pass the tests')
    // A recipe of the same signature exists in fix-recipes.ts, so the record
    // must reference it — an operator seeing this row must not be told there
    // is no recipe when self-heal knows exactly how to fix it.
    expect(entry!.recipe).toBe('verify:test/test-assertion-error')
  })

  it('registers code/uncommitted-changes and links it to its recovery recipe', () => {
    const entry = lookupFailureKind('code/uncommitted-changes')
    expect(entry).not.toBeNull()
    expect(entry!.warmTitle).toMatch(/uncommitted/i)
    expect(entry!.verboseReason).toMatch(/automatic commit was refused|pre-commit/i)
    expect(entry!.recipe).toBe('code/uncommitted-changes')
  })
})

describe('failedTaskTitle', () => {
  it('leads with the signature and tags the task for a registered signature', () => {
    expect(
      failedTaskTitle({
        signature: 'verify:typecheck/typecheck-cannot-find-name',
        taskId: 'mars-c6cab686',
      }),
    ).toBe(
      'verify:typecheck/typecheck-cannot-find-name — The changes did not pass type-checking [task mars-c6c]',
    )
  })

  it('uses a plain-English title when no failure-kind record exists', () => {
    const title = failedTaskTitle({
      signature: 'verify:test/unclassified',
      taskId: 'task-1234567890',
    })
    expect(title).toBe('A verification check did not pass [task task-123]')
    expect(title).not.toContain('verify:test/unclassified')
    expect(title).toContain('[task task-123]')
  })

  it('falls back to the captured error head when there is no signature', () => {
    expect(
      failedTaskTitle({
        signature: null,
        taskId: 'abcdefgh12345',
        capturedError: '\n\n  ENOSPC: no space left on device\nsecond line\n',
      }),
    ).toBe(
      'Mars could not determine why this task failed: ENOSPC: no space left on device [task abcdefgh]',
    )
  })

  it('strips composed recovery_failed prefixes off the error head', () => {
    // failure_reason / error can carry `recovery_failed:<sig>: ` prefixes,
    // sometimes nested. The title must show the real error underneath.
    expect(
      failedTaskTitle({
        signature: null,
        taskId: 'task-1',
        capturedError:
          'recovery_failed:verify:test/test-assertion-error: recovery_failed:verify:test/test-assertion-error: expected 2 to be 3',
      }),
    ).toBe('Mars could not determine why this task failed: expected 2 to be 3 [task task-1]')
  })

  it('clips a very long error head so the row stays scannable', () => {
    const title = failedTaskTitle({
      signature: null,
      taskId: 'task-1',
      capturedError: 'x'.repeat(400),
    })
    expect(title.length).toBeLessThan(160)
    expect(title).toContain('…')
  })

  it('admits uncertainty when nothing at all is known', () => {
    expect(failedTaskTitle({ signature: null })).toBe(
      'Mars could not determine why this task failed',
    )
    expect(failedTaskTitle({ signature: null, taskId: 'task-1' })).toBe(
      'Mars could not determine why this task failed [task task-1]',
    )
  })

  it('names the signature in the title for continue:base-refresh-conflict/merge-conflict-unresolved', () => {
    // This is the signature coreContinueTask writes when git merge conflicts and
    // the VCS supervisor cannot resolve it. The title must carry the full
    // signature so the action-queue list is immediately scannable.
    const title = failedTaskTitle({
      signature: 'continue:base-refresh-conflict/merge-conflict-unresolved',
      taskId: 'mars-5c83d931',
    })
    expect(title).toContain('continue:base-refresh-conflict/merge-conflict-unresolved')
    expect(title).not.toContain('Mars could not determine why this task failed')
    expect(title).toContain('[task mars-5c8]')
  })

  it('gives two failures with different signatures two different titles', () => {
    const a = failedTaskTitle({
      signature: 'verify:test/test-assertion-error',
      taskId: 'aaaaaaaa',
    })
    const b = failedTaskTitle({
      signature: 'code/uncommitted-changes',
      taskId: 'bbbbbbbb',
    })
    expect(a).not.toBe(b)
  })
})

describe('isGenericFailureLabel', () => {
  it('recognises the synthesised group labels', () => {
    expect(isGenericFailureLabel(GENERIC_FAILURE_LABEL)).toBe(true)
    expect(isGenericFailureLabel('A verification check did not pass')).toBe(true)
    expect(isGenericFailureLabel('  The changes could not be merged  ')).toBe(true)
  })

  it('does not claim purpose-built operator copy is generic', () => {
    expect(isGenericFailureLabel('Daemon running stale code — a1b2c3d → e4f5g6h')).toBe(
      false,
    )
    expect(isGenericFailureLabel('Plan review: 3 slices for PRD p-1')).toBe(false)
  })
})

describe('unknownFailureKind — triage family and colon-less step forms', () => {
  it('triage:crashed maps to the triage plain-English label', () => {
    const kind = unknownFailureKind('triage:crashed', '')
    expect(kind.warmTitle).toBe('The task could not be triaged')
  })

  it('bare "code" (no colon) maps to the same label as "code:coder-exit-nonzero"', () => {
    const bareKind = unknownFailureKind('code', '')
    const qualifiedKind = unknownFailureKind('code:coder-exit-nonzero', '')
    expect(bareKind.warmTitle).toBe(qualifiedKind.warmTitle)
    expect(bareKind.warmTitle).toMatch(/coder/i)
  })

  it('unrecognised family still hits the generic fallback', () => {
    const kind = unknownFailureKind('xyzzy:warp', '')
    expect(kind.warmTitle).toBe('Mars could not determine why this task failed')
  })

  it('continue family maps to the plain-English resume label, not the generic fallback', () => {
    const kind = unknownFailureKind('continue:some-unregistered-sub-step', '')
    expect(kind.warmTitle).toBe('The task could not be resumed')
    expect(kind.warmTitle).not.toBe('Mars could not determine why this task failed')
    expect(kind.warmTitle).not.toContain('continue:some-unregistered-sub-step')
  })

  it('no warmTitle contains a colon', () => {
    const cases = [
      'triage:crashed',
      'triage:unclassified',
      'code',
      'code:coder-exit-nonzero',
      'verify:lint',
      'setup:install',
      'merge:preflight',
      'xyzzy:unknown',
    ]
    for (const step of cases) {
      const kind = unknownFailureKind(step, '')
      expect(kind.warmTitle).not.toContain(':')
    }
  })

  it('no warmTitle contains the raw qualified failingStep string (the colon-bearing form)', () => {
    // When the step has a colon the full technical id (e.g. "triage:crashed")
    // must not appear verbatim in the warmTitle. Bare family names (e.g. "code")
    // are common English words that naturally appear inside labels like "coder",
    // so this assertion is scoped to the qualified form only.
    const qualifiedCases = [
      'triage:crashed',
      'triage:unclassified',
      'code:coder-exit-nonzero',
      'verify:lint',
      'setup:install',
      'merge:preflight',
      'xyzzy:unknown',
    ]
    for (const step of qualifiedCases) {
      const kind = unknownFailureKind(step, '')
      expect(kind.warmTitle).not.toContain(step)
    }
  })
})
