import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-steward-guard-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

describe('Steward repeat guard', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
    vi.resetModules()
    process.env.MARS_REPO = repo
    process.env.MARS_FIX_RETRY_BUDGET = '10'
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_FIX_RETRY_BUDGET
    rmSync(repo, { recursive: true, force: true })
  })

  it('escalates a second unchanged failure after one Steward fix instead of spawning another fix', async () => {
    const queue = await import('../queue')
    await queue.migrateQueueSchema()
    const fixTasks = await import('../queue-fix-tasks')
    const task = await queue.enqueueTask('repair the release notes', undefined, {
      skipTriage: true,
    })

    const first = await fixTasks.handleTaskFailureWithFixTask({
      taskId: task.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: Cannot find name releaseNotes.',
    })
    expect(first.outcome).toBe('blocked')
    expect(first.fixTaskId).toBeTruthy()

    // Must be `failed`, not `done`: a recovery that reaches `done` settles its
    // origin via the landed-recovery gate in queue-fix-tasks.ts, which would
    // short-circuit the second dispatch to 'noop'. `failed` clears the
    // in-flight dedup guard without asserting the work shipped.
    await queue.updateTask(first.fixTaskId!, {
      status: 'failed',
      failureReason: 'steward fix did not resolve the failure',
    })

    const second = await fixTasks.handleTaskFailureWithFixTask({
      taskId: task.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: Cannot find name releaseNotes.',
    })

    expect(second.outcome).toBe('steward-repeat')
    const fixes = await queue.resolveQueueClient().execute({
      sql: 'SELECT id FROM tasks WHERE fix_for_task_id = ?',
      args: [task.id],
    })
    expect(fixes.rows).toHaveLength(1)

    // Under ADR-0057, `steward-repeat` is a derived action-queue kind, not a
    // stored row — see src/core/steward-guard.ts's
    // raiseStewardRepeatActionQueueItem (a no-op stub) and the `DERIVED_KINDS`
    // set / `ConditionItemsSource` doc comment in
    // src/core/daemon/view/action-queue.ts. There is no producer that can be
    // exercised without standing up the daemon's action-queue view, so the
    // real guard for this test is the two assertions above: exactly one fix
    // task is spawned and the second dispatch reports `steward-repeat`
    // instead of spawning another. The general derived-kind filtering
    // behaviour (stored rows for derived kinds never leak into the view) is
    // covered by src/core/daemon/view/__tests__/action-queue.test.ts.
  })
})
