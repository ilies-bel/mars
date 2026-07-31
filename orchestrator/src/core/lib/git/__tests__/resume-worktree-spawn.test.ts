/**
 * Regression: a watchdog-killed task must be retryable.
 *
 * THE BUG. Checkpoint-resume replays a run with `runId = task.id`, so an
 * already-completed `setup` step short-circuits and `resolveWorktree`
 * reconstitutes the worktree ref from the task row without revalidating it.
 * When the worktree directory had been removed while the task was parked (a
 * recovery task sharing the origin's worktree merging and cleaning it up, an
 * operator drop, a prune), the resumed `code` step spawned the provider CLI
 * with `cwd` pointing at a deleted directory. Node reports a missing cwd with
 * the SAME `ENOENT` it uses for a missing executable, which the subprocess
 * wrapper maps to exit 127 — in ~19ms, looking exactly like "command not
 * found" and bucketing as the contentless `coder-exit-nonzero`.
 *
 * NO REAL PROVIDER IS EVER SPAWNED HERE. Every spawn in this file targets
 * `/bin/echo` (or `git`), never `codex` / `claude` / `gemini`. The provider
 * adapters are exercised only at the argv level, with the spawn stubbed.
 */
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { runSubprocessStreaming } from '../claude'

/** A binary that is guaranteed to exist and is harmless to run. */
const HARMLESS_BIN = '/bin/echo'

// ---------------------------------------------------------------------------
// 1. The failure signature: exit 127 from a missing cwd, not a missing binary
// ---------------------------------------------------------------------------

describe('runSubprocessStreaming — ENOENT disambiguation', () => {
  it('control: the binary resolves and runs fine when cwd exists', async () => {
    const r = await runSubprocessStreaming(HARMLESS_BIN, ['ok'], tmpdir())
    // Proves HARMLESS_BIN is genuinely resolvable, so the only variable in the
    // next test is the working directory.
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('ok')
  })

  it('reproduces the bug: a resolvable binary + a deleted cwd exits 127', async () => {
    const goneDir = resolve(tmpdir(), `mars-resume-gone-${process.pid}-${Date.now()}`)
    expect(existsSync(goneDir)).toBe(false)

    const r = await runSubprocessStreaming(HARMLESS_BIN, ['ok'], goneDir)

    // This is the exact observed signature: exit 127 with no output.
    expect(r.exitCode).toBe(127)
    expect(r.stdout).toBe('')
  })

  it('names the missing DIRECTORY, not the command, and rules out PATH', async () => {
    const goneDir = resolve(tmpdir(), `mars-resume-gone2-${process.pid}-${Date.now()}`)

    const r = await runSubprocessStreaming(HARMLESS_BIN, ['ok'], goneDir)

    // The diagnostic must point at the real cause.
    expect(r.stderr).toContain('working directory does not exist')
    expect(r.stderr).toContain(goneDir)
    // ...and must explicitly disown the misdiagnosis that hid this for days.
    expect(r.stderr).toContain('NOT a PATH or missing-binary problem')
  })

  it('still reports a genuinely missing binary as a missing command', async () => {
    const missingBin = `/nonexistent/mars-not-a-real-binary-${process.pid}`

    const r = await runSubprocessStreaming(missingBin, [], tmpdir())

    expect(r.exitCode).toBe(127)
    expect(r.stderr).toContain('command not found')
    expect(r.stderr).toContain(missingBin)
    // The cwd existed, so the message must NOT blame the directory.
    expect(r.stderr).not.toContain('working directory does not exist')
  })
})

// ---------------------------------------------------------------------------
// 2. The fix: a retry after a simulated watchdog kill gets a real worktree
// ---------------------------------------------------------------------------

