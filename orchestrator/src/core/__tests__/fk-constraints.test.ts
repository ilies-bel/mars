import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-fk-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

describe('FK constraints: self_heal_attempts.fix_task_id', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('rejects a self_heal_attempts row whose fix_task_id does not exist in tasks', async () => {
    const { migrateQueueSchema, resolveQueueClient } = await import('../queue')
    await migrateQueueSchema()
    const c = resolveQueueClient()
    const now = new Date().toISOString()

    // Attempt to insert a self_heal_attempts row referencing a non-existent task.
    // The FK constraint on fix_task_id must cause this to fail.
    await expect(
      c.execute({
        sql: `INSERT INTO self_heal_attempts
                (parent_task_id, failure_signature, fix_task_id, created_at)
              VALUES (?, ?, ?, ?)`,
        args: ['mars-parent-00', 'sig-xyz', 'mars-nonexistent', now],
      }),
    ).rejects.toThrow()
  })

  it('allows a self_heal_attempts row when fix_task_id exists in tasks', async () => {
    const { migrateQueueSchema, resolveQueueClient, enqueueTask } =
      await import('../queue')
    await migrateQueueSchema()
    const task = await enqueueTask('fix something', undefined, {
      skipTriage: true,
    })
    const c = resolveQueueClient()
    const now = new Date().toISOString()

    // This should succeed since fix_task_id references an existing task.
    await expect(
      c.execute({
        sql: `INSERT INTO self_heal_attempts
                (parent_task_id, failure_signature, fix_task_id, created_at)
              VALUES (?, ?, ?, ?)`,
        args: ['mars-parent-01', 'sig-abc', task.id, now],
      }),
    ).resolves.not.toThrow()
  })
})
