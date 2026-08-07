/**
 * Failure-evidence invariant: a row that lands in `failed` must carry a usable
 * `error` and a non-NULL `failure_signature`.
 *
 * The whole self-heal chain keys off `failure_signature` — fix-recipe matching,
 * the signature-storm streak counter, the Steward's evidence brief,
 * `isEnvironmentalSignature` auto-restart — and every one of them skips a NULL.
 *
 * The live regression these tests pin (task mars-76fef59f, 2026-08-01): the
 * verify primitive stamped the real typecheck output and a precise signature,
 * the recovery-spawner then called `reopenTerminalTask` (which NULLs `error`,
 * `failure_reason`, `failure_signature` and `failure_reason_code` in the same
 * transaction as the re-queue), and the recovery-exhausted branch landed the
 * row terminal again through `markTaskFailed` — which wrote only the two reason
 * columns. Net result: `status=failed`, `failed_phase=verify`, `error=NULL`,
 * `failure_signature=NULL`, with the reason sitting in `.mars/watch.log`.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { assessStormExcerpt } from '../../agents/steward'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  updateTask: typeof import('../../queue').updateTask
  getTask: typeof import('../../queue').getTask
  reopenTerminalTask: typeof import('../../queue').reopenTerminalTask
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
}

interface FixTasksModule {
  handleTaskFailureWithFixTask: typeof import('../../queue-fix-tasks').handleTaskFailureWithFixTask
}

interface RetryModule {
  markTaskFailed: typeof import('../../queue-retry').markTaskFailed
}

/** Real captured verify output — long and specific, i.e. usable evidence. */
const VERIFY_OUTPUT = [
  'typecheck:',
  '',
  '> @mars/ui@0.1.0 typecheck',
  '> tsc --noEmit && tsc -p tsconfig.server.json --noEmit',
  '',
  "server/actionQueue.test.ts(712,24): error TS2339: Property 'staleQueued' does not exist on type 'ActionQueueRow'.",
  "server/actionQueue.test.ts(741,11): error TS2339: Property 'staleQueued' does not exist on type 'ActionQueueRow'.",
].join('\n')

/** What the re-failure loop feeds back in: derived status text, no diagnostics. */
const STATUS_ECHO = 'recovery_exhausted:verify/unclassified'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-failure-evidence-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

let templateRepo: string

const TEMPLATE_DB_FILES = ['queue.db', 'state.db'] as const

const cloneTemplateDbs = (destRepo: string): void => {
  for (const file of TEMPLATE_DB_FILES) {
    const src = resolve(templateRepo, '.mars', file)
    if (!existsSync(src)) continue
    copyFileSync(src, resolve(destRepo, '.mars', file))
  }
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; ft: FixTasksModule; qr: RetryModule }> => {
  try {
    const { closeAllDbs } = await import('../db')
    await closeAllDbs()
  } catch {
    // Non-fatal: first invocation or already-crashed instance.
  }
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const ft = (await import('../../queue-fix-tasks')) as unknown as FixTasksModule
  const qr = (await import('../../queue-retry')) as unknown as RetryModule
  return { q, ft, qr }
}

