import { describe, expect, it } from 'vitest'
import {
  asStepId,
  causeForSignature,
  classifyError,
  composeRecoveryFailureReason,
  computeFailureSignature,
  errorClassRules,
  firstNonBlankLine,
  isRecoveryFailedReason,
  isTerminalVerdictReason,
  isUnclassifiedSignature,
  STEP_ID_RE,
  stripRecoveryFailedPrefixes,
  TERMINAL_VERDICT_PREFIXES,
  terminalVerdictEchoPattern,
  UNCLASSIFIED_ERROR_CLASS,
  UNKNOWN_STEP_ID,
} from '../failure-signature'
import { truncateFailure } from '../truncate-failure'

describe('recovery-failure reason composition', () => {
  const sig = 'code:commit-contract/uncommitted-changes'

  it('prefixes exactly once', () => {
    expect(composeRecoveryFailureReason(sig, 'boom')).toBe(
      `recovery_failed:${sig}: boom`,
    )
  })

  it('is idempotent: composing a composed reason does not nest', () => {
    const once = composeRecoveryFailureReason(sig, 'boom')
    expect(composeRecoveryFailureReason(sig, once)).toBe(once)
  })

  it('collapses an already-nested reason back to a single prefix', () => {
    const nested = `recovery_failed:${sig}: recovery_failed:${sig}: recovery_failed:${sig}: boom`
    expect(composeRecoveryFailureReason(sig, nested)).toBe(
      `recovery_failed:${sig}: boom`,
    )
    expect(stripRecoveryFailedPrefixes(nested)).toBe('boom')
  })

  it('leaves a bare error untouched and multi-line output intact', () => {
    expect(stripRecoveryFailedPrefixes('no prefix here')).toBe('no prefix here')
    const multiline = 'FAIL a.test.ts\nAssertionError: expected 2 to be 1'
    expect(composeRecoveryFailureReason(sig, multiline)).toBe(
      `recovery_failed:${sig}: ${multiline}`,
    )
  })

  it('recognises a composed reason and rejects anything else', () => {
    expect(isRecoveryFailedReason(composeRecoveryFailureReason(sig, 'x'))).toBe(
      true,
    )
    expect(isRecoveryFailedReason('recovery_exhausted:merge/x')).toBe(false)
    expect(isRecoveryFailedReason(null)).toBe(false)
    expect(isRecoveryFailedReason(undefined)).toBe(false)
  })
})

describe('terminal-verdict vocabulary', () => {
  // This suite is the anti-drift gate. The loop bug (mars-76fef59f) happened
  // because a guard hardcoded a SUBSET of the prefixes the orchestrator writes.
  // Any new self-written `failure_reason` prefix must be added to
  // TERMINAL_VERDICT_PREFIXES, and this list is what says so out loud.
  const WRITTEN_BY_THE_ORCHESTRATOR = [
    // queue-fix-tasks.ts, recovery-task escalation
    'recovery_failed:',
    // queue-fix-tasks.ts, code-recovery budget gate — the one that looped
    'recovery_exhausted:',
    // queue-fix-tasks.ts, MARS_RECOVERY_DISABLED kill switch
    'recovery_disabled:',
    // queue-fix-tasks.ts, non-code re-queue cap (two call sites)
    'non-code-retry-exhausted:',
    // queue-fix-tasks.ts, signature-storm circuit breaker first trip
    'signature-storm:',
    // recovery-spawn.ts, dispatch spend-controller suppression
    'spend_control_suppressed:',
    // blocker-resolution.ts, origin failed by its dead one-shot recovery
    'origin_recovery_failed:',
  ]

  it('covers every prefix the orchestrator writes for itself, and nothing else', () => {
    expect([...TERMINAL_VERDICT_PREFIXES].sort()).toEqual(
      [...WRITTEN_BY_THE_ORCHESTRATOR].sort(),
    )
  })

  it('recognises every one of them as a spent verdict', () => {
    for (const prefix of TERMINAL_VERDICT_PREFIXES) {
      expect(isTerminalVerdictReason(`${prefix}verify/unclassified`)).toBe(true)
    }
  })

  it('does NOT match an ordinary first-failure reason, so one recovery still runs', () => {
    // ADR-0040: exactly one recovery attempt per origin failure. Everything
    // here is what a row looks like BEFORE that attempt is spent.
    for (const reason of [
      'verify:has-diff',
      'verify:typecheck',
      'code:commit-contract',
      'triage',
      'requeue:time-bound-exceeded',
      'cancelled',
      'Re-queue time bound exceeded: 1 attempt(s) over 270m',
      '',
      null,
      undefined,
    ]) {
      expect(isTerminalVerdictReason(reason)).toBe(false)
    }
  })

  it('derives a status-echo scrubber that strips a chain of any of them', () => {
    const chain = TERMINAL_VERDICT_PREFIXES.map(
      (p) => `${p}code:coder-exit-nonzero/unclassified: `,
    ).join('')
    expect(chain.replace(terminalVerdictEchoPattern(), '').trim()).toBe('')
    // A real error merely PREFIXED with one keeps its body.
    expect(
      `recovery_exhausted:verify/x: AssertionError: expected 2 to be 3`
        .replace(terminalVerdictEchoPattern(), '')
        .trim(),
    ).toBe('AssertionError: expected 2 to be 3')
  })
})

