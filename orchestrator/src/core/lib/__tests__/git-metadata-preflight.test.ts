import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkGitMetadataWritable, resolveGitDir } from '../git-metadata-preflight'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mars-gitmeta-'))
})

afterEach(() => {
  // Restore permissions first so the recursive removal can descend.
  try {
    chmodSync(join(root, '.git', 'worktrees'), 0o755)
  } catch {
    // directory may not exist in every test
  }
  rmSync(root, { recursive: true, force: true })
})

describe('resolveGitDir', () => {
  it('resolves a normal checkout’s .git directory', () => {
    mkdirSync(join(root, '.git'))
    expect(resolveGitDir(root)).toBe(join(root, '.git'))
  })

  it('follows a linked worktree’s `gitdir:` pointer file', () => {
    const real = join(root, 'real-git')
    mkdirSync(real)
    writeFileSync(join(root, '.git'), `gitdir: ${real}\n`)
    expect(resolveGitDir(root)).toBe(real)
  })

  it('resolves a relative `gitdir:` pointer against the repo root', () => {
    mkdirSync(join(root, 'nested'))
    writeFileSync(join(root, '.git'), 'gitdir: ./nested\n')
    expect(resolveGitDir(root)).toBe(join(root, 'nested'))
  })

  it('returns null when .git is absent', () => {
    expect(resolveGitDir(root)).toBeNull()
  })
})

describe('checkGitMetadataWritable', () => {
  it('passes on a writable .git, creating the worktrees dir when absent', () => {
    mkdirSync(join(root, '.git'))
    const probe = checkGitMetadataWritable(root)
    expect(probe.writable).toBe(true)
    expect(probe.code).toBeNull()
    expect(probe.probedPath).toBe(join(root, '.git', 'worktrees'))
  })

  it('leaves no probe file behind', () => {
    mkdirSync(join(root, '.git'))
    checkGitMetadataWritable(root)
    expect(readdirSync(join(root, '.git', 'worktrees'))).toEqual([])
  })

  it('refuses when .git cannot be resolved at all', () => {
    const probe = checkGitMetadataWritable(root)
    expect(probe.writable).toBe(false)
    expect(probe.code).toBe('ENOENT')
    expect(probe.message).toContain('refusing to start')
  })

  it('refuses, with an actionable message, when the metadata dir is not writable', () => {
    // Skip when running as root: mode bits do not restrict uid 0.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return
    const wt = join(root, '.git', 'worktrees')
    mkdirSync(wt, { recursive: true })
    chmodSync(wt, 0o500) // r-x: traversable, not writable

    const probe = checkGitMetadataWritable(root)
    expect(probe.writable).toBe(false)
    expect(probe.code).toBe('EACCES')
    expect(probe.message).toContain('index.lock')
    expect(probe.message).toContain('Refusing to start')
    expect(probe.message).toContain(wt)
  })
})