describe('failure evidence', () => {
  let repo: string

  beforeAll(async () => {
    templateRepo = setupRepo()
    vi.resetModules()
    process.env.MARS_REPO = templateRepo
    const q = (await import('../../queue')) as unknown as QueueModule
    await q.migrateQueueSchema()
    const actionQueue = (await import('../action-queue')) as unknown as {
      initActionQueue: typeof import('../action-queue').initActionQueue
    }
    await actionQueue.initActionQueue()
    delete process.env.MARS_REPO
    const { closeAllDbs } = await import('../db')
    await closeAllDbs()
    vi.resetModules()
  })

  afterAll(() => {
    rmSync(templateRepo, { recursive: true, force: true })
  })

  beforeEach(() => {
    repo = setupRepo()
    cloneTemplateDbs(repo)
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_FIX_RETRY_BUDGET
    delete process.env.MARS_SIGNATURE_STORM_THRESHOLD
    rmSync(repo, { recursive: true, force: true })
  })

  it('a verify failure that exhausts recovery after a reopen still persists error and failure_signature', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '0'
    process.env.MARS_SIGNATURE_STORM_THRESHOLD = '99'
    const { q, ft } = await loadModules(repo)
    const t = await q.enqueueTask('make the UI compile', undefined, {
      skipTriage: true,
    })

    // 1. The verify primitive's own failure stamp — evidence is on the row.
    await q.updateTask(t.id, {
      status: 'failed',
      error: VERIFY_OUTPUT,
      failedPhase: 'verify',
      failureReason: 'verify:typecheck',
      failureSignature: 'verify:typecheck/typecheck-property-missing',
      failureReasonCode: 'verify:typecheck/typecheck-property-missing',
      recoverySpawnedCount: 1,
    })

    // 2. The recovery-spawner reopens the row before handing it to the failure
    //    handler. The reopen NULLs every failure column.
    await q.reopenTerminalTask(t.id, 'recovery-spawner')
    const cleared = await q.getTask(t.id)
    expect(cleared?.status).toBe('queued')
    expect(cleared?.error).toBeNull()
    expect(cleared?.failureSignature).toBeNull()

    // 3. recovery_spawned_count (1) > budget (0): the recovery-exhausted branch lands the
    //    row terminal through `markTaskFailed`.
    const r = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: VERIFY_OUTPUT,
      branch: 'task/x',
    })
    expect(r.outcome).toBe('failed')

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('failed')
    // The signature is what every self-heal consumer keys on.
    expect(reloaded?.failureSignature).toBeTruthy()
    expect(reloaded?.failureSignature).toContain('/')
    // `error` must carry the real captured output, not a restatement of the
    // reason — the Steward's evidence guard has to accept it.
    expect(reloaded?.error).toContain('TS2339')
    expect(assessStormExcerpt(reloaded?.error).usable).toBe(true)
    // The reason column keeps its status-echo form; the two do not collide.
    expect(reloaded?.failureReason).toContain('recovery_exhausted:')
  })

  it('a status-echo re-failure never overwrites captured output already on the row', async () => {
    const { q, qr } = await loadModules(repo)
    const t = await q.enqueueTask('make the UI compile', undefined, {
      skipTriage: true,
    })
    await q.updateTask(t.id, {
      status: 'failed',
      error: VERIFY_OUTPUT,
      failedPhase: 'verify',
      failureReason: 'verify:typecheck',
      failureSignature: 'verify:typecheck/typecheck-property-missing',
    })

    // The 30s re-failure loop feeds its own previous reason back in. That text
    // is padding: it must never displace the captured output.
    await qr.markTaskFailed(t.id, STATUS_ECHO, undefined, { error: STATUS_ECHO })

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.error).toBe(VERIFY_OUTPUT)
    expect(assessStormExcerpt(reloaded?.error).usable).toBe(true)
    // A precise signature already on the row is never downgraded either.
    expect(reloaded?.failureSignature).toBe(
      'verify:typecheck/typecheck-property-missing',
    )
  })

  it('markTaskFailed on a row cleared by mars restart re-records both columns', async () => {
    const { q, qr } = await loadModules(repo)
    const t = await q.enqueueTask('make the UI compile', undefined, {
      skipTriage: true,
    })

    // `mars restart` clears status/error/failure_* and re-queues.
    await q.updateTask(t.id, { status: 'failed', error: VERIFY_OUTPUT })
    await q.reopenTerminalTask(t.id, 'mars restart')
    await q.updateTask(t.id, {
      status: 'queued',
      error: null,
      failedPhase: null,
      failureSignature: null,
      failureReasonCode: null,
    })

    await qr.markTaskFailed(t.id, 'recovery_exhausted:verify:typecheck/x', undefined, {
      error: VERIFY_OUTPUT,
      failureSignature: 'verify:typecheck/typecheck-property-missing',
    })

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('failed')
    expect(reloaded?.error).toBe(VERIFY_OUTPUT)
    expect(reloaded?.failureSignature).toBe(
      'verify:typecheck/typecheck-property-missing',
    )
  })

  it('a code-phase failure write that omits failureSignature still lands a signature', async () => {
    const { q } = await loadModules(repo)
    const t = await q.enqueueTask('make the UI compile', undefined, {
      skipTriage: true,
    })

    // Shape of the pre-fix `coder-exit-nonzero` write: error + reason code, no
    // signature. The floor in `updateTask` derives one.
    await q.updateTask(t.id, {
      status: 'failed',
      error: 'coder exited 1 before completing; provider stream ended',
      failedPhase: 'code',
      failureReason: 'coder-exit-nonzero',
      failureReasonCode: 'coder-exit-nonzero',
    })

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.failureSignature).toBeTruthy()
    expect(reloaded?.failureSignature?.startsWith('coder-exit-nonzero/')).toBe(true)
  })
})
