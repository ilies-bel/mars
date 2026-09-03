/**
 * Unit tests for `parseArgs` greedy-consumption of REPEATABLE_FLAGS.
 *
 * Before the fix, `--files a b c` would capture only `a` into
 * `multiFlags['--files']` and push `b` and `c` into `positional`, which then
 * collided with other prompt sources and produced a misleading
 * "multiple prompt sources supplied" error. After the fix, ALL space-separated
 * non-flag tokens following a REPEATABLE_FLAG are greedily consumed.
 */

import { describe, it, expect } from 'vitest'
import { checkNpmScriptExists, containsAbsoluteRepoPath, hasFlag, isFullSuiteVerifyCmd, isNoOpVerifyCmd, parseArgs } from '../args'

describe('boolean flags', () => {
  it('reports a supplied boolean flag even though it is not positional', () => {
    const args = parseArgs(['--lean'])

    expect(hasFlag(args, '--lean')).toBe(true)
    expect(args.positional).toEqual([])
  })

  it('normalizes the -y alias to --yes', () => {
    expect(hasFlag(parseArgs(['-y']), '--yes')).toBe(true)
  })

  it('parses --verify-gates-json as a value-bearing init override', () => {
    const value = '[{"scope":".","name":"test","cmd":"npm","args":["test"],"required":true,"tier":"task"}]'

    expect(parseArgs(['--verify-gates-json', value]).flags['--verify-gates-json']).toBe(value)
  })
})

describe('parseArgs — REPEATABLE_FLAGS greedy consumption', () => {
  it('--files a b c captures all three paths and leaves positional empty', () => {
    const result = parseArgs(['--files', 'a', 'b', 'c'])
    expect(result.multiFlags['--files']).toEqual(['a', 'b', 'c'])
    expect(result.positional).toEqual([])
  })

  it('--files a --files b still yields [a, b] (repeated-flag form)', () => {
    const result = parseArgs(['--files', 'a', '--files', 'b'])
    expect(result.multiFlags['--files']).toEqual(['a', 'b'])
    expect(result.positional).toEqual([])
  })

  it('a following --flag stops greedy consumption', () => {
    const result = parseArgs(['--files', 'a', 'b', '--verify', 'cmd'])
    expect(result.multiFlags['--files']).toEqual(['a', 'b'])
    expect(result.flags['--verify']).toBe('cmd')
    expect(result.positional).toEqual([])
  })

  it('a lone - (stdin sentinel) stops greedy consumption', () => {
    const result = parseArgs(['--files', 'a', 'b', '-'])
    expect(result.multiFlags['--files']).toEqual(['a', 'b'])
    expect(result.positional).toEqual(['-'])
  })

  it('inline prompt before flags does not bleed into greedy consumption', () => {
    const result = parseArgs(['do X', '--files', 'a', 'b'])
    expect(result.multiFlags['--files']).toEqual(['a', 'b'])
    expect(result.positional).toEqual(['do X'])
  })

  it('--files=a (inline form) binds exactly one value; trailing tokens are positional', () => {
    const result = parseArgs(['--files=a', 'b'])
    expect(result.multiFlags['--files']).toEqual(['a'])
    expect(result.positional).toEqual(['b'])
  })

  it('--done a b c captures all done-criteria', () => {
    const result = parseArgs(['--done', 'criterion one', 'criterion two', 'criterion three'])
    expect(result.multiFlags['--done']).toEqual(['criterion one', 'criterion two', 'criterion three'])
    expect(result.positional).toEqual([])
  })

  it('--blocked-by id1 id2 captures both ids', () => {
    const result = parseArgs(['--blocked-by', 'id1', 'id2'])
    expect(result.multiFlags['--blocked-by']).toEqual(['id1', 'id2'])
    expect(result.positional).toEqual([])
  })

  it('--tag a b c captures all tags', () => {
    const result = parseArgs(['--tag', 'a', 'b', 'c'])
    expect(result.multiFlags['--tag']).toEqual(['a', 'b', 'c'])
    expect(result.positional).toEqual([])
  })

  it('interleaved flags and greedy repeatable flags both parse correctly', () => {
    const result = parseArgs(['--priority', '2', '--files', 'x', 'y', '--verify', 'npm test'])
    expect(result.flags['--priority']).toBe('2')
    expect(result.multiFlags['--files']).toEqual(['x', 'y'])
    expect(result.flags['--verify']).toBe('npm test')
    expect(result.positional).toEqual([])
  })

  it('single value for a repeatable flag still works', () => {
    const result = parseArgs(['--files', 'only-one.ts'])
    expect(result.multiFlags['--files']).toEqual(['only-one.ts'])
    expect(result.positional).toEqual([])
  })

  it('two greedy repeatable flags in sequence each consume their own non-flag tokens', () => {
    // --files a b --blocked-by id1 id2: `--blocked-by` starts with `-` so it
    // terminates --files greedy consumption; then --blocked-by's own greedy
    // loop picks up id1 and id2.
    const result = parseArgs(['--files', 'a', 'b', '--blocked-by', 'id1', 'id2'])
    expect(result.multiFlags['--files']).toEqual(['a', 'b'])
    expect(result.multiFlags['--blocked-by']).toEqual(['id1', 'id2'])
    expect(result.positional).toEqual([])
  })
})