describe('computeFailureSignature', () => {
  it('produces stable technical-key signatures of shape <failingStep>/<error-class>', () => {
    const sig = computeFailureSignature(
      'verify:has-diff',
      'no commits ahead of integration branch — task did not produce any changes',
    )
    expect(sig).toBe('verify:has-diff/no-commits-ahead')
  })

  it('matches the documented signatures from the cascade incident', () => {
    expect(
      computeFailureSignature(
        'verify:has-diff',
        'no commits ahead of integration branch',
      ),
    ).toBe('verify:has-diff/no-commits-ahead')
    expect(
      computeFailureSignature(
        'merge:preflight',
        'merge target /tmp/foo has uncommitted changes that block a fast-forward',
      ),
    ).toBe('merge:preflight/uncommitted-changes')
    expect(
      computeFailureSignature(
        'merge:preflight',
        'tracked changes on paths the fast-forward would update:\n M A\n',
      ),
    ).toBe('merge:preflight/uncommitted-changes')
    expect(
      computeFailureSignature(
        'merge:preflight',
        'task branch task/x is not a fast-forward of main (diverged or behind)',
      ),
    ).toBe('merge:preflight/not-fast-forward')
  })

  it('returns the unclassified slug when no rule matches', () => {
    const sig = computeFailureSignature(
      'verify:test',
      'something nobody has written a rule for yet',
    )
    expect(sig).toBe(`verify:test/${UNCLASSIFIED_ERROR_CLASS}`)
    expect(isUnclassifiedSignature(sig)).toBe(true)
  })

  it('produces identical signatures for identical inputs', () => {
    const a = computeFailureSignature(
      'verify:typecheck',
      'TS2304: Cannot find name foo',
    )
    const b = computeFailureSignature(
      'verify:typecheck',
      'TS2304: Cannot find name foo',
    )
    expect(a).toBe(b)
  })

  it('different first-line errors map to different classes', () => {
    expect(
      computeFailureSignature('verify:typecheck', 'TS2304: cannot find name'),
    ).toBe('verify:typecheck/typecheck-cannot-find-name')
    expect(
      computeFailureSignature(
        'verify:typecheck',
        'TS2307: cannot find module',
      ),
    ).toBe('verify:typecheck/typecheck-cannot-find-module')
  })

  it('classifies realistic tsc lines that prefix the TSxxxx code with a file location', () => {
    expect(
      classifyError(
        "src/foo.ts(1,1): error TS2322: Type 'x' is not assignable to type 'y'.",
      ),
    ).toBe('typecheck-type-mismatch')
    expect(
      classifyError("src/foo.ts(12,3): error TS2304: Cannot find name 'bar'."),
    ).toBe('typecheck-cannot-find-name')
    expect(
      classifyError(
        "src/foo.ts(4,8): error TS2307: Cannot find module 'baz' or its corresponding type declarations.",
      ),
    ).toBe('typecheck-cannot-find-module')
    expect(
      classifyError(
        "src/core/daemon/__tests__/liveness.test.ts(144,51): error TS2345: Argument of type '(value: void | PromiseLike<void>) => void' is not assignable to parameter of type '(err?: Error | undefined) => void'.",
      ),
    ).toBe('typecheck-arg-type-mismatch')
    expect(
      classifyError(
        "src/cli/__tests__/foo.test.ts(23,10): error TS2694: Namespace 'queue' has no exported member 'listSiblings'.",
      ),
    ).toBe('typecheck-missing-export')
  })

  it('ignores ANSI escape codes when matching rules', () => {
    const plain = computeFailureSignature(
      'verify:has-diff',
      'no commits ahead of integration branch',
    )
    const ansi = computeFailureSignature(
      'verify:has-diff',
      '\x1B[31mno commits ahead of integration branch\x1B[0m',
    )
    expect(plain).toBe(ansi)
  })

  it('different failing steps produce different signatures even for the same error class', () => {
    const a = computeFailureSignature('verify:test', 'mystery boom')
    const b = computeFailureSignature('merge:crashed', 'mystery boom')
    expect(a).not.toBe(b)
  })

  it('classifies a missing-worktree verify error as worktree-missing, not unclassified', () => {
    // This is the exact output produced by captureHasDiff in git/verify.ts when
    // the worktree directory has been pruned (e.g. by a daemon restart).
    const sig = computeFailureSignature(
      'verify:worktree-hygiene',
      'worktree path /Users/user/.mars/worktrees/mars-6220813b no longer exists',
    )
    expect(sig).toBe('verify:worktree-hygiene/worktree-missing')
  })

  it('leaves genuine empty-diff errors as unclassified (worktree present, no commits)', () => {
    const sig = computeFailureSignature(
      'verify:has-diff',
      'git rev-list failed: fatal: not a git repository (or any of the parent directories): .git',
    )
    expect(sig).not.toBe('verify:has-diff/no-commits-ahead')
  })
})

