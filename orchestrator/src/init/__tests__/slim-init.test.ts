import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeSlimInit } from '../writer'
import { detectCurrentBranch } from '../detect-branch'

const slimInputFor = (root: string) => ({
  repoRoot: root,
  contextPath: resolve(root, 'CONTEXT.md'),
  adrDir: resolve(root, 'docs', 'knowledge', 'decisions'),
})

describe('writeSlimInit', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'mars-slim-init-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('creates a CONTEXT.md skeleton when one is not already present', () => {
    writeSlimInit(slimInputFor(root))

    const contextPath = resolve(root, 'CONTEXT.md')
    expect(existsSync(contextPath)).toBe(true)
    const content = readFileSync(contextPath, 'utf8')
    expect(content).toContain('# Project Context')
    expect(content).toContain('## Language')
  })

  it('does not overwrite an existing CONTEXT.md', () => {
    const contextPath = resolve(root, 'CONTEXT.md')
    const existing = '# Project Context\n\n## Language\n\n**Foo**:\nbar.\n'
    mkdirSync(root, { recursive: true })
    writeFileSync(contextPath, existing, 'utf8')

    writeSlimInit(slimInputFor(root))

    expect(readFileSync(contextPath, 'utf8')).toBe(existing)
  })

  it('creates the docs/knowledge/decisions/ scaffold directory', () => {
    writeSlimInit(slimInputFor(root))

    const adrDir = resolve(root, 'docs', 'knowledge', 'decisions')
    expect(existsSync(adrDir)).toBe(true)
  })

  it('does not produce .mars/supervisors/<name>.md briefing files', () => {
    writeSlimInit(slimInputFor(root))

    const supervisorsDir = resolve(root, '.mars', 'supervisors')
    if (existsSync(supervisorsDir)) {
      const briefings = readdirSync(supervisorsDir).filter((e) =>
        e.endsWith('.md'),
      )
      expect(briefings).toEqual([])
    }
  })
})

describe('detectCurrentBranch', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'mars-detect-branch-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /**
   * Create a minimal git repo at `dir` with `branch` as the initial branch
   * and a single empty commit so symbolic-ref returns a stable answer.
   */
  const makeRepo = (dir: string, branch: string): void => {
    spawnSync('git', ['init', '-b', branch, dir], { stdio: 'ignore' })
    spawnSync('git', ['-C', dir, 'config', 'user.email', 'test@test.com'], { stdio: 'ignore' })
    spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test'], { stdio: 'ignore' })
    spawnSync('git', ['-C', dir, 'commit', '--allow-empty', '-m', 'root'], { stdio: 'ignore' })
  }

  it('returns master for a repo whose current branch is master', () => {
    makeRepo(root, 'master')
    expect(detectCurrentBranch(root)).toBe('master')
  })

  it('returns main for a repo whose current branch is main', () => {
    makeRepo(root, 'main')
    expect(detectCurrentBranch(root)).toBe('main')
  })

  it('returns null for a directory that is not a git repo', () => {
    expect(detectCurrentBranch(root)).toBeNull()
  })

  it('persists to daemon.json so setup would target master instead of main', () => {
    makeRepo(root, 'master')

    const branch = detectCurrentBranch(root)
    expect(branch).toBe('master')

    // Simulate what init does: write integrationBranch to .mars/daemon.json
    const marsDir = resolve(root, '.mars')
    mkdirSync(marsDir, { recursive: true })
    writeFileSync(
      resolve(marsDir, 'daemon.json'),
      JSON.stringify({ integrationBranch: branch }),
      'utf8',
    )

    // Assert daemon.json carries the detected branch
    const raw = JSON.parse(readFileSync(resolve(marsDir, 'daemon.json'), 'utf8')) as {
      integrationBranch: string
    }
    expect(raw.integrationBranch).toBe('master')
  })
})