describe('parseArgs — bare -- separator', () => {
  it('empty input produces empty rest', () => {
    const result = parseArgs([])
    expect(result.rest).toEqual([])
  })

  it('no -- separator produces empty rest', () => {
    const result = parseArgs(['verify', 'add', 'typecheck', '--cmd', 'npx'])
    expect(result.rest).toEqual([])
    expect(result.positional).toEqual(['verify', 'add', 'typecheck'])
  })

  it('-- puts everything after it into rest, not positional or flags', () => {
    const result = parseArgs(['--cmd', 'npx', '--', 'tsc', '--noEmit'])
    expect(result.flags['--cmd']).toBe('npx')
    expect(result.rest).toEqual(['tsc', '--noEmit'])
    expect(result.positional).toEqual([])
  })

  it('-- with flag-like tokens after it are verbatim in rest, not parsed as flags', () => {
    const result = parseArgs(['--cmd', 'npx', '--', '--noEmit', '--strict'])
    expect(result.rest).toEqual(['--noEmit', '--strict'])
    expect(result.flags['--noEmit']).toBeUndefined()
  })

  it('positional before -- and rest after -- are both captured', () => {
    const result = parseArgs(['typecheck', '--cmd', 'npx', '--', 'tsc', '--noEmit'])
    expect(result.positional).toEqual(['typecheck'])
    expect(result.flags['--cmd']).toBe('npx')
    expect(result.rest).toEqual(['tsc', '--noEmit'])
  })

  it('bare -- with nothing after it produces empty rest', () => {
    const result = parseArgs(['--cmd', 'npx', '--'])
    expect(result.rest).toEqual([])
    expect(result.flags['--cmd']).toBe('npx')
  })

  it('-- stops greedy consumption of REPEATABLE_FLAGS', () => {
    // --args tsc stops at --, not continuing to consume --noEmit
    const result = parseArgs(['--args', 'tsc', '--', '--noEmit'])
    expect(result.multiFlags['--args']).toEqual(['tsc'])
    expect(result.rest).toEqual(['--noEmit'])
  })
})

// ---------------------------------------------------------------------------
// containsAbsoluteRepoPath
// ---------------------------------------------------------------------------

