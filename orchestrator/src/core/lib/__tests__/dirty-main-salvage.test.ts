import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkSecretPath,
  detectWipMarkerInTestDiff,
  scanDirtyFilesForGuards,
  scanDirtyTestsForWip,
} from '../dirty-main-salvage'

// ---------------------------------------------------------------------------
// Pure guard logic
// ---------------------------------------------------------------------------

describe('detectWipMarkerInTestDiff', () => {
  describe('TODO comment markers (acceptance criterion 1)', () => {
    it('returns a hit for a diff adding "// TODO:" in a __tests__ file', () => {
      const filePath = 'src/__tests__/foo.test.ts'
      const diff = [
        '--- a/src/__tests__/foo.test.ts',
        '+++ b/src/__tests__/foo.test.ts',
        '@@ -1,2 +1,3 @@',
        ' import { foo } from "../foo"',
        '+// TODO: implement the bar case',
        ' ',
      ].join('\n')
      const hit = detectWipMarkerInTestDiff(filePath, diff)
      expect(hit).not.toBeNull()
      expect(hit?.label).toBe('TODO comment')
      expect(hit?.filePath).toBe(filePath)
    })

    it('returns a hit for "// TODO:" in a tests/ directory file', () => {
      const filePath = 'tests/bar.test.ts'
      const diff = [
        '--- a/tests/bar.test.ts',
        '+++ b/tests/bar.test.ts',
        '@@ -1,2 +1,3 @@',
        ' describe("bar", () => {',
        '+  // TODO: add edge case for null input',
        ' })',
      ].join('\n')
      const hit = detectWipMarkerInTestDiff(filePath, diff)
      expect(hit).not.toBeNull()
      expect(hit?.label).toBe('TODO comment')
    })

    it('returns a hit for a __tests__-at-repo-root path', () => {
      const filePath = '__tests__/root.test.ts'
      const diff = [
        '--- a/__tests__/root.test.ts',
        '+++ b/__tests__/root.test.ts',
        '@@ -1 +1,2 @@',
        '+// TODO: fill in the implementation',
        ' ',
      ].join('\n')
      const hit = detectWipMarkerInTestDiff(filePath, diff)
      expect(hit).not.toBeNull()
      expect(hit?.label).toBe('TODO comment')
    })

    it('returns a hit for an inline "// TODO:" comment at the end of a line', () => {
      const filePath = '__tests__/inline.test.ts'
      const diff = '+  expect(result).toBe(42) // TODO: verify edge cases'
      const hit = detectWipMarkerInTestDiff(filePath, diff)
      expect(hit).not.toBeNull()
      expect(hit?.label).toBe('TODO comment')
    })

    it('returns a hit for "/* TODO" block comment style', () => {
      const filePath = '__tests__/block.test.ts'
      const diff = '+  /* TODO: complete this test */'
      const hit = detectWipMarkerInTestDiff(filePath, diff)
      expect(hit).not.toBeNull()
      expect(hit?.label).toBe('TODO comment')
    })
  })

  describe('skipped-test markers (acceptance criterion 2)', () => {
    it('returns a hit for it.skip in a __tests__ file', () => {
      const filePath = 'src/__tests__/suite.test.ts'
      const diff = [
        '+  it.skip("unfinished case", () => {',
        '+    // work in progress',
        '+  })',
      ].join('\n')
      const hit = detectWipMarkerInTestDiff(filePath, diff)
      expect(hit).not.toBeNull()
      expect(hit?.label).toContain('it.skip')
    })

    it('returns a hit for test.skip', () => {
      const filePath = 'tests/suite.test.ts'
      const diff = '+  test.skip("pending", async () => {})'
      const hit = detectWipMarkerInTestDiff(filePath, diff)
      expect(hit).not.toBeNull()
      expect(hit?.label).toContain('test.skip')
    })

    it('returns a hit for describe.skip', () => {
      const filePath = '__tests__/group.test.ts'
      const diff = '+describe.skip("WIP group", () => {})'
      const hit = detectWipMarkerInTestDiff(filePath, diff)
      expect(hit).not.toBeNull()
      expect(hit?.label).toContain('describe.skip')
    })

    it('returns a hit for xit (Jasmine/Jest style)', () => {
      const filePath = '__tests__/old.test.ts'
      const diff = "+  xit('old skip style', () => {})"
      const hit = detectWipMarkerInTestDiff(filePath, diff)
      expect(hit).not.toBeNull()
      expect(hit?.label).toContain('xit')
    })

    it('returns a hit for xdescribe', () => {
      const filePath = '__tests__/old.test.ts'
      const diff = "+xdescribe('WIP describe', () => {})"
      const hit = detectWipMarkerInTestDiff(filePath, diff)
      expect(hit).not.toBeNull()
      expect(hit?.label).toContain('xdescribe')
    })

    it('returns a hit for it.todo', () => {
      const filePath = '__tests__/todo.test.ts'
      const diff = "+  it.todo('implement this later')"
      const hit = detectWipMarkerInTestDiff(filePath, diff)
      expect(hit).not.toBeNull()
      expect(hit?.label).toContain('it.todo')
    })

    it('returns a hit for test.todo', () => {
      const filePath = '__tests__/todo.test.ts'
      const diff = "+  test.todo('also pending')"
      const hit = detectWipMarkerInTestDiff(filePath, diff)
      expect(hit).not.toBeNull()
      expect(hit?.label).toContain('test.todo')
    })
  })

  describe('guard is content-shaped, not path-shaped (acceptance criterion 4)', () => {
    it('returns null for a TODO comment in a non-test source file', () => {
      const filePath = 'src/foo.ts'
      const diff = '+// TODO: fix this later'
      const hit = detectWipMarkerInTestDiff(filePath, diff)
      expect(hit).toBeNull()
    })

    it('returns null for a test file diff with no WIP markers', () => {
      const filePath = '__tests__/clean.test.ts'
      const diff = [
        '--- a/__tests__/clean.test.ts',
        '+++ b/__tests__/clean.test.ts',
        '@@ -1,3 +1,6 @@',
        ' describe("clean", () => {',
        '+  it("new case", () => {',
        '+    expect(1 + 1).toBe(2)',
        '+  })',
        ' })',
      ].join('\n')
      const hit = detectWipMarkerInTestDiff(filePath, diff)
      expect(hit).toBeNull()
    })

    it('does not match diff header lines (+++ b/file)', () => {
      // The +++ prefix is the diff header for the new filename and must never
      // be confused with an added content line.
      const filePath = '__tests__/foo.test.ts'
      const diff = [
        '+++ b/__tests__/foo.test.ts',
        '+  it("real add", () => {})',
      ].join('\n')
      // The +++ header has no TODO / skip content so the real added line is clean.
      const hit = detectWipMarkerInTestDiff(filePath, diff)
      expect(hit).toBeNull()
    })

    it('matches only exact test-directory segments — testutils does not trip the guard', () => {
      // "testutils" is not "__tests__", "test", or "tests" so must be ignored.
      const filePath = 'src/testutils/helpers.ts'
      const diff = '+// TODO: add helper'
      const hit = detectWipMarkerInTestDiff(filePath, diff)
      expect(hit).toBeNull()
    })

    it('does not match removal of a WIP marker (lines starting with -)', () => {
      // Removing a TODO comment or .skip call is intentional cleanup — must
      // not block the salvage.
      const filePath = '__tests__/cleanup.test.ts'
      const diff = '-// TODO: this was cleaned up intentionally'
      const hit = detectWipMarkerInTestDiff(filePath, diff)
      expect(hit).toBeNull()
    })

    it('returns null when filePath is empty', () => {
      const hit = detectWipMarkerInTestDiff('', '+// TODO: something')
      expect(hit).toBeNull()
    })
  })
})

