import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { provisionWorktreeDeps } from '../worktree-deps'

describe('provisionWorktreeDeps', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('links each Mars workspace to the source dependency tree and remains safe to repeat', async () => {
    const sourceRoot = mkdtempSync(resolve(tmpdir(), 'mars-worktree-deps-source-'))
    const worktreeRoot = mkdtempSync(resolve(tmpdir(), 'mars-worktree-deps-target-'))
    roots.push(sourceRoot, worktreeRoot)
    for (const workspace of ['orchestrator', 'ui']) {
      mkdirSync(resolve(sourceRoot, workspace, 'node_modules'), { recursive: true })
      mkdirSync(resolve(worktreeRoot, workspace), { recursive: true })
    }

    await provisionWorktreeDeps({ worktreeRoot, sourceRoot })
    await provisionWorktreeDeps({ worktreeRoot, sourceRoot })

    for (const workspace of ['orchestrator', 'ui']) {
      const link = resolve(worktreeRoot, workspace, 'node_modules')
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      expect(realpathSync(link)).toBe(realpathSync(resolve(sourceRoot, workspace, 'node_modules')))
    }
  })

  it('provisions dependencies when creating a task worktree', async () => {
    const sourceRoot = mkdtempSync(resolve(tmpdir(), 'mars-worktree-create-source-'))
    roots.push(sourceRoot)
    for (const workspace of ['orchestrator', 'ui']) {
      mkdirSync(resolve(sourceRoot, workspace, 'node_modules'), { recursive: true })
    }
    writeFileSync(resolve(sourceRoot, 'README.md'), 'base\n')
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: sourceRoot })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: sourceRoot })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: sourceRoot })
    execFileSync('git', ['add', 'README.md'], { cwd: sourceRoot })
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: sourceRoot })

    const originalRepo = process.env.MARS_REPO
    process.env.MARS_REPO = sourceRoot
    const { __resetContextCacheForTests } = await import('../../context')
    __resetContextCacheForTests()
    try {
      const { createWorktree } = await import('../git/worktree')
      const worktree = await createWorktree({
        taskId: 'mars-provisioned',
        integrationBranch: 'main',
      })

      for (const workspace of ['orchestrator', 'ui']) {
        expect(realpathSync(resolve(worktree.path, workspace, 'node_modules'))).toBe(
          realpathSync(resolve(sourceRoot, workspace, 'node_modules')),
        )
      }
    } finally {
      if (originalRepo === undefined) delete process.env.MARS_REPO
      else process.env.MARS_REPO = originalRepo
      __resetContextCacheForTests()
    }
  })
})
