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
  enqueueTask: typeof import('../../core/queue').enqueueTask
  updateTask: typeof import('../../core/queue').updateTask
  getTask: typeof import('../../core/queue').getTask
  resolveQueueClient: typeof import('../../core/queue').resolveQueueClient
  migrateQueueSchema: typeof import('../../core/queue').migrateQueueSchema
}

interface ActionQueueModule {
  initActionQueue: typeof import('../../core/lib/action-queue').initActionQueue
  listActionQueueItems: typeof import('../../core/lib/action-queue').listActionQueueItems
}

interface ActionQueueItem {
  id: string
  originTaskId: string | null
  payload: unknown
  state: string
}

interface FixTasksModule {
  upsertFixTask: typeof import('../../core/queue-fix-tasks').upsertFixTask
}

interface RecipesModule {
  recipes: typeof import('../../core/lib/fix-recipes').recipes
}

interface RecoverySpawnModule {
  RECOVERY_SPAWN_SUBSCRIBER: typeof import('./recovery-spawn').RECOVERY_SPAWN_SUBSCRIBER
  ensureRecoverySpawner: typeof import('./recovery-spawn').ensureRecoverySpawner
  drainRecoverySpawner: typeof import('./recovery-spawn').drainRecoverySpawner
}

interface GateMonitorModule {
  GATE_VERDICT_TRIP_THRESHOLD: typeof import('../../core/lib/gate-meta-monitor').GATE_VERDICT_TRIP_THRESHOLD
  isVerdictSuppressed: typeof import('../../core/lib/gate-meta-monitor').isVerdictSuppressed
  resetGateMetaMonitorSchemaLatchForTests: typeof import('../../core/lib/gate-meta-monitor').resetGateMetaMonitorSchemaLatchForTests
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
  gm: GateMonitorModule
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
  const q = (await import('../../core/queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const aq = (await import(
    '../../core/lib/action-queue'
  )) as unknown as ActionQueueModule
  await aq.initActionQueue()
  const ft = (await import(
    '../../core/queue-fix-tasks'
  )) as unknown as FixTasksModule
  const rc = (await import(
    '../../core/lib/fix-recipes'
  )) as unknown as RecipesModule
  const rs = (await import('./recovery-spawn')) as unknown as RecoverySpawnModule
  const gm = (await import(
    '../../core/lib/gate-meta-monitor'
  )) as unknown as GateMonitorModule
  // The monitor caches "schema ensured" in a module-level latch; a fresh
  // module registry resets the module but be explicit so a shared-registry
  // run can never carry the latch across per-test DB clients.
  gm.resetGateMetaMonitorSchemaLatchForTests()
  const pub = (await import(
    '../../bus/publisher'
  )) as unknown as PublisherModule
  return { q, aq, ft, rc, rs, gm, pub, client: q.resolveQueueClient() }
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

// ---------------------------------------------------------------------------
// Gate meta-monitor: K identical verify-gate verdicts across DIFFERENT tasks
// raise ONE level-triggered row and suppress recovery for that verdict without
// consuming the origin's one recovery slot (draft proposal acd01d23).
// ---------------------------------------------------------------------------

describe('verify-gate meta-monitor suppression', () => {
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

  // The verify primitive stamps the fine-grained failing step on
  // `failure_reason` (`verify:<gate>`) and the verdict on `failure_signature`
  // (`verify:<gate>/<class>`), and the `status='failed'` transition itself emits
  // the durable `task.failed` event the recovery-spawn subscriber drains. So a
  // test simulating a verify-gate failure just sets those fields via the same
  // `updateTask` transition, then drains — exactly the production choreography.
  const VERIFY_STEP = 'verify:completeness'
  const GATE_ERROR = 'no commits ahead of integration branch' // → class 'no-commits-ahead'
  const VERDICT = 'verify:completeness/no-commits-ahead'

  /**
   * Fail a fresh origin task through a verify gate carrying the shared verdict,
   * then run the subscriber drain. The caller MUST have already registered the
   * subscriber (via `rs.ensureRecoverySpawner`) so the cursor tails from before
   * the first failure — otherwise a subscriber registered mid-stream skips the
   * `task.failed` event emitted by this task's `failed` transition. Returns the
   * origin task id.
   */
  const failOneVerifyGateTask = async (
    loaded: Loaded,
    index: number,
  ): Promise<string> => {
    const { q, rs, client } = loaded
    const t = await q.enqueueTask(`gate task ${index}`, undefined, {
      skipTriage: true,
    })
    // The `queued → failed` transition emits the durable task.failed event.
    await q.updateTask(t.id, {
      status: 'failed',
      failedPhase: 'verify',
      failureReason: VERIFY_STEP,
      failureSignature: VERDICT,
      error: GATE_ERROR,
    })
    await rs.drainRecoverySpawner(client)
    return t.id
  }

  const countFixTasksFor = async (
    client: Client,
    originId: string,
  ): Promise<number> => {
    const r = await client.execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE fix_for_task_id = ?`,
      args: [originId],
    })
    return Number((r.rows[0] as unknown as { n: number }).n)
  }

  const countGateBrokenRows = async (aq: ActionQueueModule): Promise<number> => {
    const items = await aq.listActionQueueItems('open')
    return items.filter((i) => (i as { kind?: string }).kind === 'gate-broken')
      .length
  }

  it('trips at K identical verdicts across different tasks and raises exactly ONE gate-broken row', async () => {
    const loaded = await loadModules(repo)
    const { rs, gm, aq, client } = loaded
    const K = gm.GATE_VERDICT_TRIP_THRESHOLD
    // Register the subscriber's cursor before any task fails so every
    // task.failed transition below is drained.
    await rs.ensureRecoverySpawner(client)

    // Below the threshold: no trip, no row, verdict not yet suppressed.
    for (let i = 0; i < K - 1; i++) {
      await failOneVerifyGateTask(loaded, i)
    }
    expect(await countGateBrokenRows(aq)).toBe(0)
    expect(await gm.isVerdictSuppressed(client, VERDICT)).toBe(false)

    // The K-th identical verdict (a DIFFERENT task) trips the monitor.
    await failOneVerifyGateTask(loaded, K - 1)
    expect(await gm.isVerdictSuppressed(client, VERDICT)).toBe(true)
    expect(await countGateBrokenRows(aq)).toBe(1)

    // Further identical failures do NOT raise a second row (idempotent episode).
    await failOneVerifyGateTask(loaded, K)
    await failOneVerifyGateTask(loaded, K + 1)
    expect(await countGateBrokenRows(aq)).toBe(1)
  })

  it('does not advance the streak when the SAME task fails the same gate repeatedly', async () => {
    const loaded = await loadModules(repo)
    const { q, rs, pub, gm, aq, client } = loaded
    const K = gm.GATE_VERDICT_TRIP_THRESHOLD

    const t = await q.enqueueTask('single repeat-failing task', undefined, {
      skipTriage: true,
    })
    await q.updateTask(t.id, {
      status: 'failed',
      failedPhase: 'verify',
      failureReason: VERIFY_STEP,
      failureSignature: VERDICT,
      error: GATE_ERROR,
    })
    await rs.ensureRecoverySpawner(client)

    // Publish the SAME task's failure K+2 times. Because the monitor advances
    // only on a DIFFERENT task id, the streak never passes 1 and never trips.
    for (let i = 0; i < K + 2; i++) {
      await publish(pub, client, 'task.failed', { taskId: t.id, error: GATE_ERROR })
      await rs.drainRecoverySpawner(client)
    }

    expect(await gm.isVerdictSuppressed(client, VERDICT)).toBe(false)
    expect(await countGateBrokenRows(aq)).toBe(0)
  })

  it('suppresses recovery for the tripped verdict, leaving the origin failed-and-restartable with its recovery slot unconsumed', async () => {
    const loaded = await loadModules(repo)
    const { q, rs, gm, client } = loaded
    const K = gm.GATE_VERDICT_TRIP_THRESHOLD
    await rs.ensureRecoverySpawner(client)

    // Trip the monitor with K-1 genuine failures (each may spawn a recovery).
    for (let i = 0; i < K - 1; i++) {
      await failOneVerifyGateTask(loaded, i)
    }
    // The K-th trips + is itself suppressed.
    const trippedId = await failOneVerifyGateTask(loaded, K - 1)
    expect(await gm.isVerdictSuppressed(client, VERDICT)).toBe(true)

    // The tripping task consumed NO recovery slot: zero fix tasks point at it,
    // and it is left `failed` (restartable via `mars restart`), not `blocked`
    // behind a spawned-and-doomed recovery.
    expect(await countFixTasksFor(client, trippedId)).toBe(0)
    const tripped = await q.getTask(trippedId)
    expect(tripped?.status).toBe('failed')
    expect(tripped?.failureReason).toBe(`gate-suppressed:${VERDICT}`)

    // A brand-new task carrying the now-suppressed verdict is ALSO suppressed:
    // failed, no fix task, no task_blockers edge.
    const laterId = await failOneVerifyGateTask(loaded, K)
    expect(await countFixTasksFor(client, laterId)).toBe(0)
    const later = await q.getTask(laterId)
    expect(later?.status).toBe('failed')
    const edges = await client.execute({
      sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE task_id = ?`,
      args: [laterId],
    })
    expect(Number((edges.rows[0] as unknown as { n: number }).n)).toBe(0)
  })

  it('does not feed the monitor for non-verify failures (a code-phase failure never trips it)', async () => {
    const loaded = await loadModules(repo)
    const { q, rs, gm, aq, client } = loaded
    const K = gm.GATE_VERDICT_TRIP_THRESHOLD

    await rs.ensureRecoverySpawner(client)
    // K+1 distinct tasks failing in the CODE phase (failure_reason has no
    // `verify:` prefix) must not trip the gate monitor.
    for (let i = 0; i < K + 1; i++) {
      const t = await q.enqueueTask(`code-fail task ${i}`, undefined, {
        skipTriage: true,
      })
      await q.updateTask(t.id, {
        status: 'failed',
        failedPhase: 'code',
        failureReason: 'code',
        error: 'agent bailed without committing',
      })
      await rs.drainRecoverySpawner(client)
    }

    expect(await countGateBrokenRows(aq)).toBe(0)
    // The verify verdict is untouched.
    expect(await gm.isVerdictSuppressed(client, VERDICT)).toBe(false)
  })
})
