/**
 * Regression test for the `--supersede` settlement bug (observed on task
 * mars-6340b827, 2026-08-19): a task created with `--supersede <id>` was
 * meant to settle the superseded origin to a terminal status so it stops
 * raising a `failed` action-queue alert. `Arc.createOrigin`'s supersede
 * preamble already marked the origin `'dropped'`, but the daemon's `add` RPC
 * handler (`handleAdd` / `addHandler`) never forwarded `req.supersedes`
 * through to `enqueueTask`, so the preamble never ran for real requests and
 * the origin was stranded in `'failed'` forever.
 *
 * This test exercises the domain layer end-to-end (enqueueTask with
 * opts.supersedes, the same call the fixed RPC wiring now makes) and asserts
 * both halves of the done criterion: the origin reaches a settled status,
 * and `deriveFailedConditions` (via `createConditionItemsSource`) no longer
 * returns a row for it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { SETTLED_BLOCKER_STATUSES } from '../../queue'
import { createConditionItemsSource } from '../view/derived-conditions'

interface QueueModule {
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  enqueueTask: typeof import('../../queue').enqueueTask
  getTask: typeof import('../../queue').getTask
  updateTask: typeof import('../../queue').updateTask
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-supersede-settle-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  writeFileSync(resolve(repo, 'README.md'), 'init\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
  return repo
}

describe('supersede settles the origin', () => {
  let repo: string

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('reaches a settled status and stops deriving a failed condition', async () => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    const q = (await import('../../queue')) as unknown as QueueModule
    await q.migrateQueueSchema()

    const origin = await q.enqueueTask('original attempt', undefined, { skipTriage: true })
    await q.updateTask(origin.id, { status: 'failed', error: 'recovery exhausted' })
    expect((await q.getTask(origin.id))?.status).toBe('failed')

    // Same call the fixed `handleAdd`/`addHandler` wiring now makes.
    await q.enqueueTask('continuation of failed arc', undefined, {
      skipTriage: true,
      supersedes: origin.id,
    })

    const settled = await q.getTask(origin.id)
    expect(settled?.status).toBe('dropped')
    expect(SETTLED_BLOCKER_STATUSES.has('dropped')).toBe(true)

    const source = createConditionItemsSource({ getClient: () => q.resolveQueueClient() })
    const rows = await source.derive({ kinds: new Set(['failed']) })
    expect(rows.find((r) => (r.payload as { taskId?: string })?.taskId === origin.id)).toBeUndefined()
  })
})
