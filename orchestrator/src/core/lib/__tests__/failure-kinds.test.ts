import { describe, expect, it } from 'vitest'
import {
  FAILURE_KINDS,
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

  it('merge:vcs-supervisor-aborted/* → "The changes clashed with main and were too hard to merge"', () => {
    const entries = FAILURE_KINDS.filter((k) =>
      k.signature.startsWith('merge:vcs-supervisor-aborted/'),
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

  it('warmTitle for "unknown" step does not contain the word "unknown"', () => {
    const kind = unknownFailureKind('unknown', '')
    expect(kind.warmTitle).not.toMatch(/\bunknown\b/i)
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

describe('verify:has-diff/worktree-missing — distinct copy from the empty-diff case', () => {
  it('is registered with a missing-worktree-themed warm title (not "did not produce any changes")', () => {
    const entry = lookupFailureKind('verify:has-diff/worktree-missing')
    expect(entry).not.toBeNull()
    // The whole point of distinguishing this signature: the operator-facing
    // copy must NOT say "did not produce any changes" — the coder never had
    // a chance to produce a diff because the worktree was already gone.
    expect(entry!.warmTitle).not.toMatch(/did not produce any changes/i)
    expect(entry!.warmTitle).toMatch(/worktree/i)
  })

  it('verboseReason explains the worktree disappeared and frames it as infrastructure, not a coder error', () => {
    const entry = lookupFailureKind('verify:has-diff/worktree-missing')
    expect(entry).not.toBeNull()
    expect(entry!.verboseReason).toMatch(/worktree/i)
    expect(entry!.verboseReason).not.toMatch(/coder.*encountered an error|misunderstood the task/i)
  })

  it('verify:has-diff/unclassified (true no-diff case) is unchanged — still blames the coder for no changes', () => {
    // The existing copy is correct for the worktree-present / empty-diff case
    // and must not regress.
    const entry = lookupFailureKind('verify:has-diff/unclassified')
    expect(entry).not.toBeNull()
    expect(entry!.warmTitle).toBe('The coder did not produce any changes')
    expect(entry!.verboseReason).toBe(
      'The verify step could not confirm that file changes were produced. The coder may have encountered an error or misunderstood the task.',
    )
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
})