describe('classifyError', () => {
  it('returns the rule errorClass on first match (rule order wins)', () => {
    expect(classifyError('no commits ahead of integration branch')).toBe(
      'no-commits-ahead',
    )
  })

  it('returns unclassified for empty input', () => {
    expect(classifyError('')).toBe(UNCLASSIFIED_ERROR_CLASS)
    expect(classifyError('   \n\n  ')).toBe(UNCLASSIFIED_ERROR_CLASS)
  })

  it('classifies index.lock contention errors using full-output match even when the first line is a generic Command failed lead', () => {
    // The actual error emitted by the git exec wrapper when `git checkout main`
    // hits a stale index.lock:
    const indexLockError = [
      "Command failed: git checkout main",
      "fatal: Unable to create '/repo/.git/index.lock': File exists.",
      '',
      'Another git process seems to be running in this repository',
    ].join('\n')
    expect(classifyError(indexLockError)).toBe('index-lock-contention')
  })

  it('does NOT classify a generic Command failed error as index-lock-contention when the body has no index.lock mention', () => {
    expect(classifyError('Command failed: git checkout main\nnot found')).toBe(
      UNCLASSIFIED_ERROR_CLASS,
    )
  })

  it('classifies a signal-killed workspace-dep install (exit 254) as install-timeout, not install-frozen-lockfile', () => {
    // Reproduces the misclassification that caused this recovery task to be
    // misdirected: the workspace-dep install path in worktree-install.ts emits
    // 'exited 254' (no 'with'). 254 with empty stderr is a signal-kill
    // signature (pnpm-style abort / SIGINT to a child). It must NOT route
    // to install-frozen-lockfile (which blames the manifest).
    const errMsg =
      '[setup:install] workspace dep install failed (packages/workflow): ' +
      'pnpm install --frozen-lockfile exited 254\nstderr (truncated):\n'
    expect(classifyError(errMsg)).toBe('install-timeout')
  })

  it('classifies a SIGINT-killed workspace-dep install (exit 130) as install-timeout', () => {
    const errMsg =
      '[setup:install] workspace dep install failed (packages/workflow): ' +
      'pnpm install --frozen-lockfile exited 130\nstderr (truncated):\n'
    expect(classifyError(errMsg)).toBe('install-timeout')
  })

  it('classifies a SIGKILL-killed workspace-dep install (exit 137, bare "exited 137" without "with") as install-timeout', () => {
    // The workspace-dep install error format omits "with" — without the loosened
    // regex, this would fall through to install-frozen-lockfile.
    const errMsg =
      '[setup:install] workspace dep install failed (packages/workflow): ' +
      'pnpm install --frozen-lockfile exited 137\nstderr (truncated):\n'
    expect(classifyError(errMsg)).toBe('install-timeout')
  })

  it('still classifies WorktreeInstallError "exited with 137" as install-timeout (regression guard)', () => {
    const errMsg =
      'pnpm install --frozen-lockfile (cwd=/some/dir) exited with 137\n' +
      'stderr (truncated):\n'
    expect(classifyError(errMsg)).toBe('install-timeout')
  })

  it('classifies a true manifest-drift failure (non-signal exit) as install-frozen-lockfile', () => {
    // A genuine frozen-lockfile mismatch returns exit 1 with a real stderr
    // message — this must still route to the manifest-blame recipe.
    const errMsg =
      'pnpm install --frozen-lockfile exited with 1\nstderr (truncated):\n' +
      'ERR_PNPM_OUTDATED_LOCKFILE Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with package.json'
    expect(classifyError(errMsg)).toBe('install-frozen-lockfile')
  })
})

