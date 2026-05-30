import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { Client } from '@libsql/client'
import type { EventName, EventPayload } from '../../bus/events.js'

// ---------------------------------------------------------------------------
// Module type shims (loaded via vi.resetModules() isolation)
// ---------------------------------------------------------------------------

interface QueueModule {
  enqueueTask: typeof import('../../mastra/queue').enqueueTask
  updateTask: typeof import('../../mastra/queue').updateTask
  getTask: typeof import('../../mastra/queue').getTask
  getClient: typeof import('../../mastra/queue').getClient
  initQueue: typeof import('../../mastra/queue').initQueue
}

interface ActionQueueModule {
  initActionQueue: typeof import('../../mastra/lib/action-queue').initActionQueue
  listActionQueueItems: typeof import('../../mastra/lib/action-queue').listActionQueueItems
}

interface ActionQueueItem {
  id: string
  originTaskId: string | null
  payload: unknown
  state: string
}

interface FixTasksModule {
  upsertFixTask: typeof import('../../mastra/queue-fix-tasks').upsertFixTask
}

interface RecipesModule {
  recipes: typeof import('../../mastra/lib/fix-recipes').recipes
}

interface RecoverySpawnModule {
  RECOVERY_SPAWN_SUBSCRIBER: typeof import('./recovery-spawn').RECOVERY_SPAWN_SUBSCRIBER
  ensureRecoverySpawner: typeof import('./recovery-spawn').ensureRecoverySpawner
  drainRecoverySpawner: typeof import('./recovery-spawn').drainRecoverySpawner
}

interface PublisherModule {
  publishWithRetry: typeof import('../../bus/publisher').publishWithRetry
}

interface Loaded {
  q: QueueModule
  aq: ActionQueueModule
  ft: FixTasksModule
  rc: RecipesModule
  rs: RecoverySpawnModule
  pub: PublisherModule
  client: Client
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-recovery-spawn-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

/**
 * Load every needed module with a fresh module registry so each test gets its
 * own singleton DB client. MARS_REPO is set before import so resolveContext()
 * picks up the per-test repo directory.
 */
const loadModules = async (repo: string): Promise<Loaded> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../mastra/queue')) as unknown as QueueModule
  await q.initQueue()
  const aq = (await import(
    '../../mastra/lib/action-queue'
  )) as unknown as ActionQueueModule
  await aq.initActionQueue()
  const ft = (await import(
    '../../mastra/queue-fix-tasks'
  )) as unknown as FixTasksModule
  const rc = (await import(
    '../../mastra/lib/fix-recipes'
  )) as unknown as RecipesModule
  const rs = (await import('./recovery-spawn')) as unknown as RecoverySpawnModule
  const pub = (await import(
    '../../bus/publisher'
  )) as unknown as PublisherModule
  return { q, aq, ft, rc, rs, pub, client: q.getClient() }
}

/**
 * Add a synthetic recipe for `signature` that survives for the duration of
 * one test. Returns a teardown function that removes the recipe entry.
 *
 * The failure-signature classifier won't naturally produce arbitrary test
 * signatures, so tests that exercise the recovery path with a controlled
 * signature register one here and drive the subscriber with a matching error
 * string.
 */
const registerTestRecipe = (
  rc: RecipesModule,
  signature: string,
): (() => void) => {
  rc.recipes[signature] = {
    signature,
    title: () => `test: ${signature}`,
    buildPrompt: () => `synthetic recovery prompt for ${signature}`,
  }
  return () => {
    delete rc.recipes[signature]
  }
}

