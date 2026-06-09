import { describe, expect, it } from 'vitest'
import {
  causeForSignature,
  classifyError,
  computeFailureSignature,
  errorClassRules,
  firstNonBlankLine,
  isUnclassifiedSignature,
  UNCLASSIFIED_ERROR_CLASS,
} from '../failure-signature'

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
      'verify:has-diff',
      'has-diff: worktree path /Users/user/.mars/worktrees/mars-6220813b no longer exists',
    )
    expect(sig).toBe('verify:has-diff/worktree-missing')
  })

  it('leaves genuine empty-diff errors as unclassified (worktree present, no commits)', () => {
    const sig = computeFailureSignature(
      'verify:has-diff',
      'git rev-list failed: fatal: not a git repository (or any of the parent directories): .git',
    )
    expect(sig).not.toBe('verify:has-diff/worktree-missing')
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

  it('computeFailureSignature produces verify:test/test-libsql-no-such-table for the real libsql concurrent-transaction error shape', () => {
    // The actual error captured when two concurrent publishWithRetry() calls race
    // against a libsql client backed by ':memory:'. The second transaction gets a
    // fresh empty in-memory DB (libsql sets this.#db = null after each transaction
    // call), so it sees no schema. The distinguishing signal ("no such table:") is
    // buried in the body after the vitest test-runner preamble — hence matchFull.
    const errorOutput = [
      ' × src/bus/__tests__/publisher.test.ts > publishWithRetry > two concurrent publishWithRetry calls both commit',
      '   → SQLITE_ERROR: no such table: events',
      '',
      ' FAIL  src/bus/__tests__/publisher.test.ts > publishWithRetry > ...',
      'LibsqlError: SQLITE_ERROR: no such table: events',
      ' ❯ mapSqliteError node_modules/.pnpm/@libsql+client@0.17.3/...',
      'Caused by: SqliteError: no such table: events',
    ].join('\n')
    expect(computeFailureSignature('verify:test', errorOutput)).toBe(
      'verify:test/test-libsql-no-such-table',
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

  it('test-libsql-no-such-table does not interfere with AssertionError classification', () => {
    // An AssertionError that happens to contain "no such table" text should still
    // classify as test-assertion-error (AssertionError rule comes first in the list).
    const assertionWithTableText = [
      'AssertionError: expected events table to have 2 rows but found no such table: events',
    ].join('\n')
    // test-assertion-error fires because AssertionError: appears in the body;
    // since test-assertion-error is listed before test-libsql-no-such-table in
    // errorClassRules, it takes priority.
    expect(classifyError(assertionWithTableText)).toBe('test-assertion-error')
  })

  it('computeFailureSignature produces verify:test/test-libsql-not-an-error for the real libsql comment-only SQL error shape', () => {
    // The actual error captured when runMigration (src/db/migrate.ts) splits a
    // SQL migration file on '--> statement-breakpoint' and passes the leading
    // comment block (which precedes the first breakpoint) to c.execute().
    // SQLite returns SQLITE_OK for a comment-only statement; @libsql/client maps
    // this to LibsqlError with code SQLITE_UNKNOWN_0 and message "not an error".
    // The distinguishing signal is buried in the body after the vitest preamble,
    // hence matchFull.
    const errorOutput = [
      ' FAIL  src/core/lib/__tests__/triaging-and-blocker-state.test.ts > Triaging status + Blocker state schema > initialises the tasks schema',
      'LibsqlError: SQLITE_UNKNOWN_0: not an error',
      ' ❯ mapSqliteError node_modules/@libsql/client/lib-esm/sqlite3.js:434:16',
      ' ❯ runMigration src/db/migrate.ts:280:13',
      'Caused by: SqliteError: not an error',
      "Serialized Error: { code: 'SQLITE_OK', rawCode: +0 }",
    ].join('\n')
    expect(computeFailureSignature('verify:test', errorOutput)).toBe(
      'verify:test/test-libsql-not-an-error',
    )
  })

  it('test-libsql-not-an-error does not interfere with AssertionError classification', () => {
    // An AssertionError that happens to contain "not an error" should still
    // classify as test-assertion-error (AssertionError rule comes first in list).
    const assertionWithNotAnError = [
      "AssertionError: expected 'not an error' to be null",
    ].join('\n')
    expect(classifyError(assertionWithNotAnError)).toBe('test-assertion-error')
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
      'verify:has-diff/worktree-missing',
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
})

describe('firstNonBlankLine', () => {
  it('returns the first non-blank trimmed line', () => {
    expect(firstNonBlankLine('\n   \n  hello\nworld')).toBe('hello')
  })

  it('returns empty string for all-blank input', () => {
    expect(firstNonBlankLine('   \n\n\t\n')).toBe('')
  })

  it('strips ANSI codes', () => {
    expect(firstNonBlankLine('\x1B[31mboom\x1B[0m')).toBe('boom')
  })
})