describe('matchFull rules are checked against full output', () => {
  it('computeFailureSignature produces merge:crashed/index-lock-contention for the real error shape', () => {
    const errorOutput = [
      "Command failed: git checkout main",
      "fatal: Unable to create '/Users/dev/repo/.git/index.lock': File exists.",
      '',
      "Another git process seems to be running in this repository, e.g.",
      "an editor opened by 'git commit'. Please make sure all processes",
      "are terminated then try again.",
    ].join('\n')
    expect(computeFailureSignature('merge:crashed', errorOutput)).toBe(
      'merge:crashed/index-lock-contention',
    )
  })

  it('computeFailureSignature produces merge:vcs-supervisor-aborted/not-fast-forward for the git merge --ff-only error shape', () => {
    // The actual error captured when `git merge --ff-only <branch>` fails because
    // main advanced after the VCS supervisor rebased the task branch:
    // - The first non-blank line is from the VCS supervisor JSON output (doesn't
    //   match any `match` rule), so classification falls through to matchFull.
    // - `fatal: Not possible to fast-forward, aborting.` appears in the body.
    const errorOutput = [
      '{"type":"result","subtype":"success","result":"COMMIT: rebase complete\\nSTATUS: completed"}',
      'hint: Diverging branches can\'t be fast-forwarded, you need to either:',
      'hint:',
      'hint: \tgit merge --no-ff',
      'hint:',
      'hint: \tor:',
      'hint:',
      'hint: \tgit rebase',
      'hint:',
      'hint: Disable this message with "git config set advice.diverging false"',
      'fatal: Not possible to fast-forward, aborting.',
      'Command failed: git merge --ff-only task/mars-eca7da0e',
    ].join('\n')
    expect(
      computeFailureSignature('merge:vcs-supervisor-aborted', errorOutput),
    ).toBe('merge:vcs-supervisor-aborted/not-fast-forward')
  })

  it('classifyError returns not-fast-forward for the pure git merge --ff-only output without VCS supervisor preamble', () => {
    const gitOnlyError = [
      'hint: Diverging branches can\'t be fast-forwarded, you need to either:',
      'hint: \tgit merge --no-ff',
      'fatal: Not possible to fast-forward, aborting.',
      'Command failed: git merge --ff-only task/abc',
    ].join('\n')
    expect(classifyError(gitOnlyError)).toBe('not-fast-forward')
  })

  it('computeFailureSignature produces merge:vcs-supervisor-aborted/not-fast-forward for the Path 2 ancestry-check error shape', () => {
    // mergeBranch (git.ts) Path 2: VCS supervisor completed the rebase but
    // integration advanced before git.ts ran `merge-base --is-ancestor`.
    // First-line message: "fast-forward into <branch> not possible: <sha> is not
    // an ancestor of <sha>." followed by supervisor JSON in the accumulated output.
    // "is not an ancestor of" is NOT matched by the old `/is not a fast-forward of/i`
    // rule, so this previously produced /unclassified (task mars-c5b48744, 2026-05-30).
    const errorOutput = [
      'fast-forward into main not possible: abc123def456abc123 is not an ancestor of def456abc123def4.',
      '{"type":"result","subtype":"success","result":"COMMIT: rebase complete\\nSTATUS: completed"}',
    ].join('\n')
    expect(
      computeFailureSignature('merge:vcs-supervisor-aborted', errorOutput),
    ).toBe('merge:vcs-supervisor-aborted/not-fast-forward')
  })

  it('computeFailureSignature produces merge:vcs-supervisor-aborted/not-fast-forward for the Path 3 CAS-race error shape', () => {
    // mergeBranch (git.ts) Path 3: ancestry check passed but integration advanced
    // in the window before `git update-ref <ref> <new> <old>` executed.
    // First-line message: "integration moved during merge, retry needed: <branch>
    // advanced concurrently." also previously produced /unclassified.
    const errorOutput = [
      'integration moved during merge, retry needed: main advanced concurrently.',
      '{"type":"result","subtype":"success","result":"COMMIT: rebase complete\\nSTATUS: completed"}',
    ].join('\n')
    expect(
      computeFailureSignature('merge:vcs-supervisor-aborted', errorOutput),
    ).toBe('merge:vcs-supervisor-aborted/not-fast-forward')
  })

  it('computeFailureSignature produces verify:test/test-pg-undefined-table for the PostgreSQL undefined-table error shape', () => {
    // The error captured when a test fixture queries a table before applying
    // the canonical schema (pg-schema.ts ensureSchema) to its per-test
    // database. The distinguishing signal (42P01 / relation "..." does not
    // exist) is buried in the body after the vitest preamble - hence matchFull.
    const errorOutput = [
      ' \u00d7 src/bus/__tests__/publisher.test.ts > publishWithRetry > two concurrent publishWithRetry calls both commit',
      '   \u2192 relation "events" does not exist',
      '',
      ' FAIL  src/bus/__tests__/publisher.test.ts > publishWithRetry > ...',
      'error: relation "events" does not exist',
      "    code: '42P01',",
    ].join('\n')
    expect(computeFailureSignature('verify:test', errorOutput)).toBe(
      'verify:test/test-pg-undefined-table',
    )
  })

  it('computeFailureSignature produces verify:test/test-pg-connection-refused when the embedded server is unreachable', () => {
    const errorOutput = [
      ' FAIL  src/core/store/__tests__/task-store.test.ts > opens the store',
      'Error: connect ECONNREFUSED 127.0.0.1:54321',
    ].join('\n')
    expect(computeFailureSignature('verify:test', errorOutput)).toBe(
      'verify:test/test-pg-connection-refused',
    )
  })

  it('computeFailureSignature produces verify:test/test-pg-deadlock for the PostgreSQL deadlock error shape', () => {
    const errorOutput = [
      ' FAIL  src/core/__tests__/arc.test.ts > concurrent status flips',
      'error: deadlock detected',
      "    code: '40P01',",
    ].join('\n')
    expect(computeFailureSignature('verify:test', errorOutput)).toBe(
      'verify:test/test-pg-deadlock',
    )
  })

  it('computeFailureSignature produces verify:test/test-no-suite-found for the real vitest empty-file error shape', () => {
    // The actual error captured when vitest discovers a file that matches its
    // test-file glob but contains no describe/it/test blocks (a comment-only
    // placeholder left behind by a coding agent).
    const errorOutput = [
      '⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯',
      '',
      ' FAIL  src/core/agents/__tests__/registry.test.ts [ src/core/agents/__tests__/registry.test.ts ]',
      'Error: No test suite found in file /Users/dev/repo/orchestrator/src/core/agents/__tests__/registry.test.ts',
      '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯',
    ].join('\n')
    expect(computeFailureSignature('verify:test', errorOutput)).toBe(
      'verify:test/test-no-suite-found',
    )
  })

  it('test-no-suite-found does not interfere with AssertionError classification', () => {
    // An AssertionError that happens to mention "No test suite" should still
    // classify as test-assertion-error (AssertionError rule comes first).
    const assertionWithSuiteText = [
      'AssertionError: expected No test suite found to be defined',
    ].join('\n')
    expect(classifyError(assertionWithSuiteText)).toBe('test-assertion-error')
  })

  it('test-pg-undefined-table does not interfere with AssertionError classification', () => {
    // An AssertionError that happens to contain "does not exist" text should
    // still classify as test-assertion-error (AssertionError rule comes first
    // in the list).
    const assertionWithTableText = [
      'AssertionError: expected relation "events" does not exist to be caught',
    ].join('\n')
    expect(classifyError(assertionWithTableText)).toBe('test-assertion-error')
  })

  it('computeFailureSignature produces merge:vcs-supervisor-aborted/rebase-no-in-progress-state for the guard early-abort message', () => {
    // mergeBranch Step 1: git rebase exits non-zero but leaves no rebase-merge/
    // or rebase-apply/ state (e.g. uncommitted worktree changes blocked the
    // rebase before it could conflict). The guard detects isRebaseInProgress()=false
    // and returns aborted:true with this specific first-line so classification
    // routes to a named slug rather than /unclassified.
    const errorOutput = [
      'rebase produced no in-progress state: nothing to reconcile (rebase exit 1)',
      'error: cannot rebase: You have unstaged changes.',
      'error: Please commit or stash them.',
    ].join('\n')
    expect(
      computeFailureSignature('merge:vcs-supervisor-aborted', errorOutput),
    ).toBe('merge:vcs-supervisor-aborted/rebase-no-in-progress-state')
  })

  it('computeFailureSignature produces merge:vcs-supervisor-aborted/rebase-dirty-worktree for the pre-rebase dirty-worktree sentinel', () => {
    // mergeBranch pre-rebase check: git status --porcelain returned non-empty
    // output, so the dirty-worktree guard fires before git rebase runs and
    // returns aborted:true with this specific first-line. The sentinel string
    // is distinct from the post-rebase "rebase produced no in-progress state"
    // output so the two failure classes stay separate.
    const errorOutput = [
      'worktree dirty before rebase: cannot start rebase with uncommitted/untracked files',
      ' M src/core/lib/git/merge.ts',
      '?? scratch.ts',
    ].join('\n')
    expect(
      computeFailureSignature('merge:vcs-supervisor-aborted', errorOutput),
    ).toBe('merge:vcs-supervisor-aborted/rebase-dirty-worktree')
  })

  it('classifyError returns rebase-dirty-worktree only when the sentinel string is present', () => {
    // The rule keys on the sentinel, not on the word "dirty": a generic
    // message without the sentinel does not trigger the class.
    expect(
      classifyError('worktree dirty before rebase: cannot start rebase with uncommitted/untracked files'),
    ).toBe('rebase-dirty-worktree')
    expect(
      classifyError('generic dirty worktree message'),
    ).not.toBe('rebase-dirty-worktree')
  })

  it('classifies the dirty-worktree sentinel even when the merge primitive prefixes it', () => {
    // Regression: task fix-30ac0aaa. The merge primitive stores the sentinel
    // one line down, behind "merge aborted by vcs-supervisor; worktree
    // retained at <path>". Under first-line-only matching the classifier saw
    // only the wrapper and the failure degraded to `merge/unclassified` — a
    // generic bucket that names neither the cause nor the step, and that feeds
    // the signature-storm circuit breaker. The rule is matchFull so the
    // sentinel stays reachable from the wrapped form too.
    const wrapped = [
      'merge aborted by vcs-supervisor; worktree retained at .mars/worktrees/mars-8e7b69eb',
      'worktree dirty before rebase: cannot start rebase with uncommitted/untracked files',
      ' M orchestrator/src/core/lib/derived-row-actions.ts',
    ].join('\n')
    expect(classifyError(wrapped)).toBe('rebase-dirty-worktree')
    // Both the inline stamp (fine-grained step) and the degraded
    // recovery-spawn path (coarse `failed_phase`) land on a named class.
    expect(
      computeFailureSignature('merge:vcs-supervisor-aborted', wrapped),
    ).toBe('merge:vcs-supervisor-aborted/rebase-dirty-worktree')
    expect(computeFailureSignature('merge', wrapped)).toBe(
      'merge/rebase-dirty-worktree',
    )
  })

})

