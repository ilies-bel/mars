/**
 * Coverage for the committer-liveness short-circuit and bounded-lifetime
 * backstop (task mars-43e9b0d7).
 *
 * WHAT WAS HAPPENING. A `main-commiter` fix task was spawned when the
 * integration branch was dirty. By the time the agent ran the branch had
 * already been cleaned, but the `COMMIT_EXIT_CONDITION` prompt biased the
 * agent toward committing — nothing to commit, no exit. The committer then
 * held its blocked dependents in `blocked` indefinitely.
 *
 * THE FIXES:
 *  1. Short-circuit: before any agent spawn, `settleCommitterDoneIfClean`
 *     checks whether the integration branch is still dirty. If clean, the
 *     committer is settled `done` immediately and `Arc.unblockByCompletion`
 *     releases its blocked dependents — no worktree, no agent, no tokens.
 *  2. Lifetime backstop: the running-committer lifetime sweep calls
 *     `settleCommitterDoneIfClean` for long-running committers. If the
 *     branch is now clean it settles done; if still dirty it fails the
 *     committer so dependents are not parked behind it indefinitely.
 *
 * These tests pin both fixes without touching the daemon's dispatch loop
 * directly — they verify the public interface (`settleCommitterDoneIfClean`
 * and `Arc.unblockByCompletion`) that both callers rely on.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

/**
 * A clean git repo whose `.gitignore` swallows every `.mars*` path so
 * `git status --porcelain` stays empty. Same helper as zombie-committer tests.
 */
const setupCleanRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-committer-liveness-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  writeFileSync(resolve(repo, '.gitignore'), '.mars*\n')
  execFileSync('git', ['add', '.gitignore'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const queue = await import('../../queue')
  await queue.migrateQueueSchema()
  const mainDirty = await import('../../lib/main-dirty')
  const arc = await import('../../arc')
  const { nullTraceStore } = await import('../../lib/run-tool')
  return { queue, mainDirty, arc, nullTraceStore }
}

/** Detection payload used when spawning committers. */
const DIRTY = { dirty: true as const, statusOutput: ' M src/thing.ts\n' }

import { vi } from 'vitest'

describe('committer liveness', () => {
  let repo: string

  beforeEach(() => {
    repo = setupCleanRepo()
  })

  afterEach(async () => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  // ── short-circuit: clean branch → settle done without agent ─────────────

  it('settleCommitterDoneIfClean settles the committer done when branch is clean', async () => {
    const { queue, mainDirty, nullTraceStore } = await loadModules(repo)

    // Spawn a source task and park it behind a committer.
    const src = await queue.enqueueTask('clean-branch-src', undefined, { skipTriage: true })
    const { fixTaskId } = await mainDirty.spawnOrAttachMainCommitter({
      sourceTaskId: src.id,
      detection: DIRTY,
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'commit',
      sourceOriginId: src.id,
    })

    expect((await queue.getTask(fixTaskId))?.status).toBe('queued')
    expect((await queue.getTask(src.id))?.status).toBe('blocked')

    // The integration branch is already clean (the repo was set up clean).
    // settleCommitterDoneIfClean should settle the committer done immediately.
    const result = await mainDirty.settleCommitterDoneIfClean(
      fixTaskId,
      'main',
      repo,
      nullTraceStore,
    )

    expect(result.settled).toBe(true)
    expect((await queue.getTask(fixTaskId))?.status).toBe('done')
  })

  it('settleCommitterDoneIfClean releases blocked dependents via unblockByCompletion', async () => {
    const { queue, mainDirty, arc: arcMod, nullTraceStore } = await loadModules(repo)

    const src = await queue.enqueueTask('unblock-src', undefined, { skipTriage: true })
    const { fixTaskId } = await mainDirty.spawnOrAttachMainCommitter({
      sourceTaskId: src.id,
      detection: DIRTY,
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'commit',
      sourceOriginId: src.id,
    })

    expect((await queue.getTask(src.id))?.status).toBe('blocked')

    // Settle the committer done (branch is clean).
    const { settled } = await mainDirty.settleCommitterDoneIfClean(
      fixTaskId,
      'main',
      repo,
      nullTraceStore,
    )
    expect(settled).toBe(true)

    // Simulate what bus.emit('task.completed') triggers in the daemon:
    // Arc.unblockByCompletion releases dependents blocked on the committer.
    const unblockResult = await arcMod.Arc.unblockByCompletion(fixTaskId)

    // The source task is re-queued; the blocker edge is removed.
    const outcomes = unblockResult.outcomes.map((o) => o.outcome)
    expect(outcomes).toContain('queued')
    expect((await queue.getTask(src.id))?.status).toBe('queued')
  })

  it('settleCommitterDoneIfClean returns settled=false when branch is still dirty', async () => {
    // Make the repo dirty by adding an untracked file outside .mars/.
    writeFileSync(resolve(repo, 'dirty-file.txt'), 'uncommitted change\n')

    const { queue, mainDirty, nullTraceStore } = await loadModules(repo)

    const src = await queue.enqueueTask('dirty-branch-src', undefined, { skipTriage: true })
    const { fixTaskId } = await mainDirty.spawnOrAttachMainCommitter({
      sourceTaskId: src.id,
      detection: DIRTY,
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'commit',
      sourceOriginId: src.id,
    })

    // Branch is dirty — the committer should NOT be settled.
    const result = await mainDirty.settleCommitterDoneIfClean(
      fixTaskId,
      'main',
      repo,
      nullTraceStore,
    )

    expect(result.settled).toBe(false)
    // Task is unchanged — still queued, not done.
    expect((await queue.getTask(fixTaskId))?.status).toBe('queued')
  })

  // ── bounded lifetime: long-running committer on clean branch ─────────────

  it('lifetime backstop: running committer with clean branch is settled done', async () => {
    // A committer that has been in `running` for a long time on a branch that
    // is now clean. The lifetime sweep calls settleCommitterDoneIfClean and
    // emits task.completed. We test the settle step directly (as the sweep does).
    const { queue, mainDirty, arc: arcMod, nullTraceStore } = await loadModules(repo)

    const src = await queue.enqueueTask('lifetime-src', undefined, { skipTriage: true })
    const { fixTaskId } = await mainDirty.spawnOrAttachMainCommitter({
      sourceTaskId: src.id,
      detection: DIRTY,
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'commit',
      sourceOriginId: src.id,
    })

    // Transition the committer to `running` (simulating an in-flight agent).
    await queue.updateTask(fixTaskId, { status: 'running' })
    expect((await queue.getTask(src.id))?.status).toBe('blocked')

    // The branch is now clean (repo was set up clean, nothing committed).
    // The lifetime sweep calls settleCommitterDoneIfClean for this committer.
    const { settled } = await mainDirty.settleCommitterDoneIfClean(
      fixTaskId,
      'main',
      repo,
      nullTraceStore,
    )

    // Committer is settled done — no longer holding dependents.
    expect(settled).toBe(true)
    expect((await queue.getTask(fixTaskId))?.status).toBe('done')

    // Releasing via unblockByCompletion (as bus.emit('task.completed') triggers).
    const unblockResult = await arcMod.Arc.unblockByCompletion(fixTaskId)
    const outcomes = unblockResult.outcomes.map((o) => o.outcome)
    expect(outcomes).toContain('queued')
    expect((await queue.getTask(src.id))?.status).toBe('queued')
  })
})