describe('containsAbsoluteRepoPath', () => {
  it('returns true when verifyCmd contains the repo root as a literal substring', () => {
    expect(
      containsAbsoluteRepoPath(
        '(cd /home/user/my-project/orchestrator && npm test)',
        '/home/user/my-project',
      ),
    ).toBe(true)
  })

  it('returns true for a partial-subdir path that still starts with repoRoot', () => {
    expect(
      containsAbsoluteRepoPath(
        'cd /home/user/my-project/ui && npm run build',
        '/home/user/my-project',
      ),
    ).toBe(true)
  })

  it('returns false when verifyCmd uses only relative paths', () => {
    expect(
      containsAbsoluteRepoPath(
        'cd orchestrator && npm test',
        '/home/user/my-project',
      ),
    ).toBe(false)
  })

  it('returns false when repoRoot is an empty string', () => {
    expect(containsAbsoluteRepoPath('cd /abs/path && npm test', '')).toBe(false)
  })

  it('returns false when an absolute path in verifyCmd does NOT start with repoRoot', () => {
    // An absolute path to a different location should not trigger the guard.
    expect(
      containsAbsoluteRepoPath(
        'cd /tmp/scratch && npm test',
        '/home/user/my-project',
      ),
    ).toBe(false)
  })

  it('returns false when verifyCmd is empty', () => {
    expect(containsAbsoluteRepoPath('', '/home/user/my-project')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isFullSuiteVerifyCmd
// ---------------------------------------------------------------------------

describe('isFullSuiteVerifyCmd', () => {
  it('returns true for bare npm test', () => {
    expect(isFullSuiteVerifyCmd('npm test')).toBe(true)
  })

  it('returns true for bare npm run test', () => {
    expect(isFullSuiteVerifyCmd('npm run test')).toBe(true)
  })

  it('returns true for npm test chained after a cd', () => {
    expect(isFullSuiteVerifyCmd('cd orchestrator && npm test')).toBe(true)
  })

  it('returns true for a bare vitest run with no file arguments', () => {
    expect(isFullSuiteVerifyCmd('cd orchestrator && npx vitest run')).toBe(true)
  })

  it('returns true for a bare vitest run with only flags (no file target)', () => {
    expect(isFullSuiteVerifyCmd('npx vitest run --reporter=json')).toBe(true)
  })

  it('returns false for npm run test:unit (scoped script suffix)', () => {
    expect(isFullSuiteVerifyCmd('cd orchestrator && npm run test:unit')).toBe(false)
  })

  it('returns false for a scoped vitest run with a file argument', () => {
    expect(
      isFullSuiteVerifyCmd('cd orchestrator && npx vitest run src/path/to/your.test.ts'),
    ).toBe(false)
  })

  it('returns false for typecheck-only commands', () => {
    expect(isFullSuiteVerifyCmd('cd orchestrator && npm run typecheck')).toBe(false)
  })

  it('returns false for an empty verifyCmd', () => {
    expect(isFullSuiteVerifyCmd('')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// checkNpmScriptExists — pure npm-script validation (no filesystem I/O)
// ---------------------------------------------------------------------------

describe('checkNpmScriptExists', () => {
  // Simulates a mono-repo where the root has `arch` and `build`, and
  // `orchestrator/` has `typecheck` and `knip` (with --no-exit-code).
  const scripts = new Map<string, Record<string, string>>([
    ['.', { arch: 'echo arch', build: 'tsc', test: 'vitest run' }],
    [
      'orchestrator',
      {
        typecheck: 'tsc --noEmit',
        knip: 'knip --no-exit-code',
        lint: 'eslint . || true',
        clean: 'rm -rf dist; exit 0',
      },
    ],
  ])

  it('returns null for a valid scoped command', () => {
    expect(
      checkNpmScriptExists('cd orchestrator && npm run typecheck', scripts),
    ).toBeNull()
  })

  it('returns null when cmd has no npm run segments', () => {
    expect(
      checkNpmScriptExists('npx tsc --noEmit', scripts),
    ).toBeNull()
  })

  it('returns null when verifyCmd is empty', () => {
    expect(checkNpmScriptExists('', scripts)).toBeNull()
  })

  it('returns null when the directory has no package.json entry in the map', () => {
    // No package.json loaded for `packages/` — should skip silently, not error.
    expect(
      checkNpmScriptExists('cd packages && npm run build', scripts),
    ).toBeNull()
  })

  it('returns an error naming the missing script and the searched directory', () => {
    // `arch` exists in the root `.` but the command cd's into `orchestrator/`
    const result = checkNpmScriptExists(
      'cd orchestrator && npm run arch',
      scripts,
    )
    expect(result).not.toBeNull()
    expect(result).toContain("'arch'")
    expect(result).toContain('orchestrator/')  // directory searched
  })

  it('tells the caller where the script actually lives when found elsewhere', () => {
    // `arch` is in the root package.json — the error should point there.
    const result = checkNpmScriptExists(
      'cd orchestrator && npm run arch',
      scripts,
    )
    expect(result).not.toBeNull()
    expect(result).toContain('the repo root')  // where it was found
  })

  it('returns an error when the script does not exist anywhere in the repo', () => {
    const result = checkNpmScriptExists(
      'cd orchestrator && npm run nonexistent',
      scripts,
    )
    expect(result).not.toBeNull()
    expect(result).toContain("'nonexistent'")
    expect(result).toContain('not found in any other package.json')
  })

  it('returns an error when the script body contains --no-exit-code', () => {
    const result = checkNpmScriptExists(
      'cd orchestrator && npm run knip',
      scripts,
    )
    expect(result).not.toBeNull()
    expect(result).toContain('--no-exit-code')
    expect(result).toContain('unconditionally-passing')
  })

  it('returns an error when the script body contains || true', () => {
    const result = checkNpmScriptExists(
      'cd orchestrator && npm run lint',
      scripts,
    )
    expect(result).not.toBeNull()
    expect(result).toContain('unconditionally-passing')
  })

  it('returns an error when the script body contains ; exit 0', () => {
    const result = checkNpmScriptExists(
      'cd orchestrator && npm run clean',
      scripts,
    )
    expect(result).not.toBeNull()
    expect(result).toContain('unconditionally-passing')
  })

  it('handles npm test (bare) resolving to the test script', () => {
    // `npm test` with no extra args maps to the `test` script in scope.
    expect(checkNpmScriptExists('npm test', scripts)).toBeNull()
  })

  it('handles chained commands where cd sets context for subsequent npm run', () => {
    // `cd orchestrator` then `npm run typecheck` — both in the same chain.
    expect(
      checkNpmScriptExists(
        'cd orchestrator && npm run typecheck && npx tsc --noEmit',
        scripts,
      ),
    ).toBeNull()
  })

  it('catches an error in the second segment of a chain', () => {
    // First command is valid; second names a missing script.
    const result = checkNpmScriptExists(
      'cd orchestrator && npm run typecheck && npm run arch',
      scripts,
    )
    expect(result).not.toBeNull()
    expect(result).toContain("'arch'")
  })

  it('returns null when the command is from the root and the script exists there', () => {
    expect(checkNpmScriptExists('npm run build', scripts)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// isNoOpVerifyCmd — structural no-op gate detection
// ---------------------------------------------------------------------------

describe('isNoOpVerifyCmd', () => {
  it('returns null for a legitimate scoped vitest command', () => {
    expect(
      isNoOpVerifyCmd('cd orchestrator && npx vitest run src/foo.test.ts'),
    ).toBeNull()
  })

  it('returns null for an empty string (absent gate is a valid choice)', () => {
    expect(isNoOpVerifyCmd('')).toBeNull()
  })

  // Pattern 1 — whitespace-only
  it('returns a non-null error for whitespace-only input', () => {
    const result = isNoOpVerifyCmd('   ')
    expect(result).not.toBeNull()
    expect(result).toContain('[mars] --verify')
  })

  // Pattern 2 — --no-exit-code in terminal segment
  it('returns a non-null error when --no-exit-code is in the terminal segment', () => {
    const result = isNoOpVerifyCmd('knip --no-exit-code')
    expect(result).not.toBeNull()
    expect(result).toContain('[mars] --verify')
    expect(result).toContain('--no-exit-code')
  })

  it('returns null when --no-exit-code is in a non-terminal segment (tsc still gates)', () => {
    expect(isNoOpVerifyCmd('knip --no-exit-code && tsc --noEmit')).toBeNull()
  })

  it('returns a non-null error when --no-exit-code is the last ;-separated segment', () => {
    const result = isNoOpVerifyCmd('tsc --noEmit; knip --no-exit-code')
    expect(result).not.toBeNull()
    expect(result).toContain('--no-exit-code')
  })

  // Pattern 3 — terminal || true / ; true
  it('returns a non-null error for a command ending in || true', () => {
    const result = isNoOpVerifyCmd('npm run lint || true')
    expect(result).not.toBeNull()
    expect(result).toContain('[mars] --verify')
  })

  it('returns a non-null error for a command ending in ; true', () => {
    const result = isNoOpVerifyCmd('npm run lint; true')
    expect(result).not.toBeNull()
    expect(result).toContain('[mars] --verify')
  })

  // Pattern 4 — terminal ; exit 0 / || exit 0
  it('returns a non-null error for a command ending in ; exit 0', () => {
    const result = isNoOpVerifyCmd('npm run lint; exit 0')
    expect(result).not.toBeNull()
    expect(result).toContain('[mars] --verify')
  })

  it('returns a non-null error for a command ending in || exit 0', () => {
    const result = isNoOpVerifyCmd('npm run lint || exit 0')
    expect(result).not.toBeNull()
    expect(result).toContain('[mars] --verify')
  })

  // Pattern 5 — last pipe stage is grep/tail/head
  it('returns a non-null error when the last pipeline stage is grep', () => {
    const result = isNoOpVerifyCmd('npx vitest run src/foo.test.ts | grep PASS')
    expect(result).not.toBeNull()
    expect(result).toContain('[mars] --verify')
    expect(result).toContain('grep')
  })

  it('returns a non-null error when the last pipeline stage is tail', () => {
    const result = isNoOpVerifyCmd('npx vitest run src/foo.test.ts | tail -10')
    expect(result).not.toBeNull()
    expect(result).toContain('tail')
  })

  it('returns a non-null error when the last pipeline stage is head', () => {
    const result = isNoOpVerifyCmd('npx vitest run src/foo.test.ts | head -5')
    expect(result).not.toBeNull()
    expect(result).toContain('head')
  })

  it('returns null when grep/tail/head appear in a non-terminal compound segment', () => {
    // grep is in the first compound segment; tsc gates the final result
    expect(isNoOpVerifyCmd('cmd | grep foo && npx tsc --noEmit')).toBeNull()
  })

  // Error message format
  it('error messages include actionable guidance', () => {
    const cases = [
      isNoOpVerifyCmd('   '),
      isNoOpVerifyCmd('knip --no-exit-code'),
      isNoOpVerifyCmd('cmd || true'),
      isNoOpVerifyCmd('cmd; exit 0'),
      isNoOpVerifyCmd('cmd | grep PASS'),
    ]
    for (const msg of cases) {
      expect(msg).not.toBeNull()
      expect(msg).toContain('[mars] --verify')
    }
  })
})