describe('errorClassRules registry', () => {
  it('every rule slug is kebab-case with no whitespace', () => {
    for (const rule of errorClassRules) {
      expect(rule.errorClass).toMatch(/^[a-z][a-z0-9-]*$/)
    }
  })

  it('errorClass slugs are unique', () => {
    const seen = new Set<string>()
    for (const rule of errorClassRules) {
      expect(seen.has(rule.errorClass)).toBe(false)
      seen.add(rule.errorClass)
    }
  })
})

describe('causeForSignature', () => {
  it('renders an operator-owned cause for the dirty-integration-branch signature naming clean main + restart', () => {
    const cause = causeForSignature(
      'merge:preflight/uncommitted-changes',
      'mars-1234abcd',
    )
    expect(cause).not.toBeNull()
    expect(cause!.toLowerCase()).toContain('integration branch')
    expect(cause!.toLowerCase()).toContain('uncommitted')
    expect(cause).toContain('mars restart mars-1234abcd')
  })

  it('renders an agent-owned cause for the no-commits-ahead signature stating the agent did not commit', () => {
    const cause = causeForSignature(
      'verify:has-diff/no-commits-ahead',
      'mars-1234abcd',
    )
    expect(cause).not.toBeNull()
    expect(cause!.toLowerCase()).toContain("didn't commit")
    expect(cause!.toLowerCase()).toMatch(/restart|new task/)
  })

  it('renders an infrastructure-owned cause for the worktree-missing signature naming daemon restart + restart', () => {
    const cause = causeForSignature(
      'verify:worktree-hygiene/worktree-missing',
      'mars-1234abcd',
    )
    expect(cause).not.toBeNull()
    expect(cause!.toLowerCase()).toContain('worktree')
    expect(cause).toContain('mars restart mars-1234abcd')
  })

  it('returns null for an unregistered signature so the renderer omits the line entirely', () => {
    expect(
      causeForSignature('verify:test/something-else', 'mars-1234abcd'),
    ).toBeNull()
    expect(
      causeForSignature(
        `verify:test/${UNCLASSIFIED_ERROR_CLASS}`,
        'mars-1234abcd',
      ),
    ).toBeNull()
  })

  it('renders an environmental cause for the api-unreachable signature naming connectivity and restart', () => {
    const cause = causeForSignature(
      'code:coder-exit-nonzero/api-unreachable',
      'mars-1234abcd',
    )
    expect(cause).not.toBeNull()
    // Must mention the API (not the code being at fault)
    expect(cause!.toLowerCase()).toMatch(/api|connect/)
    // Must tell the operator to retry
    expect(cause).toContain('mars restart mars-1234abcd')
  })
})

describe('api-unreachable classification', () => {
  it('classifies the exact error text from the real symptom as api-unreachable', () => {
    // This is the exact `last stream text` line from the failing task transcript.
    expect(
      classifyError('API Error: Unable to connect to API (ConnectionRefused)'),
    ).toBe('api-unreachable')
  })

  it('computeFailureSignature produces code:coder-exit-nonzero/api-unreachable for the real coder error format', () => {
    // The coder-exit-nonzero path in primitives/index.ts builds the errorOutput as:
    // "coder process exited 1. worktree was clean at exit (no uncommitted work found).
    //  stderr empty; last stream text:\nAPI Error: Unable to connect to API (ConnectionRefused)"
    const errorOutput = [
      'coder process exited 1. worktree was clean at exit (no uncommitted work found).',
      'stderr empty; last stream text:',
      'API Error: Unable to connect to API (ConnectionRefused)',
    ].join('\n')
    expect(
      computeFailureSignature('code:coder-exit-nonzero', errorOutput),
    ).toBe('code:coder-exit-nonzero/api-unreachable')
  })

  it('classifies bare "Unable to connect to API" (without the ConnectionRefused parenthetical) as api-unreachable', () => {
    expect(
      classifyError('Unable to connect to API'),
    ).toBe('api-unreachable')
  })

  it('does NOT classify a PostgreSQL ECONNREFUSED test failure as api-unreachable', () => {
    // The test-pg-connection-refused rule must still claim ECONNREFUSED
    // from a test failure context. The api-unreachable pattern requires
    // "Unable to connect to API" or an "API Error:…ECONNREFUSED" form.
    const pgError = [
      ' FAIL  src/core/store/__tests__/task-store.test.ts > opens the store',
      'Error: connect ECONNREFUSED 127.0.0.1:54321',
    ].join('\n')
    expect(classifyError(pgError)).toBe('test-pg-connection-refused')
    expect(classifyError(pgError)).not.toBe('api-unreachable')
  })
})

