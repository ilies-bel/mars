/**
 * Regression: deleting a task must close every stored action-queue row that
 * *names* it.
 *
 * Two rows observed open on 2026-08-20 pointed at tasks that no longer
 * existed (`fix-d612292d`, `mars-6340b827`). Opening either gave the operator
 * "not found". They survived deletion because `resolveAllRowsForTask` matches
 * only `origin_task_id`, `payload.taskId`, and a `failed`-only signature arm —
 * and neither row was shaped that way:
 *
 *   - an agent-raised escalation stamps the raising task into `raised_by`
 *     (bare, or as `agent:recovery:<id>`) and carries no `origin_task_id`;
 *   - a `gate-enrichment` row names its task under `originTaskId`, not
 *     `taskId`.
 *
 * Per ADR-0057 an operator-decision row is stored, so it has to be closed by
 * the same mutation that makes it unresolvable. `resolveRowsNamingDeletedTask`
 * runs inside the delete path and matches on `raised_by` plus *any* top-level
 * payload value, so it does not have to guess key names — guessing key names
 * is the coupling that produced this defect class in the first place.
 *
 * DB setup is done ONCE in `beforeAll` (PGlite cold start is ~5-10 s).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

let repo: string
let q: typeof import('../queue')
let actionQueue: typeof import('../lib/action-queue')

beforeAll(async () => {
  repo = mkdtempSync(resolve(tmpdir(), 'mars-drop-closes-aq-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })

  vi.resetModules()
  process.env.MARS_REPO = repo
  q = await import('../queue')
  await q.migrateQueueSchema()
  actionQueue = await import('../lib/action-queue')
  await actionQueue.initActionQueue()
})

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('deleting a task closes stored action-queue rows naming it', () => {
  it('closes an agent-raised escalation stamped only in raised_by', async () => {
    const task = await q.enqueueTask('spurious recovery', undefined, { skipTriage: true })

    // Exactly the shape of the row observed for fix-d612292d: raised by the
    // task itself through `mars action-queue raise`, empty payload, no
    // originTaskId, signature that merely embeds the id.
    const itemId = await actionQueue.raiseActionQueueItem({
      kind: 'awaiting-human',
      category: 'orchestrator',
      priority: 'normal',
      title: `Spurious recovery ${task.id}: arc already done`,
      body: 'Nothing to recover.',
      payload: { situation: 'escalation' },
      context: {},
      raisedBy: task.id,
      signature: `spurious-recovery/${task.id}`,
    })
    expect((await actionQueue.getActionQueueItem(itemId))?.status).toBe('open')

    await q.dropTask(task.id)

    expect((await actionQueue.getActionQueueItem(itemId))?.status).toBe('resolved')
  })

  it('closes a row whose raised_by is a qualified agent id', async () => {
    const task = await q.enqueueTask('recovery no-op', undefined, { skipTriage: true })

    const itemId = await actionQueue.raiseActionQueueItem({
      kind: 'awaiting-human',
      category: 'orchestrator',
      priority: 'normal',
      title: `Recovery ${task.id}: nothing to recover`,
      body: 'Origin arc already succeeded.',
      payload: { situation: 'escalation' },
      context: {},
      raisedBy: `agent:recovery:${task.id}`,
      signature: `recovery-noop/${task.id}`,
    })

    await q.dropTask(task.id)

    expect((await actionQueue.getActionQueueItem(itemId))?.status).toBe('resolved')
  })

  it('closes a row that names the task under a payload key other than taskId', async () => {
    const task = await q.enqueueTask('gate enrichment origin', undefined, { skipTriage: true })

    const itemId = await actionQueue.raiseActionQueueItem({
      kind: 'gate-enrichment',
      category: 'orchestrator',
      priority: 'normal',
      title: 'Approve or retire candidate check',
      body: 'body',
      payload: {
        signature: 'verify:build/typecheck-error',
        encodableFamily: 'command',
        originTaskId: task.id,
        failingStep: 'verify:build',
        writerTaskId: null,
        stepSpec: null,
      },
      context: {},
      raisedBy: 'daemon:gate-enrichment',
      signature: 'gate-enrichment:verify:build/typecheck-error',
    })

    await q.dropTask(task.id)

    expect((await actionQueue.getActionQueueItem(itemId))?.status).toBe('resolved')
  })

  it('leaves rows naming a different task open', async () => {
    const kept = await q.enqueueTask('kept', undefined, { skipTriage: true })
    const deleted = await q.enqueueTask('deleted', undefined, { skipTriage: true })

    const keptItem = await actionQueue.raiseActionQueueItem({
      kind: 'awaiting-human',
      category: 'orchestrator',
      priority: 'normal',
      title: `Escalation for ${kept.id}`,
      body: 'body',
      payload: { situation: 'escalation', subject: kept.id },
      context: {},
      raisedBy: kept.id,
      signature: `escalation/${kept.id}`,
    })

    await q.dropTask(deleted.id)

    expect((await actionQueue.getActionQueueItem(keptItem))?.status).toBe('open')
  })
})
