/**
 * `set-verify` updates the verify command that the verify step reads.
 *
 * The verify step (`review.ts`) reads `verifyCmd` from the task row via
 * `store.getTask(taskId)` at verify time — not from the dispatch-time
 * snapshot captured in `spec`. This test proves the DB seam:
 *
 *   1. A task is enqueued with verifyCmd = 'original'.
 *   2. `Arc.setVerifyCmd` updates it to 'updated' (the `set-verify` RPC path).
 *   3. A subsequent `getTask` call returns 'updated' in `spec.verifyCmd`.
 *
 * Because `review.ts` now calls `store.getTask(taskId)` at verify time, the
 * updated command takes effect even when the task was already dispatched with
 * the original command. A `set-verify` applied after dispatch is therefore not
 * a no-op — it changes what the verify step runs.
 *
 * See: orchestrator/src/tools/verify/review.ts (specVerifyCmdRaw computation).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface ArcMod {
  Arc: typeof import('../arc').Arc
}
interface QueueMod {
  migrateQueueSchema: typeof import('../queue').migrateQueueSchema
  enqueueTask: typeof import('../queue').enqueueTask
  getTask: typeof import('../queue').getTask
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-set-verify-test-'))
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadMods = async (repo: string): Promise<{ q: QueueMod; arc: ArcMod }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const queue = await import('../queue')
  await queue.migrateQueueSchema()
  const arc = await import('../arc')
  return {
    q: queue as unknown as QueueMod,
    arc: arc as unknown as ArcMod,
  }
}

describe('set-verify DB seam: updated verifyCmd is visible to store.getTask', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('reflects the updated verifyCmd in spec.verifyCmd after Arc.setVerifyCmd', async () => {
    const { q, arc } = await loadMods(repo)

    // Enqueue a task with an initial verify command.
    const task = await q.enqueueTask('Fix the queue bug.', undefined, {
      skipTriage: true,
      spec: {
        files: [],
        verifyCmd: 'cd orchestrator && npx vitest run src/core/__tests__/original.test.ts',
        doneCriteria: [],
        mergeMode: 'auto',
      },
    })

    // Confirm the initial command is stored.
    const before = await q.getTask(task.id)
    expect(before?.spec?.verifyCmd).toBe(
      'cd orchestrator && npx vitest run src/core/__tests__/original.test.ts',
    )

    // Simulate the operator running `mars task set-verify` after the task was dispatched.
    await arc.Arc.setVerifyCmd(
      task.id,
      'cd orchestrator && npx vitest run src/core/__tests__/updated.test.ts',
    )

    // The verify step reads from store.getTask — confirm the updated value is returned.
    const after = await q.getTask(task.id)
    expect(after?.spec?.verifyCmd).toBe(
      'cd orchestrator && npx vitest run src/core/__tests__/updated.test.ts',
    )
  })

  it('Arc.setVerifyCmd accepts in-flight task statuses so set-verify works during coding', async () => {
    const { q, arc } = await loadMods(repo)

    const task = await q.enqueueTask('Fix the queue bug.', undefined, {
      skipTriage: true,
      spec: {
        files: [],
        verifyCmd: 'cd orchestrator && npx vitest run src/core/__tests__/old.test.ts',
        doneCriteria: [],
        mergeMode: 'auto',
      },
    })

    // Manually move the task to 'running' (in-flight status).
    const { resolveQueueClient } = await import('../queue')
    await resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running' WHERE id = ?`,
      args: [task.id],
    })

    // set-verify must NOT reject a task in 'running' status.
    await expect(
      arc.Arc.setVerifyCmd(
        task.id,
        'cd orchestrator && npx vitest run src/core/__tests__/new.test.ts',
      ),
    ).resolves.not.toThrow()

    // The updated command is stored and readable.
    const fetched = await q.getTask(task.id)
    expect(fetched?.spec?.verifyCmd).toBe(
      'cd orchestrator && npx vitest run src/core/__tests__/new.test.ts',
    )
  })
})