// ---------------------------------------------------------------------------
// Git integration — real worktree, real diffs
// ---------------------------------------------------------------------------

describe('scanDirtyTestsForWip (git integration)', () => {
  let dir: string

  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dirty-main-salvage-test-'))
    git('init', '-q')
    git('config', 'user.email', 'test@test.com')
    git('config', 'user.name', 'Test')
    // Create an initial commit so HEAD exists and diffs have a base.
    writeFileSync(join(dir, 'README.md'), 'hello\n')
    git('add', 'README.md')
    git('commit', '-m', 'initial', '--no-gpg-sign')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  // Acceptance criterion 1 — TODO marker blocks auto-commit
  it('returns blocked:true when a dirty __tests__ file adds a TODO marker', async () => {
    mkdirSync(join(dir, '__tests__'), { recursive: true })
    // Commit a clean version first so the file is tracked.
    writeFileSync(join(dir, '__tests__', 'foo.test.ts'), 'describe("foo", () => {})\n')
    git('add', '__tests__/foo.test.ts')
    git('commit', '-m', 'add test', '--no-gpg-sign')

    // Dirty the file with a TODO marker (not staged — working tree dirty).
    writeFileSync(
      join(dir, '__tests__', 'foo.test.ts'),
      ['describe("foo", () => {', '  // TODO: implement bar case', '})'].join('\n'),
    )

    const result = await scanDirtyTestsForWip(dir, [' M __tests__/foo.test.ts'])

    expect(result.blocked).toBe(true)
    if (result.blocked) {
      expect(result.hit.filePath).toBe('__tests__/foo.test.ts')
      expect(result.hit.label).toBe('TODO comment')
    }
  })

  // Acceptance criterion 2 — skip-test pattern blocks auto-commit
  it('returns blocked:true when a dirty tests/ file adds a skipped-test pattern', async () => {
    mkdirSync(join(dir, 'tests'), { recursive: true })
    writeFileSync(join(dir, 'tests', 'bar.test.ts'), 'describe("bar", () => {})\n')
    git('add', 'tests/bar.test.ts')
    git('commit', '-m', 'add test', '--no-gpg-sign')

    // Dirty with an it.skip (WIP-in-progress marker).
    writeFileSync(
      join(dir, 'tests', 'bar.test.ts'),
      ['describe("bar", () => {', '  it.skip("not yet", () => {})', '})'].join('\n'),
    )

    const result = await scanDirtyTestsForWip(dir, [' M tests/bar.test.ts'])

    expect(result.blocked).toBe(true)
    if (result.blocked) {
      expect(result.hit.filePath).toBe('tests/bar.test.ts')
      expect(result.hit.label).toContain('it.skip')
    }
  })

  // Acceptance criterion 3 — on guard trip the merge target stays unchanged
  //
  // "The original task ends up in today's terminal state (blocked + dirty-main
  // actionQueue item raised)" is enforced by the implement-workflow caller: when
  // scanDirtyTestsForWip returns { blocked: true }, the setup preflight skips
  // spawning the salvage chore and falls through to the existing
  // handleTaskFailureWithFixTask path, which parks the task as `blocked` and
  // raises a dirty-main actionQueue item — identical to today's manual dirty-main
  // resolution flow.
  //
  // What we can verify here is the guard's side-effect contract: the merge
  // target MUST NOT receive any new commits when the guard trips.
  it('leaves the merge target with no new commits when the guard trips (criterion 3)', async () => {
    mkdirSync(join(dir, '__tests__'), { recursive: true })
    writeFileSync(join(dir, '__tests__', 'wip.test.ts'), 'describe("wip", () => {})\n')
    git('add', '__tests__/wip.test.ts')
    git('commit', '-m', 'add test', '--no-gpg-sign')

    const headBefore = git('rev-parse', 'HEAD').trim()

    // Dirty the test file with a TODO marker.
    writeFileSync(
      join(dir, '__tests__', 'wip.test.ts'),
      ['describe("wip", () => {', '  // TODO: write real assertions', '})'].join('\n'),
    )

    const result = await scanDirtyTestsForWip(dir, [' M __tests__/wip.test.ts'])

    // Guard trips — blocked:true signals the caller to skip the chore.
    expect(result.blocked).toBe(true)

    // The guard itself never commits — it only DETECTS. HEAD is unchanged,
    // proving no auto-commit happened on the merge target.
    const headAfter = git('rev-parse', 'HEAD').trim()
    expect(headAfter).toBe(headBefore)
  })

  // Acceptance criterion 4 — clean test diff is still salvaged normally
  it('returns blocked:false when a dirty test file has no WIP markers', async () => {
    mkdirSync(join(dir, '__tests__'), { recursive: true })
    writeFileSync(
      join(dir, '__tests__', 'clean.test.ts'),
      'describe("clean", () => {})\n',
    )
    git('add', '__tests__/clean.test.ts')
    git('commit', '-m', 'add test', '--no-gpg-sign')

    // Legitimate change: add a new passing test — no WIP markers.
    writeFileSync(
      join(dir, '__tests__', 'clean.test.ts'),
      [
        'describe("clean", () => {',
        '  it("passes", () => {',
        '    expect(1 + 1).toBe(2)',
        '  })',
        '})',
      ].join('\n'),
    )

    const result = await scanDirtyTestsForWip(dir, [' M __tests__/clean.test.ts'])

    expect(result.blocked).toBe(false)
  })

  it('returns blocked:false when only non-test files are dirty', async () => {
    writeFileSync(join(dir, 'src.ts'), '// initial\n')
    git('add', 'src.ts')
    git('commit', '-m', 'add src', '--no-gpg-sign')

    // Dirty the non-test file with a TODO — should NOT trip the guard.
    writeFileSync(join(dir, 'src.ts'), '// TODO: fix this\nconst x = 1\n')

    const result = await scanDirtyTestsForWip(dir, [' M src.ts'])

    expect(result.blocked).toBe(false)
  })

  it('returns blocked:false when dirtyLines is empty', async () => {
    const result = await scanDirtyTestsForWip(dir, [])
    expect(result.blocked).toBe(false)
  })

  it('blocks on the first WIP-marked test file even when multiple dirty files exist', async () => {
    mkdirSync(join(dir, '__tests__'), { recursive: true })

    // Two test files: one clean, one with a TODO.
    writeFileSync(join(dir, '__tests__', 'a.test.ts'), 'describe("a", () => {})\n')
    writeFileSync(join(dir, '__tests__', 'b.test.ts'), 'describe("b", () => {})\n')
    git('add', '__tests__/a.test.ts', '__tests__/b.test.ts')
    git('commit', '-m', 'add tests', '--no-gpg-sign')

    // Dirty both: a gets a real change, b gets a TODO.
    writeFileSync(
      join(dir, '__tests__', 'a.test.ts'),
      'describe("a", () => { it("works", () => {}) })',
    )
    writeFileSync(
      join(dir, '__tests__', 'b.test.ts'),
      ['describe("b", () => {', '  // TODO: add assertions', '})'].join('\n'),
    )

    const result = await scanDirtyTestsForWip(dir, [
      ' M __tests__/a.test.ts',
      ' M __tests__/b.test.ts',
    ])

    expect(result.blocked).toBe(true)
    if (result.blocked) {
      // b.test.ts carries the WIP marker.
      expect(result.hit.filePath).toBe('__tests__/b.test.ts')
    }
  })

  it('handles a newly staged test file (A status) that adds a TODO', async () => {
    mkdirSync(join(dir, '__tests__'), { recursive: true })

    // A brand-new test file added to the index (staged but not committed).
    writeFileSync(
      join(dir, '__tests__', 'brand-new.test.ts'),
      ['describe("new", () => {', '  // TODO: write tests', '})'].join('\n'),
    )
    git('add', '__tests__/brand-new.test.ts')

    // Status line for a newly staged file is 'A  path'.
    const result = await scanDirtyTestsForWip(dir, ['A  __tests__/brand-new.test.ts'])

    expect(result.blocked).toBe(true)
    if (result.blocked) {
      expect(result.hit.label).toBe('TODO comment')
    }
  })
})

