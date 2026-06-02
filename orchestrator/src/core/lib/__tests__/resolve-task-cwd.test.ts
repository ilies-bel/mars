import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { resolveTaskCwd } from '../resolve-task-cwd'

describe('resolveTaskCwd', () => {
  let worktree: string

  beforeEach(() => {
    worktree = mkdtempSync(resolve(tmpdir(), 'mars-resolve-task-cwd-'))
  })

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true })
  })

  const seedOrchestrator = (): string => {
    const sub = resolve(worktree, 'orchestrator')
    mkdirSync(sub)
    writeFileSync(
      resolve(sub, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run' } }),
    )
    writeFileSync(resolve(sub, 'tsconfig.json'), '{}')
    return sub
  }

  it('returns the project subdirectory when all files live under it (single-subproject)', () => {
    const sub = seedOrchestrator()
    const cwd = resolveTaskCwd(worktree, ['orchestrator/src/foo.ts'])
    expect(cwd).toBe(sub)
  })

  it('returns the project subdirectory for multiple files sharing that prefix', () => {
    const sub = seedOrchestrator()
    const cwd = resolveTaskCwd(worktree, [
      'orchestrator/src/foo.ts',
      'orchestrator/src/bar.ts',
      'orchestrator/src/__tests__/baz.test.ts',
    ])
    expect(cwd).toBe(sub)
  })

  it('falls back to the worktree root when files span multiple subprojects (no project layout)', () => {
    // No subproject seeded: common prefix is empty, so we fall back to
    // resolveVerifyCwd, which returns the worktree root unchanged.
    const cwd = resolveTaskCwd(worktree, [
      '.github/workflows/ci.yml',
      'orchestrator/src/foo.ts',
    ])
    expect(cwd).toBe(worktree)
  })

  it('treats segment-wise prefixes as non-shared even when characters overlap', () => {
    // `.github` and `.gitignore` share `.git` character-wise but no path
    // segments. The common prefix must be empty here.
    const cwd = resolveTaskCwd(worktree, [
      '.github/workflows/ci.yml',
      '.gitignore',
    ])
    expect(cwd).toBe(worktree)
  })

  it('falls back to resolveVerifyCwd when the files array is empty', () => {
    const sub = seedOrchestrator()
    // resolveVerifyCwd will find the orchestrator subproject because the
    // root lacks tsconfig.json. That is the documented fallback.
    expect(resolveTaskCwd(worktree, [])).toBe(sub)
  })

  it('falls back when the common prefix exists but no ancestor is a project (e.g. ui/ lacks tsconfig.json)', () => {
    // Seed orchestrator so the *default* fallback is non-trivial.
    const sub = seedOrchestrator()
    // ui/ has package.json but no tsconfig.json — so it is NOT a project.
    const ui = resolve(worktree, 'ui')
    mkdirSync(ui)
    writeFileSync(
      resolve(ui, 'package.json'),
      JSON.stringify({ name: 'ui' }),
    )
    const cwd = resolveTaskCwd(worktree, ['ui/src/foo.tsx'])
    // Falls back to resolveVerifyCwd, which in this fixture finds the
    // orchestrator subproject (root lacks tsconfig.json so verify uses
    // the orchestrator path).
    expect(cwd).toBe(sub)
  })

  it('walks up to find the project when the common prefix points deeper than the project root', () => {
    const sub = seedOrchestrator()
    // Files all live under orchestrator/src/core — common prefix is
    // 3 segments deep, but the project is at orchestrator/.
    const cwd = resolveTaskCwd(worktree, [
      'orchestrator/src/core/agents/foo.ts',
      'orchestrator/src/core/agents/bar.ts',
    ])
    expect(cwd).toBe(sub)
  })

  it('returns the worktree root when it is itself the project', () => {
    writeFileSync(resolve(worktree, 'package.json'), '{}')
    writeFileSync(resolve(worktree, 'tsconfig.json'), '{}')
    const cwd = resolveTaskCwd(worktree, ['src/foo.ts'])
    expect(cwd).toBe(worktree)
  })
})
