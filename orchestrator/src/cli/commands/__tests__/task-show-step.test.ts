/**
 * Tests for the `step:` block in `mars task show` output (slice mars-9d53a245).
 *
 * Covers:
 *   1. Text output includes a `step:` block with name, mode=manual, and
 *      guide when `currentStepName` is set on the task.
 *   2. Text output omits the `step:` block when `currentStepName` is null.
 *   3. JSON output includes `current_step_name`, `current_step_mode`, and
 *      `current_step_guide` as snake_case fields.
 *   4. JSON output has null step fields when no step is set.
 *
 * Uses the in-process command seam (ADR-0023) with a recording fake daemon so
 * tests assert on CLI behaviour without spawning a real daemon.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  runCommandInProcess,
  makeFakeDaemon,
  type InProcessOptions,
} from '../../test-adapter'
import type { DomainTaskStore } from '../../../core/store/task-store'
import type { OrchestratorContext } from '../../../core/context'

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-task-show-step-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

const loadStoreAndCtx = async (): Promise<{
  store: DomainTaskStore
  ctx: OrchestratorContext
}> => {
  const queueModule = await import('../../../core/queue')
  await queueModule.migrateQueueSchema()
  const storeModule = await import('../../../core/store/task-store')
  const contextModule = await import('../../../core/context')
  return {
    store: storeModule.createTaskStore(queueModule.resolveQueueClient()),
    ctx: contextModule.resolveContext(repo),
  }
}

const baseOpts = async (): Promise<InProcessOptions> => {
  const fake = makeFakeDaemon()
  const { store, ctx } = await loadStoreAndCtx()
  return { store, ctx, daemon: fake }
}

/**
 * Create a task and optionally set currentStepName / currentStepGuide via
 * updateTask (test-setup only — bypasses Arc per the test-setup exemption).
 */
const createTaskWithStep = async (
  stepName: string | null,
  stepGuide: string | null,
): Promise<string> => {
  const { enqueueTask, updateTask } = await import('../../../core/queue')
  const task = await enqueueTask('test show-step task', undefined, {
    skipTriage: true,
  })
  await updateTask(task.id, {
    status: 'awaiting-human',
    leaseOwner: 'test-user',
    leasedAt: new Date().toISOString(),
    currentStepName: stepName,
    currentStepGuide: stepGuide,
  })
  return task.id
}

beforeEach(() => {
  repo = setupRepo()
  vi.resetModules()
  process.env.MARS_REPO = repo
})

afterEach(() => {
  delete process.env.MARS_REPO
  vi.restoreAllMocks()
  rmSync(repo, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Text output — step: block
// ---------------------------------------------------------------------------

describe('mars task show — step block in text output', () => {
  it('prints step: block with name and mode=manual when step is set', async () => {
    const taskId = await createTaskWithStep('verify-output', 'Run the smoke tests')
    const opts = await baseOpts()

    const r = await runCommandInProcess(['task', 'show', taskId], opts)

    expect(r.code).toBe(0)
    const output = r.out.join('\n')
    expect(output).toContain('step:')
    expect(output).toContain('verify-output')
    expect(output).toContain('manual')
  })

  it('prints the guide line when guide is set', async () => {
    const guide = 'Push to staging, then validate the UI.'
    const taskId = await createTaskWithStep('deploy-review', guide)
    const opts = await baseOpts()

    const r = await runCommandInProcess(['task', 'show', taskId], opts)

    expect(r.code).toBe(0)
    const output = r.out.join('\n')
    expect(output).toContain('guide:')
    expect(output).toContain(guide)
  })

  it('omits the step: block when currentStepName is null', async () => {
    const taskId = await createTaskWithStep(null, null)
    const opts = await baseOpts()

    const r = await runCommandInProcess(['task', 'show', taskId], opts)

    expect(r.code).toBe(0)
    const output = r.out.join('\n')
    expect(output).not.toContain('step:')
  })
})

// ---------------------------------------------------------------------------
// JSON output — snake_case step fields
// ---------------------------------------------------------------------------

describe('mars task show --json — step fields', () => {
  it('includes current_step_name, current_step_mode, current_step_guide', async () => {
    const guide = 'Approve the pull request.'
    const taskId = await createTaskWithStep('review-pr', guide)
    const opts = await baseOpts()

    const r = await runCommandInProcess(['task', 'show', taskId, '--json'], opts)

    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.out[0] ?? '{}') as Record<string, unknown>
    expect(parsed.current_step_name).toBe('review-pr')
    expect(parsed.current_step_mode).toBe('manual')
    expect(parsed.current_step_guide).toBe(guide)
  })

  it('has null step fields in JSON output when no step is set', async () => {
    const taskId = await createTaskWithStep(null, null)
    const opts = await baseOpts()

    const r = await runCommandInProcess(['task', 'show', taskId, '--json'], opts)

    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.out[0] ?? '{}') as Record<string, unknown>
    expect(parsed.current_step_name).toBeNull()
    expect(parsed.current_step_mode).toBeNull()
    expect(parsed.current_step_guide).toBeNull()
  })
})