// ---------------------------------------------------------------------------
// Secret-path guard — pure
// ---------------------------------------------------------------------------

describe('checkSecretPath', () => {
  describe('paths outside the guard', () => {
    it('allows root and nested dotenv paths', () => {
      expect(checkSecretPath('.env')).toBeNull()
      expect(checkSecretPath('apps/api/.env.local')).toBeNull()
    })

    it('returns null for dotenv.config.js', () => {
      expect(checkSecretPath('dotenv.config.js')).toBeNull()
    })

    it('returns null for .environment', () => {
      expect(checkSecretPath('.environment')).toBeNull()
    })

    it('returns null for src/env.ts', () => {
      expect(checkSecretPath('src/env.ts')).toBeNull()
    })
  })

  describe('per-repo state directory detection', () => {
    it('returns a hit for a file directly inside .mars/', () => {
      const hit = checkSecretPath('.mars/queue.db')
      expect(hit).not.toBeNull()
      expect(hit?.filePath).toBe('.mars/queue.db')
      expect(hit?.reason).toBe('per-repo state directory')
    })

    it('returns a hit for a deeply nested .mars/ path', () => {
      const hit = checkSecretPath('.mars/worktrees/abc123/some-file.ts')
      expect(hit).not.toBeNull()
      expect(hit?.reason).toBe('per-repo state directory')
    })

    it('returns a hit for .mars itself (no trailing slash)', () => {
      const hit = checkSecretPath('.mars')
      expect(hit).not.toBeNull()
      expect(hit?.reason).toBe('per-repo state directory')
    })

    it('returns null for a path that merely contains ".mars" in a segment name', () => {
      // e.g. src/smart-mars/foo.ts should NOT be caught
      expect(checkSecretPath('src/smart-mars/foo.ts')).toBeNull()
    })

    it('returns null for ordinary source files', () => {
      expect(checkSecretPath('src/config.ts')).toBeNull()
      expect(checkSecretPath('orchestrator/lib/git.ts')).toBeNull()
    })

    it('returns null for an empty path', () => {
      expect(checkSecretPath('')).toBeNull()
    })
  })
})