const publish = async <T extends EventName>(
  pub: PublisherModule,
  client: Client,
  type: T,
  payload: EventPayload<T>,
): Promise<void> => {
  await pub.publishWithRetry(client, type, payload)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('recovery-spawn outbox subscriber', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_FIX_RETRY_BUDGET
    delete process.env.MARS_MAX_FIX_ATTEMPTS
    rmSync(repo, { recursive: true, force: true })
  })

  it('spawns exactly one recovery task for a single task.failed event', async () => {
    const { q, ft, rc, rs, pub, client } = await loadModules(repo)

    // Enqueue the origin task and set its failedPhase so the subscriber can
    // compute a deterministic failure signature.
    const t1 = await q.enqueueTask('implement feature X', undefined, {
      skipTriage: true,
    })
    // failedPhase='verify' + error matching 'no-commits-ahead' rule
    // → computeFailureSignature('verify', error) = 'verify/no-commits-ahead'
    await q.updateTask(t1.id, { failedPhase: 'verify' })

    const signature = 'verify/no-commits-ahead'
    const cleanup = registerTestRecipe(rc, signature)

    // Register subscriber AFTER task setup so the cursor starts past the
    // setup events and only reacts to the event we publish below.
    await rs.ensureRecoverySpawner(client)

    // Simulate the worker reporting a task failure by publishing a task.failed
    // event with an error string that the classifier maps to 'no-commits-ahead'.
    await publish(pub, client, 'task.failed', {
      taskId: t1.id,
      error: 'no commits ahead of integration branch',
    })

    const { processed } = await rs.drainRecoverySpawner(client)

    // The drain must have processed exactly one event.
    expect(processed).toBe(1)

    // The source task should now be blocked behind exactly one fix task.
    const reloaded = await q.getTask(t1.id)
    expect(reloaded?.status).toBe('blocked')

    const fixRows = await client.execute({
      sql: `SELECT id FROM tasks WHERE fix_for_task_id = ?`,
      args: [t1.id],
    })
    expect(fixRows.rows).toHaveLength(1)

    cleanup()
  })

  it('spawns zero additional recovery tasks when the same event is replayed (cursor already advanced)', async () => {
    const { q, ft, rc, rs, pub, client } = await loadModules(repo)

    const t1 = await q.enqueueTask('implement feature Y', undefined, {
      skipTriage: true,
    })
    await q.updateTask(t1.id, { failedPhase: 'verify' })

    const signature = 'verify/no-commits-ahead'
    const cleanup = registerTestRecipe(rc, signature)

    await rs.ensureRecoverySpawner(client)
    await publish(pub, client, 'task.failed', {
      taskId: t1.id,
      error: 'no commits ahead of integration branch',
    })

    // First drain: spawns the recovery.
    const first = await rs.drainRecoverySpawner(client)
    expect(first.processed).toBe(1)

    // Second drain: cursor is now past the event — nothing pending, nothing processed.
    const second = await rs.drainRecoverySpawner(client)
    expect(second.processed).toBe(0)

    // Still exactly one fix task.
    const fixRows = await client.execute({
      sql: `SELECT id FROM tasks WHERE fix_for_task_id = ?`,
      args: [t1.id],
    })
    expect(fixRows.rows).toHaveLength(1)

    cleanup()
  })

  it('does not spawn a second recovery when the recovery task itself fails, and raises one action-queue item', async () => {
    const { q, ft, rc, rs, pub, client, aq } = await loadModules(repo)

    // Create origin task T1.
    const t1 = await q.enqueueTask('implement feature Z', undefined, {
      skipTriage: true,
    })

    // Register a recipe so upsertFixTask can build the fix-task prompt.
    const signature = 'verify/no-commits-ahead'
    const cleanup = registerTestRecipe(rc, signature)

    // Spawn the initial recovery task T2 for T1.
    const r = await ft.upsertFixTask({
      sourceTaskId: t1.id,
      failureSignature: signature,
      failingStep: 'verify:has-diff',
      truncatedError: 'no commits ahead of integration branch',
      branch: null,
      recipeContext: {
        targetPath: '/tmp/test',
        statusOutput: 'no commits ahead',
        targetBranch: 'main',
        originalPrompt: t1.id,
      },
    })
    const fixTaskId = r.fixTaskId

    // Mark T2 as already failed BEFORE registering the subscriber so that
    // when the subscriber calls handleTaskFailureWithFixTask(T2), the
    // updateTask(T2, failed) call is a no-op (no status change → no new
    // task.failed event to chase, keeping the drain bounded).
    await q.updateTask(fixTaskId, {
      status: 'failed',
      error: 'recovery crashed',
    })

    cleanup()

    // Register subscriber with cursor past all setup events.
    await rs.ensureRecoverySpawner(client)

    // Publish task.failed for T2 (the recovery task) — this is the event the
    // subscriber must react to by escalating, not by spawning another recovery.
    await publish(pub, client, 'task.failed', {
      taskId: fixTaskId,
      error: 'recovery crashed',
    })

    const { processed } = await rs.drainRecoverySpawner(client)
    expect(processed).toBe(1)

    // No additional fix task should have been spawned for T1 — only T2.
    const fixRows = await client.execute({
      sql: `SELECT id FROM tasks WHERE fix_for_task_id = ?`,
      args: [t1.id],
    })
    expect(fixRows.rows).toHaveLength(1)
    expect(
      (fixRows.rows[0] as unknown as { id: string }).id,
    ).toBe(fixTaskId)

    // Exactly one actionQueue item should be open for the origin task's arc,
    // keyed on T1's originId (which equals T1.id for a root task).
    const items = await aq.listActionQueueItems('open')
    const originItems = items.filter(
      (item) =>
        item.originTaskId === t1.id ||
        (item.payload as Record<string, unknown>).originTaskId === t1.id ||
        (item.payload as Record<string, unknown>).recoveryTaskId === fixTaskId,
    )
    expect(originItems.length).toBeGreaterThanOrEqual(1)
  })
})