describe('asStepId', () => {
  it('returns a valid step id unchanged', () => {
    expect(asStepId('verify:has-diff')).toBe('verify:has-diff')
    expect(asStepId('code:coder-exit-nonzero')).toBe('code:coder-exit-nonzero')
    expect(asStepId('requeue:time-bound-exceeded')).toBe('requeue:time-bound-exceeded')
    expect(asStepId('unknown')).toBe('unknown')
    expect(asStepId('behaviour-verify:dod-unmet')).toBe('behaviour-verify:dod-unmet')
  })

  it('returns null for prose with spaces', () => {
    // The exact string that was reaching the signature before this fix.
    expect(asStepId('Re-queue time bound exceeded: 1 attempt(s) over 270m (bound 120m).')).toBeNull()
    expect(asStepId('Re-queue time bound exceeded: 2 attempt(s) over 275m (bound 120m).')).toBeNull()
  })

  it('returns null for strings with uppercase letters', () => {
    expect(asStepId('Verify:has-diff')).toBeNull()
    expect(asStepId('VERIFY')).toBeNull()
  })

  it('returns null for empty or blank strings', () => {
    expect(asStepId('')).toBeNull()
    expect(asStepId('   ')).toBeNull()
  })

  it('returns null for null or undefined', () => {
    expect(asStepId(null)).toBeNull()
    expect(asStepId(undefined)).toBeNull()
  })

  it('returns null for strings with disallowed punctuation', () => {
    expect(asStepId('verify/')).toBeNull()
    expect(asStepId('verify:has-diff/no-commits-ahead')).toBeNull() // slash is a separator in signatures, not step ids
    expect(asStepId('step(1)')).toBeNull()
  })

  it('STEP_ID_RE accepts all well-formed step ids used by the system', () => {
    const validIds = [
      'verify:has-diff',
      'verify:typecheck',
      'verify:test',
      'merge:preflight',
      'merge:crashed',
      'merge:vcs-supervisor-aborted',
      'code:coder-exit-nonzero',
      'setup:install-failed',
      'behaviour-verify:dod-unmet',
      'requeue:time-bound-exceeded',
      'unknown',
    ]
    for (const id of validIds) {
      expect(STEP_ID_RE.test(id), `expected ${id} to pass STEP_ID_RE`).toBe(true)
    }
  })
})

describe('computeFailureSignature — prose-blocking invariant', () => {
  it('does not mint a prose-contaminated signature when failure_reason is prose', () => {
    // Reproduces the exact live defect: two re-queue ceiling failures that
    // differed only in elapsed minutes produced distinct signatures.
    const sig270 = computeFailureSignature(
      'Re-queue time bound exceeded: 1 attempt(s) over 270m (bound 120m).',
      'Re-queue time bound exceeded: task retried 1 time(s) over 270 minutes without completing.',
    )
    const sig271 = computeFailureSignature(
      'Re-queue time bound exceeded: 1 attempt(s) over 271m (bound 120m).',
      'Re-queue time bound exceeded: task retried 1 time(s) over 271 minutes without completing.',
    )
    // Both must be identical — prose step was normalised to UNKNOWN_STEP_ID.
    expect(sig270).toBe(sig271)
    // The step half must not contain the prose text.
    expect(sig270.startsWith(UNKNOWN_STEP_ID + '/')).toBe(true)
  })

  it('a verify:<gate> step id still passes through unchanged (regression guard)', () => {
    // This is the fine-grained step the verify primitive stamps. It must
    // reach the signature unchanged so the gate meta-monitor and recipe
    // dedup continue to work correctly.
    const sig = computeFailureSignature(
      'verify:has-diff',
      'no commits ahead of integration branch',
    )
    expect(sig).toBe('verify:has-diff/no-commits-ahead')
    expect(sig.startsWith('verify:has-diff/')).toBe(true)
  })

  it('two requeue-ceiling escalations with different elapsed minutes share one signature', () => {
    // Simulate what recovery-spawn.ts sees after the requeue-ceiling fix:
    // failureReason is the stable step id, error contains the varying prose.
    const sig1 = computeFailureSignature(
      'requeue:time-bound-exceeded', // stable step id from requeue-ceiling
      'Re-queue time bound exceeded: task retried 1 time(s) over 270 minutes without completing (bound 120m). Run `mars restart abc` to reset.',
    )
    const sig2 = computeFailureSignature(
      'requeue:time-bound-exceeded',
      'Re-queue time bound exceeded: task retried 2 time(s) over 275 minutes without completing (bound 120m). Run `mars restart abc` to reset.',
    )
    expect(sig1).toBe(sig2)
    expect(sig1).toBe(`requeue:time-bound-exceeded/${UNCLASSIFIED_ERROR_CLASS}`)
  })

  it('computeFailureSignature remains idempotent with normalised step ids', () => {
    const step = 'verify:typecheck'
    const error = 'TS2304: Cannot find name foo'
    const once = computeFailureSignature(step, error)
    const twice = computeFailureSignature(step, once)
    expect(once).toBe(twice)
  })
})

describe('firstNonBlankLine', () => {
  it('returns the first non-blank trimmed line', () => {
    expect(firstNonBlankLine('\n   \n  hello\nworld')).toBe('hello')
  })

  it('returns empty string for all-blank input', () => {
    expect(firstNonBlankLine('   \n\n\t\n')).toBe('')
  })

  // NOTE: the git-metadata-denied suite lives at the bottom of this file.

  it('strips ANSI codes', () => {
    expect(firstNonBlankLine('\x1B[31mboom\x1B[0m')).toBe('boom')
  })
})

