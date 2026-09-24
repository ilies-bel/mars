import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { noDaemonBody } from '../daemonHttp.ts'
import { resolveRepo } from '../repo.ts'

describe('resolveRepo worktree correction', () => {
  it('resolves a path under .mars/worktrees/<id> to the containing repo root', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const root = mkdtempSync(join(tmpdir(), 'mars-repo-'))
    const ctx = resolveRepo(join(root, '.mars', 'worktrees', 'mars-abc'))
    expect(ctx.repoRoot).toBe(root)
    expect(ctx.stateDir).toBe(join(root, '.mars'))
  })

  it('does not create a state dir or mars.db as a side effect', () => {
    const root = mkdtempSync(join(tmpdir(), 'mars-repo-'))
    const ctx = resolveRepo(root)
    expect(existsSync(ctx.stateDir)).toBe(false)
    expect(existsSync(ctx.queueDbPath)).toBe(false)
  })
})

describe('noDaemonBody', () => {
  it('names the missing state dir when .mars does not exist', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'mars-repo-')), '.mars')
    const body = noDaemonBody(dir)
    expect(body.errorCode).toBe('NO_DAEMON')
    expect(body.error).toContain(dir)
    expect(body.error).toContain('no .mars state dir')
  })

  it('reports a stopped daemon when the state dir exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'mars-repo-'))
    const ctx = resolveRepo(root)
    mkdirSync(ctx.stateDir)
    const body = noDaemonBody(ctx.stateDir)
    expect(body.error).toContain(join(ctx.stateDir, 'http.port'))
    expect(body.error).not.toContain('no .mars state dir')
  })
})