// ---------------------------------------------------------------------------
// Combined guard — git integration
// ---------------------------------------------------------------------------

describe('scanDirtyFilesForGuards (git integration)', () => {
  let dir: string

  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dirty-main-salvage-guard-test-'))
    git('init', '-q')
    git('config', 'user.email', 'test@test.com')
    git('config', 'user.name', 'Test')
    writeFileSync(join(dir, 'README.md'), 'hello\n')
    git('add', 'README.md')
    git('commit', '-m', 'initial', '--no-gpg-sign')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns blocked:false when a dirty path is a tracked dotenv file', async () => {
    // A tracked dotenv file is eligible for the same auto-commit path as any
    // other ordinary file.
    writeFileSync(join(dir, '.env'), 'SECRET=initial\n')
    git('add', '.env')
    git('commit', '-m', 'add env', '--no-gpg-sign')
    writeFileSync(join(dir, '.env'), 'SECRET=changed\n')

    const result = await scanDirtyFilesForGuards(dir, [' M .env'])

    expect(result).toEqual({ blocked: false })
  })

  // Acceptance criterion 2 — .mars/ path blocks auto-commit
  it('returns blocked:true with kind:"secret-path" when a dirty path is under .mars/', async () => {
    // Track a .mars/ file (no .gitignore in the temp repo, so it CAN be tracked).
    mkdirSync(join(dir, '.mars'), { recursive: true })
    writeFileSync(join(dir, '.mars', 'state.db'), 'db-v1\n')
    git('add', '.mars/state.db')
    git('commit', '-m', 'add state', '--no-gpg-sign')
    writeFileSync(join(dir, '.mars', 'state.db'), 'db-v2\n')

    const result = await scanDirtyFilesForGuards(dir, [' M .mars/state.db'])

    expect(result.blocked).toBe(true)
    if (result.blocked && result.kind === 'secret-path') {
      expect(result.hit.filePath).toBe('.mars/state.db')
      expect(result.hit.reason).toBe('per-repo state directory')
    }
  })

  // Acceptance criterion 3 — guard trip leaves the merge target unchanged
  // (no new commits on HEAD)
  it('leaves HEAD unchanged when the secret-path guard trips on a .mars file', async () => {
    mkdirSync(join(dir, '.mars'), { recursive: true })
    writeFileSync(join(dir, '.mars', 'state.db'), 'state=v1\n')
    git('add', '.mars/state.db')
    git('commit', '-m', 'add state', '--no-gpg-sign')

    const headBefore = git('rev-parse', 'HEAD').trim()

    writeFileSync(join(dir, '.mars', 'state.db'), 'state=v2\n')

    const result = await scanDirtyFilesForGuards(dir, [' M .mars/state.db'])

    // Guard trips — caller must not commit.
    expect(result.blocked).toBe(true)

    // The guard never commits: HEAD must be unchanged, proving no auto-commit
    // occurred on the merge target.
    const headAfter = git('rev-parse', 'HEAD').trim()
    expect(headAfter).toBe(headBefore)
  })

  // Acceptance criterion 4 — all-or-nothing: other tracked changes in the same
  // dirty tree are not partially committed when a guarded path is present.
  it('blocks all commits even when only one path in a mixed dirty tree is guarded', async () => {
    // Two tracked files: a clean source file and a .mars state file.
    writeFileSync(join(dir, 'src.ts'), 'const x = 1\n')
    mkdirSync(join(dir, '.mars'), { recursive: true })
    writeFileSync(join(dir, '.mars', 'state.db'), 'state=original\n')
    git('add', 'src.ts', '.mars/state.db')
    git('commit', '-m', 'add files', '--no-gpg-sign')

    const headBefore = git('rev-parse', 'HEAD').trim()

    // Both files are dirty.
    writeFileSync(join(dir, 'src.ts'), 'const x = 2\n')
    writeFileSync(join(dir, '.mars', 'state.db'), 'state=changed\n')

    // Caller would pass all dirty lines; the guard must block the entire commit.
    const result = await scanDirtyFilesForGuards(dir, [
      ' M src.ts',
      ' M .mars/state.db',
    ])

    expect(result.blocked).toBe(true)
    if (result.blocked) {
      // The guard returns secret-path (not wip) because secret paths are
      // checked first and the chore must commit nothing.
      expect(result.kind).toBe('secret-path')
    }

    // HEAD must be unchanged — no partial commit of src.ts.
    const headAfter = git('rev-parse', 'HEAD').trim()
    expect(headAfter).toBe(headBefore)
  })

  it('returns blocked:false when only clean non-secret files are dirty', async () => {
    writeFileSync(join(dir, 'src.ts'), 'const x = 1\n')
    git('add', 'src.ts')
    git('commit', '-m', 'add src', '--no-gpg-sign')

    writeFileSync(join(dir, 'src.ts'), 'const x = 2\n')

    const result = await scanDirtyFilesForGuards(dir, [' M src.ts'])

    expect(result.blocked).toBe(false)
  })

  it('still catches WIP markers in test files when no secret paths are present', async () => {
    mkdirSync(join(dir, '__tests__'), { recursive: true })
    writeFileSync(join(dir, '__tests__', 'foo.test.ts'), 'describe("foo", () => {})\n')
    git('add', '__tests__/foo.test.ts')
    git('commit', '-m', 'add test', '--no-gpg-sign')

    writeFileSync(
      join(dir, '__tests__', 'foo.test.ts'),
      ['describe("foo", () => {', '  // TODO: write assertions', '})'].join('\n'),
    )

    const result = await scanDirtyFilesForGuards(dir, [' M __tests__/foo.test.ts'])

    expect(result.blocked).toBe(true)
    if (result.blocked) {
      expect(result.kind).toBe('wip')
    }
  })
})
