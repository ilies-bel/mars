/**
 * Tests for classifyIntegrationDirtState and isCommitterUnresolvable.
 *
 * Each test seeds a real temporary git repo (same approach as main-dirty.test.ts)
 * and asserts observable behaviour through the exported public API. Fixture
 * repos cover all three classification arms and all contamination categories.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { nullTraceStore } from '../run-tool'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-classify-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  writeFileSync(resolve(repo, 'README.md'), 'hi\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'init', '--allow-empty'], { cwd: repo })
  return repo
}

const traceCtx = { store: nullTraceStore, phase: 'setup' as const }

// ---------------------------------------------------------------------------
// isCommitterUnresolvable — unit tests (stateless helper)
// ---------------------------------------------------------------------------

describe('isCommitterUnresolvable', () => {
  it('returns false for an ordinary modified-file line', async () => {
    const { isCommitterUnresolvable } = await import('../main-dirty')
    expect(isCommitterUnresolvable(' M README.md')).toBe(false)
  })

  it('returns false for an untracked file line (??)', async () => {
    const { isCommitterUnresolvable } = await import('../main-dirty')
    expect(isCommitterUnresolvable('?? new-file.ts')).toBe(false)
  })

  it('returns true for an ignored entry (XY === !!)', async () => {
    const { isCommitterUnresolvable } = await import('../main-dirty')
    expect(isCommitterUnresolvable('!! node_modules/')).toBe(true)
  })

  it('returns true when XY starts with U (UU — both modified conflict)', async () => {
    const { isCommitterUnresolvable } = await import('../main-dirty')
    expect(isCommitterUnresolvable('UU conflict.txt')).toBe(true)
  })

  it('returns true when XY starts with U (UA — added by them)', async () => {
    const { isCommitterUnresolvable } = await import('../main-dirty')
    expect(isCommitterUnresolvable('UA conflict.txt')).toBe(true)
  })

  it('returns true when XY[1] is U (DU — deleted by us)', async () => {
    const { isCommitterUnresolvable } = await import('../main-dirty')
    expect(isCommitterUnresolvable('DU conflict.txt')).toBe(true)
  })

  it('returns true when XY[1] is U (AU — added by us, unmerged on worktree)', async () => {
    const { isCommitterUnresolvable } = await import('../main-dirty')
    expect(isCommitterUnresolvable('AU conflict.txt')).toBe(true)
  })

  it('returns false for a staged-only addition (A )', async () => {
    const { isCommitterUnresolvable } = await import('../main-dirty')
    expect(isCommitterUnresolvable('A  staged.ts')).toBe(false)
  })

  it('returns false for empty string', async () => {
    const { isCommitterUnresolvable } = await import('../main-dirty')
    expect(isCommitterUnresolvable('')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// classifyIntegrationDirtState — fixture-based git repo tests
// ---------------------------------------------------------------------------

describe('classifyIntegrationDirtState — clean arm', () => {
  let repo: string

  beforeEach(() => { repo = setupRepo() })
  afterEach(() => { rmSync(repo, { recursive: true, force: true }) })

  it('returns clean on a fresh repo with no dirty files', async () => {
    const { classifyIntegrationDirtState } = await import('../main-dirty')
    const result = await classifyIntegrationDirtState({
      repoRoot: repo,
      integrationBranch: 'main',
      traceCtx,
    })
    expect(result.kind).toBe('clean')
  }, 15000)
})

describe('classifyIntegrationDirtState — committer-scope arm', () => {
  let repo: string

  beforeEach(() => { repo = setupRepo() })
  afterEach(() => { rmSync(repo, { recursive: true, force: true }) })

  it('returns committer-scope for a modified tracked file', async () => {
    const { classifyIntegrationDirtState } = await import('../main-dirty')
    writeFileSync(resolve(repo, 'README.md'), 'modified\n')
    const result = await classifyIntegrationDirtState({
      repoRoot: repo,
      integrationBranch: 'main',
      traceCtx,
    })
    expect(result.kind).toBe('committer-scope')
    if (result.kind === 'committer-scope') {
      expect(result.statusOutput).toContain('README.md')
    }
  })

  it('returns committer-scope for an untracked new file', async () => {
    const { classifyIntegrationDirtState } = await import('../main-dirty')
    writeFileSync(resolve(repo, 'new-feature.ts'), 'export const x = 1\n')
    const result = await classifyIntegrationDirtState({
      repoRoot: repo,
      integrationBranch: 'main',
      traceCtx,
    })
    expect(result.kind).toBe('committer-scope')
    if (result.kind === 'committer-scope') {
      expect(result.statusOutput).toContain('new-feature.ts')
    }
  })

  it('returns committer-scope for a staged (indexed) file', async () => {
    const { classifyIntegrationDirtState } = await import('../main-dirty')
    writeFileSync(resolve(repo, 'staged.ts'), 'staged\n')
    execFileSync('git', ['add', 'staged.ts'], { cwd: repo })
    const result = await classifyIntegrationDirtState({
      repoRoot: repo,
      integrationBranch: 'main',
      traceCtx,
    })
    expect(result.kind).toBe('committer-scope')
    if (result.kind === 'committer-scope') {
      expect(result.statusOutput).toContain('staged.ts')
    }
  })
})

describe('classifyIntegrationDirtState — unrelated arm: ignored entries', () => {
  let repo: string

  beforeEach(() => { repo = setupRepo() })
  afterEach(() => { rmSync(repo, { recursive: true, force: true }) })

  it('returns unrelated when an ignored file is present', async () => {
    const { classifyIntegrationDirtState } = await import('../main-dirty')
    // Add a .gitignore entry, then create the ignored file.
    writeFileSync(resolve(repo, '.gitignore'), 'secret.env\n')
    execFileSync('git', ['add', '.gitignore'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'add gitignore'], { cwd: repo })
    writeFileSync(resolve(repo, 'secret.env'), 'API_KEY=secret\n')

    const result = await classifyIntegrationDirtState({
      repoRoot: repo,
      integrationBranch: 'main',
      traceCtx,
    })
    expect(result.kind).toBe('unrelated')
    if (result.kind === 'unrelated') {
      expect(result.contaminatedPaths.some((p) => p.includes('secret.env'))).toBe(true)
    }
  })

  it('returns unrelated when an ignored directory is present', async () => {
    const { classifyIntegrationDirtState } = await import('../main-dirty')
    writeFileSync(resolve(repo, '.gitignore'), 'node_modules/\n')
    execFileSync('git', ['add', '.gitignore'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'add gitignore'], { cwd: repo })
    // Create an ignored directory with a file inside.
    execFileSync('mkdir', ['-p', resolve(repo, 'node_modules/some-pkg')])
    writeFileSync(resolve(repo, 'node_modules/some-pkg/index.js'), 'module.exports = {}\n')

    const result = await classifyIntegrationDirtState({
      repoRoot: repo,
      integrationBranch: 'main',
      traceCtx,
    })
    expect(result.kind).toBe('unrelated')
    if (result.kind === 'unrelated') {
      // The contaminated path should reference node_modules in some form.
      expect(result.contaminatedPaths.some((p) => p.includes('node_modules'))).toBe(true)
    }
  })

  it('statusOutput contains the ignored entry', async () => {
    const { classifyIntegrationDirtState } = await import('../main-dirty')
    writeFileSync(resolve(repo, '.gitignore'), 'dist/\n')
    execFileSync('git', ['add', '.gitignore'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'add gitignore'], { cwd: repo })
    execFileSync('mkdir', ['-p', resolve(repo, 'dist')])
    writeFileSync(resolve(repo, 'dist/bundle.js'), 'compiled\n')

    const result = await classifyIntegrationDirtState({
      repoRoot: repo,
      integrationBranch: 'main',
      traceCtx,
    })
    expect(result.kind).toBe('unrelated')
    if (result.kind === 'unrelated') {
      expect(result.statusOutput).toContain('!!')
    }
  })
})

describe('classifyIntegrationDirtState — unrelated arm: unmerged conflicts', () => {
  let repo: string

  beforeEach(() => { repo = setupRepo() })
  afterEach(() => { rmSync(repo, { recursive: true, force: true }) })

  it('returns unrelated when a merge conflict is unresolved', async () => {
    const { classifyIntegrationDirtState } = await import('../main-dirty')

    // Set up a conflict: both main AND branch-b diverge from a common ancestor
    // by making DIFFERENT changes to the same file.
    writeFileSync(resolve(repo, 'conflict.txt'), 'base\n')
    execFileSync('git', ['add', 'conflict.txt'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'base conflict.txt'], { cwd: repo })

    // branch-b diverges: changes conflict.txt
    execFileSync('git', ['checkout', '-b', 'branch-b'], { cwd: repo })
    writeFileSync(resolve(repo, 'conflict.txt'), 'branch-b-change\n')
    execFileSync('git', ['add', 'conflict.txt'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'branch-b changes conflict.txt'], { cwd: repo })

    // main also diverges: independently changes conflict.txt
    execFileSync('git', ['checkout', 'main'], { cwd: repo })
    writeFileSync(resolve(repo, 'conflict.txt'), 'main-change\n')
    execFileSync('git', ['add', 'conflict.txt'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'main changes conflict.txt'], { cwd: repo })

    // Now merging branch-b into main creates a conflict.
    try {
      execFileSync('git', ['merge', 'branch-b'], { cwd: repo })
    } catch {
      // Conflict expected — continue.
    }

    const result = await classifyIntegrationDirtState({
      repoRoot: repo,
      integrationBranch: 'main',
      traceCtx,
    })
    expect(result.kind).toBe('unrelated')
    if (result.kind === 'unrelated') {
      expect(result.contaminatedPaths.some((p) => p.includes('conflict.txt'))).toBe(true)
    }
  })

  it('contaminatedPaths includes paths detected by ls-files --unmerged', async () => {
    const { classifyIntegrationDirtState } = await import('../main-dirty')

    // Both branches diverge from a common base and change the same file.
    writeFileSync(resolve(repo, 'shared.txt'), 'base\n')
    execFileSync('git', ['add', 'shared.txt'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: repo })

    execFileSync('git', ['checkout', '-b', 'side'], { cwd: repo })
    writeFileSync(resolve(repo, 'shared.txt'), 'side-change\n')
    execFileSync('git', ['add', 'shared.txt'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'side changes shared.txt'], { cwd: repo })

    execFileSync('git', ['checkout', 'main'], { cwd: repo })
    writeFileSync(resolve(repo, 'shared.txt'), 'main-change\n')
    execFileSync('git', ['add', 'shared.txt'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'main changes shared.txt'], { cwd: repo })

    try {
      execFileSync('git', ['merge', 'side'], { cwd: repo })
    } catch {
      // Expected conflict.
    }

    const result = await classifyIntegrationDirtState({
      repoRoot: repo,
      integrationBranch: 'main',
      traceCtx,
    })
    expect(result.kind).toBe('unrelated')
    if (result.kind === 'unrelated') {
      expect(result.contaminatedPaths).toContain('shared.txt')
    }
  })
})

describe('classifyIntegrationDirtState — unrelated arm: submodule gitlink change', () => {
  let repo: string
  let subRepo: string

  beforeEach(() => {
    subRepo = mkdtempSync(resolve(tmpdir(), 'mars-classify-sub-'))
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: subRepo })
    execFileSync('git', ['config', 'user.email', 'test@example'], { cwd: subRepo })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: subRepo })
    writeFileSync(resolve(subRepo, 'sub.txt'), 'sub\n')
    execFileSync('git', ['add', 'sub.txt'], { cwd: subRepo })
    execFileSync('git', ['commit', '-q', '-m', 'sub init'], { cwd: subRepo })

    repo = setupRepo()
    // Allow local-file submodule transport: pass -c so it applies to the
    // internal git-clone spawned by submodule add (per-repo config alone
    // doesn't propagate to that subprocess).
    execFileSync(
      'git',
      ['-c', 'protocol.file.allow=always', 'submodule', 'add', subRepo, 'sub'],
      { cwd: repo },
    )
    execFileSync('git', ['commit', '-q', '-m', 'add submodule'], { cwd: repo })
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(subRepo, { recursive: true, force: true })
  })

  it('returns unrelated when the submodule HEAD has advanced (gitlink change)', async () => {
    const { classifyIntegrationDirtState } = await import('../main-dirty')

    // Advance the submodule HEAD so the gitlink in the parent changes.
    const subPath = resolve(repo, 'sub')
    writeFileSync(resolve(subPath, 'new.txt'), 'new commit\n')
    execFileSync('git', ['add', 'new.txt'], { cwd: subPath })
    execFileSync('git', ['commit', '-q', '-m', 'advance sub'], { cwd: subPath })

    const result = await classifyIntegrationDirtState({
      repoRoot: repo,
      integrationBranch: 'main',
      traceCtx,
    })
    expect(result.kind).toBe('unrelated')
    if (result.kind === 'unrelated') {
      expect(result.contaminatedPaths.some((p) => p.includes('sub'))).toBe(true)
    }
  })
})

describe('classifyIntegrationDirtState — mixed dirt', () => {
  let repo: string

  beforeEach(() => { repo = setupRepo() })
  afterEach(() => { rmSync(repo, { recursive: true, force: true }) })

  it('returns unrelated even when committer-scope dirt co-exists with ignored dirt', async () => {
    const { classifyIntegrationDirtState } = await import('../main-dirty')
    // Regular dirt: modify README.
    writeFileSync(resolve(repo, 'README.md'), 'modified\n')
    // Ignored dirt: create a .gitignore and an ignored file.
    writeFileSync(resolve(repo, '.gitignore'), 'secret.env\n')
    execFileSync('git', ['add', '.gitignore'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'gitignore'], { cwd: repo })
    writeFileSync(resolve(repo, 'secret.env'), 'SECRET=xyz\n')

    const result = await classifyIntegrationDirtState({
      repoRoot: repo,
      integrationBranch: 'main',
      traceCtx,
    })
    // Any unresolvable dirt → unrelated, even if committer-scope dirt also present.
    expect(result.kind).toBe('unrelated')
    if (result.kind === 'unrelated') {
      expect(result.contaminatedPaths.some((p) => p.includes('secret.env'))).toBe(true)
    }
  })
})

describe('classifyIntegrationDirtState — discriminated union shape', () => {
  let repo: string

  beforeEach(() => { repo = setupRepo() })
  afterEach(() => { rmSync(repo, { recursive: true, force: true }) })

  it('clean result has only the kind field', async () => {
    const { classifyIntegrationDirtState } = await import('../main-dirty')
    const result = await classifyIntegrationDirtState({
      repoRoot: repo,
      integrationBranch: 'main',
      traceCtx,
    })
    expect(result).toStrictEqual({ kind: 'clean' })
  })

  it('committer-scope result has kind and statusOutput', async () => {
    const { classifyIntegrationDirtState } = await import('../main-dirty')
    writeFileSync(resolve(repo, 'work.ts'), 'todo\n')
    const result = await classifyIntegrationDirtState({
      repoRoot: repo,
      integrationBranch: 'main',
      traceCtx,
    })
    expect(result.kind).toBe('committer-scope')
    expect(typeof (result as { statusOutput?: string }).statusOutput).toBe('string')
    expect('contaminatedPaths' in result).toBe(false)
  })

  it('unrelated result has kind, statusOutput, and contaminatedPaths array', async () => {
    const { classifyIntegrationDirtState } = await import('../main-dirty')
    writeFileSync(resolve(repo, '.gitignore'), 'ignored.log\n')
    execFileSync('git', ['add', '.gitignore'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'gitignore'], { cwd: repo })
    writeFileSync(resolve(repo, 'ignored.log'), 'log\n')

    const result = await classifyIntegrationDirtState({
      repoRoot: repo,
      integrationBranch: 'main',
      traceCtx,
    })
    expect(result.kind).toBe('unrelated')
    if (result.kind === 'unrelated') {
      expect(typeof result.statusOutput).toBe('string')
      expect(Array.isArray(result.contaminatedPaths)).toBe(true)
      expect(result.contaminatedPaths.length).toBeGreaterThan(0)
    }
  })
})