describe('restoreWorktreeIfMissing — retry after a watchdog kill', () => {
  let repoRoot: string
  let worktreePath: string
  const branch = 'task/mars-resume-test'
  const originalRepoEnv = process.env.MARS_REPO

  const git = (args: string[], cwd: string): string =>
    execFileSync('git', args, { cwd, encoding: 'utf-8' })

  beforeAll(async () => {
    repoRoot = mkdtempSync(resolve(tmpdir(), 'mars-resume-repo-'))
    git(['init', '-b', 'main'], repoRoot)
    git(['config', 'user.email', 'test@mars'], repoRoot)
    git(['config', 'user.name', 'Mars Test'], repoRoot)
    execFileSync('git', ['commit', '--allow-empty', '-m', 'base'], { cwd: repoRoot })

    // Point the orchestrator context at the temp repo.
    process.env.MARS_REPO = repoRoot
    const { __resetContextCacheForTests } = await import('../../../context')
    __resetContextCacheForTests()

    worktreePath = resolve(repoRoot, '.mars/worktrees/mars-resume-test')
    mkdirSync(resolve(worktreePath, '..'), { recursive: true })
    git(['worktree', 'add', '-b', branch, worktreePath, 'main'], repoRoot)
  })

  afterAll(async () => {
    if (originalRepoEnv === undefined) delete process.env.MARS_REPO
    else process.env.MARS_REPO = originalRepoEnv
    const { __resetContextCacheForTests } = await import('../../../context')
    __resetContextCacheForTests()
    rmSync(repoRoot, { recursive: true, force: true })
  })

  it('is a cheap no-op when the worktree is still on disk', async () => {
    const { restoreWorktreeIfMissing } = await import('../worktree')
    const outcome = await restoreWorktreeIfMissing({
      taskId: 'mars-resume-test',
      ref: { path: worktreePath, branch },
    })
    expect(outcome).toBe('present')
  })

  it('rebuilds the worktree so the retry spawns with a valid cwd', async () => {
    const { restoreWorktreeIfMissing } = await import('../worktree')

    // Simulate the watchdog kill + cleanup: the directory is removed while the
    // task is parked, but the branch (and its committed work) survives.
    rmSync(worktreePath, { recursive: true, force: true })
    expect(existsSync(worktreePath)).toBe(false)

    // Before the fix, this is the moment the retry died: spawning into the
    // deleted directory yields the exact 127 signature.
    const beforeRepair = await runSubprocessStreaming(HARMLESS_BIN, ['x'], worktreePath)
    expect(beforeRepair.exitCode).toBe(127)

    const outcome = await restoreWorktreeIfMissing({
      taskId: 'mars-resume-test',
      ref: { path: worktreePath, branch },
    })

    expect(outcome).toBe('rebuilt')
    expect(existsSync(worktreePath)).toBe(true)

    // The retry now has a real working directory: the same spawn succeeds.
    const afterRepair = await runSubprocessStreaming(HARMLESS_BIN, ['x'], worktreePath)
    expect(afterRepair.exitCode).toBe(0)
    expect(afterRepair.stdout).toContain('x')
  })

  it('throws a named error when the branch is gone too (nothing to resume)', async () => {
    const { restoreWorktreeIfMissing, ResumeWorktreeUnrecoverable } = await import(
      '../worktree'
    )

    const deadPath = resolve(repoRoot, '.mars/worktrees/mars-never-existed')
    await expect(
      restoreWorktreeIfMissing({
        taskId: 'mars-never-existed',
        ref: { path: deadPath, branch: 'task/mars-never-existed' },
      }),
    ).rejects.toBeInstanceOf(ResumeWorktreeUnrecoverable)
  })
})

// ---------------------------------------------------------------------------
// 3. The retry dispatch builds a well-formed argv with a resolvable binary
// ---------------------------------------------------------------------------

describe('codex retry dispatch — argv well-formedness', () => {
  it('spawns a non-empty, resolvable binary with no empty argv entries', async () => {
    const captured: { cmd: string; args: readonly string[]; cwd: string }[] = []

    // Stub the spawn seam so NO provider process is ever created.
    vi.resetModules()
    vi.doMock('../claude', async () => {
      const actual = await vi.importActual<typeof import('../claude')>('../claude')
      return {
        ...actual,
        runSubprocessStreaming: vi.fn(
          async (cmd: string, args: readonly string[], cwd: string) => {
            captured.push({ cmd, args, cwd })
            return { exitCode: 0, stdout: '', stderr: '' }
          },
        ),
      }
    })

    const { codexHeadless } = await import('../../../workers/providers/codex-headless')
    await codexHeadless.run('do the thing', { cwd: tmpdir(), model: 'gpt-5.6-terra' })

    vi.doUnmock('../claude')
    vi.resetModules()

    expect(captured).toHaveLength(1)
    const call = captured[0]!

    // The command must be a non-empty string — an empty/undefined command is
    // the other way to manufacture an instant exit 127.
    expect(call.cmd).toBeTruthy()
    expect(call.cmd.trim().length).toBeGreaterThan(0)

    // No argv entry may be empty or undefined.
    for (const arg of call.args) {
      expect(typeof arg).toBe('string')
      expect(arg.length).toBeGreaterThan(0)
    }

    // The argv is the shape codex actually expects.
    expect(call.args[0]).toBe('exec')
    expect(call.args).toContain('--model')
    expect(call.args).toContain('gpt-5.6-terra')

    // And the resolved binary is reachable — `command -v` proves the retry
    // would not have died with "command not found". Skipped (not failed) when
    // codex is not installed, so the suite stays green on a bare CI box.
    let resolved = ''
    try {
      resolved = execFileSync('/bin/sh', ['-c', `command -v ${call.cmd}`], {
        encoding: 'utf-8',
      }).trim()
    } catch {
      resolved = ''
    }
    if (resolved !== '') expect(existsSync(resolved)).toBe(true)
  })
})
