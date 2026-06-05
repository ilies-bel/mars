import { describe, expect, it } from 'vitest'
import {
  FAILURE_KINDS,
  lookupFailureKind,
  unknownFailureKind,
  failureReasonStringToCode,
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
  it('renders the step name in the warmTitle', () => {
    const kind = unknownFailureKind('setup:install', 'EACCES: permission denied')
    expect(kind.warmTitle).toBe('The setup:install step failed — see the transcript')
  })

  it('opens verboseReason with the first non-blank line of the error', () => {
    const kind = unknownFailureKind('setup:install', 'EACCES: permission denied')
    expect(kind.verboseReason).toMatch(/^EACCES: permission denied/)
  })

  it('renders the step name in the title for a different step', () => {
    const kind = unknownFailureKind('verify:typecheck', 'TS9999: something new')
    expect(kind.warmTitle).toBe(
      'The verify:typecheck step failed — see the transcript',
    )
    expect(kind.verboseReason).toMatch(/^TS9999: something new/)
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
    // Title still correctly names the step
    expect(kind.warmTitle).toBe(
      'The setup:install step failed — see the transcript',
    )
  })

  it('includes default actions', () => {
    const kind = unknownFailureKind('merge:preflight', 'some error')
    expect(kind.actions.some((a) => a.op === 'restart')).toBe(true)
    expect(kind.actions.some((a) => a.op === 'purge')).toBe(true)
  })
})

describe('code:context-exhausted catalog entry', () => {
  it('resolves to the new entry and NOT the unknown fallback', () => {
    const entry = lookupFailureKind('code:context-exhausted')
    expect(entry).not.toBeNull()
    expect(entry!.signature).toBe('code:context-exhausted')
  })

  it('has re-slice as the FIRST action', () => {
    const entry = lookupFailureKind('code:context-exhausted')
    expect(entry).not.toBeNull()
    expect(entry!.actions[0].id).toBe('re-slice')
    expect(entry!.actions[0].op).toBe('shape')
  })

  it('has restart and purge as subsequent actions', () => {
    const entry = lookupFailureKind('code:context-exhausted')
    expect(entry).not.toBeNull()
    const ids = entry!.actions.map((a) => a.id)
    expect(ids).toContain('restart')
    expect(ids).toContain('purge')
    // restart must come after re-slice
    expect(ids.indexOf('restart')).toBeGreaterThan(ids.indexOf('re-slice'))
  })

  it('is registered in FAILURE_KINDS', () => {
    expect(FAILURE_KINDS.some((k) => k.signature === 'code:context-exhausted')).toBe(true)
  })
})

describe('failureReasonStringToCode (legacy bridge)', () => {
  it('maps bare "context-exhausted" to code:context-exhausted', () => {
    expect(failureReasonStringToCode('context-exhausted')).toBe('code:context-exhausted')
  })

  it('maps "context_exhausted" (underscore) to code:context-exhausted', () => {
    expect(failureReasonStringToCode('context_exhausted')).toBe('code:context-exhausted')
  })

  it('maps a string containing "context budget exhausted" to code:context-exhausted', () => {
    expect(failureReasonStringToCode('context budget exhausted')).toBe('code:context-exhausted')
  })

  it('returns null for an unrecognised string', () => {
    expect(failureReasonStringToCode('some-other-failure')).toBeNull()
  })

  it('returns null for an empty string', () => {
    expect(failureReasonStringToCode('')).toBeNull()
  })
})