describe('provider-binary-missing classification', () => {
  // "The command could not be executed" is a different diagnosis from "the
  // coder ran and failed"; without this class both landed in the contentless
  // coder-exit-nonzero bucket.
  it('classifies a spawn ENOENT surfaced by runSubprocessStreaming', () => {
    expect(classifyError('spawn codex ENOENT: spawn codex ENOENT')).toBe(
      'provider-binary-missing',
    )
  })

  it('classifies a spawn EACCES', () => {
    expect(classifyError('spawn /opt/bin/codex EACCES: permission denied')).toBe(
      'provider-binary-missing',
    )
  })

  it("classifies the orchestrator's own exit-127 wording", () => {
    expect(
      classifyError('coder exited 127 before completing; worktree was clean at exit'),
    ).toBe('provider-binary-missing')
  })

  it('produces a distinct signature instead of an unclassified coder exit', () => {
    const sig = computeFailureSignature(
      'code:coder-exit-nonzero',
      'coder exited 127 before completing; spawn codex ENOENT',
    )
    expect(sig).toBe('code:coder-exit-nonzero/provider-binary-missing')
    expect(isUnclassifiedSignature(sig)).toBe(false)
  })

  it('leaves an ordinary non-zero coder exit alone', () => {
    expect(
      classifyError('coder exited 1 before completing; worktree was clean at exit'),
    ).toBe(UNCLASSIFIED_ERROR_CLASS)
  })

  it('does not fire on a shell "command not found" quoted inside coder output', () => {
    expect(
      classifyError(
        ['coder exited 1 before completing;', 'bash: line 1: fd: command not found'].join('\n'),
      ),
    ).toBe(UNCLASSIFIED_ERROR_CLASS)
  })

  it('does not steal the signal-killed install class (exit 137/130/254)', () => {
    expect(classifyError('install exited with 137')).toBe('install-timeout')
  })

  it('carries an operator-facing cause sentence', () => {
    const cause = causeForSignature(
      'code:coder-exit-nonzero/provider-binary-missing',
      'mars-abc123',
    )
    expect(cause).not.toBeNull()
    expect(cause).toContain('could not be executed')
  })

  it('is registered exactly once in the rule table', () => {
    expect(
      errorClassRules.filter((r) => r.errorClass === 'provider-binary-missing'),
    ).toHaveLength(1)
  })
})

describe('git-metadata-denied classification', () => {
  // The incident: 79 consecutive coder runs failed at the commit gate with an
  // EPERM on <repo>/.git/worktrees/<id>/index.lock, every one of them bucketed
  // as code/unclassified — which poisoned the generic bucket and tripped the
  // signature storm breaker.
  const CODEX_WORDING =
    "Git cannot create '.git/worktrees/mars-abc123/index.lock': Operation not permitted"

  it('classifies the commit-gate wording', () => {
    expect(classifyError(CODEX_WORDING)).toBe('git-metadata-denied')
  })

  it("classifies git's own fatal wording", () => {
    expect(
      classifyError(
        "fatal: cannot create '.git/worktrees/mars-abc123/index.lock': Operation not permitted",
      ),
    ).toBe('git-metadata-denied')
  })

  it('classifies a raw EPERM report', () => {
    expect(
      classifyError(
        'Error: EPERM: operation not permitted, open ".git/worktrees/x/index.lock"',
      ),
    ).toBe('git-metadata-denied')
  })

  it('classifies when the signal is buried below a generic lead line', () => {
    const out = ['Command failed: git commit -m "feat: thing"', CODEX_WORDING].join('\n')
    expect(classifyError(out)).toBe('git-metadata-denied')
  })

  it('produces a distinct signature instead of code/unclassified', () => {
    const sig = computeFailureSignature('code:coder-exit-nonzero', CODEX_WORDING)
    expect(sig).toBe('code:coder-exit-nonzero/git-metadata-denied')
    expect(isUnclassifiedSignature(sig)).toBe(false)
  })

  it('does NOT swallow ordinary stale-lock contention', () => {
    expect(
      classifyError(
        [
          'Command failed: git checkout main',
          "fatal: Unable to create '.git/index.lock': File exists.",
        ].join('\n'),
      ),
    ).toBe('index-lock-contention')
  })

  it('carries an operator-facing cause sentence', () => {
    const cause = causeForSignature(
      'code:coder-exit-nonzero/git-metadata-denied',
      'mars-abc123',
    )
    expect(cause).not.toBeNull()
    expect(cause).toContain('.git/worktrees')
  })

  it('is registered exactly once in the rule table', () => {
    expect(errorClassRules.filter((r) => r.errorClass === 'git-metadata-denied')).toHaveLength(
      1,
    )
  })
})

describe('code:killed — signal-death classification', () => {
  // Exit 143 = 128 + SIGTERM (15); exit 137 = 128 + SIGKILL (9).
  // The coder step prepends a "code child killed by …" marker (mirroring the
  // verify step's "verify child killed by …" marker) so computeFailureSignature
  // can override the nominal `code:coder-exit-nonzero` gate name.

  it('classifies a coder exit 143 (SIGTERM) as code:killed/sigterm', () => {
    const errorOutput = [
      'code child killed by SIGTERM (exit 143)',
      'coder process exited 143. worktree had 5 uncommitted path(s); preserved as wip(checkpoint) commit on branch task/mars-33fe7311',
    ].join('\n')
    expect(computeFailureSignature('code:coder-exit-nonzero', errorOutput)).toBe(
      'code:killed/sigterm',
    )
  })

  it('classifies a coder exit 137 (SIGKILL) as code:killed/sigkill', () => {
    const errorOutput = [
      'code child killed by SIGKILL (exit 137)',
      'coder process exited 137. worktree was clean at exit (no uncommitted work found). stderr empty; no stream text captured',
    ].join('\n')
    expect(computeFailureSignature('code:coder-exit-nonzero', errorOutput)).toBe(
      'code:killed/sigkill',
    )
  })

  it('does not classify a regular non-zero exit (e.g. exit 1) as code:killed', () => {
    const errorOutput =
      'coder process exited 1. worktree was clean at exit (no uncommitted work found). stderr empty; no stream text captured'
    const sig = computeFailureSignature('code:coder-exit-nonzero', errorOutput)
    expect(sig.startsWith('code:killed/')).toBe(false)
  })

  it('is case-insensitive on the SIGTERM marker', () => {
    // Mirror the case-insensitivity the verify:killed regex already uses.
    const errorOutput = 'code child killed by sigterm (exit 143)\nextra output'
    expect(computeFailureSignature('code:coder-exit-nonzero', errorOutput)).toBe(
      'code:killed/sigterm',
    )
  })
})

