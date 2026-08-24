/**
 * The exclusive per-worktree coder lease.
 *
 * The behaviour under test is the one the `fix-2b98a126` incident needed and
 * did not have: two coders dispatched onto the same worktree must not both get
 * to run in it. One acquires; the other is refused with a message naming the
 * holder.
 *
 * Nothing here is stubbed. The lease is a real file in a real temp directory,
 * and liveness is decided by real `process.kill(pid, 0)` probes against real
 * pids — including a genuinely-exited child process for the stale case, rather
 * than a pid number invented by the test. That matters because the whole
 * mechanism is a filesystem/OS boundary: a stub-only test would pass against
 * an implementation that never touches either.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireWorktreeLease,
  readLiveWorktreeLease,
  worktreeLeasePath,
  WorktreeLeaseHeldError,
} from '../worktree-lease'

let root: string
let worktreePath: string

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mars-worktree-lease-'))
  worktreePath = join(root, 'worktrees', 'mars-abc123')
  await mkdir(worktreePath, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('worktree lease', () => {
  it('lets exactly one of two concurrent coders into the same worktree', async () => {
    const results = await Promise.allSettled([
      acquireWorktreeLease({ worktreePath, taskId: 'mars-abc123', branch: 'task/mars-abc123' }),
      acquireWorktreeLease({ worktreePath, taskId: 'fix-deadbee', branch: 'task/mars-abc123' }),
    ])

    const winners = results.filter((r) => r.status === 'fulfilled')
    const losers = results.filter((r) => r.status === 'rejected')
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)

    // Both callers live in THIS process, which is the case `acquireLock` gets
    // wrong (it treats a same-pid holder as stale and would hand the tree to
    // both). The refusal must survive that.
    const reason = (losers[0] as PromiseRejectedResult).reason
    expect(reason).toBeInstanceOf(WorktreeLeaseHeldError)
  })

  it('names the holding task in the refusal so an operator can act on it', async () => {
    await acquireWorktreeLease({ worktreePath, taskId: 'mars-holder', branch: 'task/mars-holder' })

    const err = await acquireWorktreeLease({ worktreePath, taskId: 'fix-second' }).catch(
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(WorktreeLeaseHeldError)
    const held = err as WorktreeLeaseHeldError
    expect(held.message).toContain('mars-holder')
    expect(held.message).toContain(worktreePath)
    expect(held.holder?.taskId).toBe('mars-holder')
    expect(held.holder?.pid).toBe(process.pid)
  })

  it('frees the worktree for the next coder once released', async () => {
    const release = await acquireWorktreeLease({ worktreePath, taskId: 'mars-first' })
    await release()

    expect(await readLiveWorktreeLease(worktreePath)).toBeNull()

    const second = await acquireWorktreeLease({ worktreePath, taskId: 'mars-second' })
    expect((await readLiveWorktreeLease(worktreePath))?.taskId).toBe('mars-second')
    await second()
  })

  it('reclaims a lease whose owning process is really gone', async () => {
    // A genuinely dead pid, not a guessed one: spawn a process, let it exit,
    // then claim the worktree in its name. This is the daemon-crashed case —
    // without reclamation every worktree it held would be stranded forever.
    const child = spawnSync(process.execPath, ['-e', ''])
    expect(child.status).toBe(0)
    const deadPid = child.pid
    expect(typeof deadPid).toBe('number')

    writeFileSync(
      worktreeLeasePath(worktreePath),
      JSON.stringify({
        taskId: 'mars-crashed',
        branch: 'task/mars-crashed',
        pid: deadPid,
        acquiredAt: Date.now() - 60_000,
      }),
      'utf8',
    )

    expect(await readLiveWorktreeLease(worktreePath)).toBeNull()

    const release = await acquireWorktreeLease({ worktreePath, taskId: 'mars-next' })
    expect((await readLiveWorktreeLease(worktreePath))?.taskId).toBe('mars-next')
    await release()
  })

  it('reclaims a corrupt lease instead of stranding the worktree', async () => {
    writeFileSync(worktreeLeasePath(worktreePath), 'not json at all', 'utf8')

    expect(await readLiveWorktreeLease(worktreePath)).toBeNull()

    const release = await acquireWorktreeLease({ worktreePath, taskId: 'mars-next' })
    expect((await readLiveWorktreeLease(worktreePath))?.taskId).toBe('mars-next')
    await release()
  })

  it('keeps the lease across a real `git worktree` directory, not inside it', async () => {
    // The lease has to survive `git worktree remove` deleting the directory
    // wholesale, which is why it is a sibling file. Verified against real git
    // rather than asserted about the path string.
    const repo = join(root, 'repo')
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { cwd: root })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
    writeFileSync(join(repo, 'README.md'), 'hi\n', 'utf8')
    execFileSync('git', ['add', '-A'], { cwd: repo })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo })

    const linked = join(root, 'linked-worktree')
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'task/x', linked], { cwd: repo })

    const release = await acquireWorktreeLease({ worktreePath: linked, taskId: 'mars-live' })
    execFileSync('git', ['worktree', 'remove', '--force', linked], { cwd: repo })

    expect(existsSync(linked)).toBe(false)
    expect(existsSync(worktreeLeasePath(linked))).toBe(true)
    expect(JSON.parse(readFileSync(worktreeLeasePath(linked), 'utf8')).taskId).toBe('mars-live')
    await release()
  })
})