describe('fallback sub-buckets (coarse classifiers when no specific rule matches)', () => {
  describe('typecheck-error', () => {
    it('classifies a TS error code not covered by a specific rule as typecheck-error', () => {
      // TS2571 is not in the specific rule set — should land in the coarse bucket
      expect(classifyError("src/foo.ts(1,1): error TS2571: Object is of type 'unknown'.")).toBe(
        'typecheck-error',
      )
    })

    it('does not fire when a specific typecheck rule already matched', () => {
      // TS2339 is claimed by typecheck-property-not-exist — must win over the coarse bucket
      expect(classifyError('error TS2339: Property does not exist')).toBe(
        'typecheck-property-not-exist',
      )
    })

    it('does not fire when there is no TS error code in the output', () => {
      expect(classifyError('npm install failed with exit 1')).not.toBe('typecheck-error')
    })
  })

  describe('enoent', () => {
    it('classifies ENOENT as enoent', () => {
      expect(classifyError("Error: ENOENT: no such file or directory, open '/path/to/file'")).toBe(
        'enoent',
      )
    })

    it('classifies "no such file or directory" as enoent', () => {
      expect(classifyError('No such file or directory: /missing/path')).toBe('enoent')
    })
  })

  describe('timed-out', () => {
    it('classifies ETIMEDOUT as timed-out', () => {
      expect(classifyError('Error: connect ETIMEDOUT 1.2.3.4:443')).toBe('timed-out')
    })

    it('classifies "timed out" prose as timed-out', () => {
      expect(classifyError('Operation timed out after 30000ms')).toBe('timed-out')
    })
  })

  describe('no double-suffix invariant', () => {
    it('computeFailureSignature is idempotent for identical step', () => {
      const steps = ['verify:typecheck', 'code:coder-exit-nonzero', 'unknown', 'setup']
      const outputs = [
        'TS2571: Object is of type unknown',
        "Error: ENOENT: no such file or directory, open '/path'",
        'something completely unrecognised',
        '',
      ]
      for (const step of steps) {
        for (const output of outputs) {
          const once = computeFailureSignature(step, output)
          const twice = computeFailureSignature(step, once)
          expect(twice).toBe(once)
          // No double-suffix: at most one '/' (step and class separated by exactly one slash)
          const slashCount = (once.match(/\//g) ?? []).length
          expect(slashCount).toBe(1)
        }
      }
    })

    it('computeFailureSignature never double-suffixes when errorOutput already contains unclassified', () => {
      const sig = computeFailureSignature('verify:typecheck', 'some unknown error')
      expect(sig).toBe('verify:typecheck/unclassified')
      // Feeding back the signature must not produce verify:typecheck/unclassified/unclassified
      const sig2 = computeFailureSignature('verify:typecheck', sig)
      expect(sig2).toBe('verify:typecheck/unclassified')
      expect(sig2).not.toContain('/unclassified/unclassified')
    })
  })

  describe('path and task-id invariant', () => {
    it('the signature never contains a filesystem path', () => {
      const errorWithPath =
        "Error: ENOENT: no such file or directory, open '/home/user/.mars/worktrees/mars-abc123/src/file.ts'"
      const sig = computeFailureSignature('setup:worktree-setup', errorWithPath)
      // Signature is always step/class — a valid slug pair with exactly one slash
      expect(sig).toMatch(/^[a-z][a-z0-9:/-]*\/[a-z][a-z0-9-]*$/)
      // No filesystem path fragments bleed through
      expect(sig).not.toContain('.mars')
      expect(sig).not.toContain('worktrees')
      expect(sig).not.toContain('mars-abc123')
    })

    it('the signature never contains a mars task id', () => {
      const errorWithTaskId =
        'origin worktree for recovery is missing: expected branch task/mars-aabbcc11 at /path (origin task mars-aabbcc11) is not present on disk'
      const sig = computeFailureSignature('setup:origin-worktree-missing', errorWithTaskId)
      expect(sig).toMatch(/^[a-z][a-z0-9:/-]*\/[a-z][a-z0-9-]*$/)
      expect(sig).not.toContain('mars-aabbcc11')
    })
  })

  describe('captured output tail wiring', () => {
    it('truncateFailure keeps the TAIL of the error (diagnostic end, not the beginning)', () => {
      // Re-verify the tail-keeps contract so it is explicitly linked to recovery prompt wiring.
      // handleTaskFailureWithFixTask calls truncateFailure(errorOutput) and sets statusOutput
      // to truncatedError — so the tail of real captured output reaches the recovery prompt.
      const preamble = 'x'.repeat(3000)
      const tail = 'AssertionError: expected 1 to be 2\n  at suite.ts:42:5'
      const result = truncateFailure(preamble + tail, 2000)
      expect(result).toContain('AssertionError: expected 1 to be 2')
      expect(result).toContain('at suite.ts:42:5')
      expect(result.startsWith('[…truncated')).toBe(true)
    })
  })
})
