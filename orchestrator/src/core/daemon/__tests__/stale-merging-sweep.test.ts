/**
 * Tests for the stale-merging-sweep's active-job guard (introduced after the
 * 2026-09-04 eviction incident where the sweep wrongly evicted 10 tasks that
 * were queued behind a legitimately running merge).
 *
 * Key invariant: a 'merging' task whose updated_at exceeds the stale threshold
 * is only recovered when it has NO active (queued/claimed/running) merge job.
 * If it does have a live merge job it is merely waiting its turn, and the sweep
 * must log "waiting in merge queue" and skip it.
 *
 * Strategy:
 * - Real embedded DB (same pattern as sweeps.test.ts) so listTasks and the
 *   MergeJobStore read the same actual data.
 * - `phase-recovery` is mocked so recoverPhase never touches git; we inspect
 *   what task ids (if any) it receives.
 * - MARS_STALE_MERGING_THRESHOLD_MS=0 forces every 'merging' task to appear
 *   stale by age, isolating the active-job guard as the sole discriminator.
 */

import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { DbClient } from '../../lib/db.js'

// ---------------------------------------------------------------------------
// Module-level mock — intercepted by vitest's import-interception so the
// dynamic `await import('./phase-recovery')` inside the sweep also picks it up.
// ---------------------------------------------------------------------------

const recoverPhaseSpy = vi.fn()

vi.mock('../phase-recovery.js', () => ({
  recoverPhase: recoverPhaseSpy,
}))

// ---------------------------------------------------------------------------
// Helpers (same pattern as sweeps.test.ts)
// ---------------------------------------------------------------------------

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'mars-stale-merging-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(join(repo, '.mars'), { recursive: true })
  return repo
}

async function makeClient(repo: string): Promise<DbClient> {
  const { openDb } = await import('../../lib/db.js')
  const { ensureSchema } = await import('../../lib/pg-schema.js')
  const client = openDb(resolve(repo, '.mars'))
  await ensureSchema(client)
  return client
}

/** Insert a task row with the given status directly into the DB. */
async function insertTask(
  client: DbClient,
  id: string,
  status: string,
  updatedAtMs = Date.now(),
): Promise<void> {
  // Pass epoch-millisecond numbers — the same form used in emit.test.ts and
  // sweeps.test.ts for created_at/updated_at across both tasks (timestamptz)
  // and proposals (bigint epoch-ms). The embedded PG driver accepts both forms.
  await client.execute({
    sql: `INSERT INTO tasks
            (id, prompt, status, origin_id, recovery_spawned_count, created_at, updated_at)
          VALUES ($1, $2, $3, $1, 0, $4, $4)`,
    args: [id, `task ${id}`, status, updatedAtMs],
  })
}

/** Insert a merge_jobs row in 'queued' status for the given task. */
async function insertMergeJob(client: DbClient, taskId: string): Promise<void> {
  const id = randomUUID()
  await client.execute({
    sql: `INSERT INTO merge_jobs
            (id, task_id, status, attempts, integration_branch, worktree_path, branch,
             created_at, updated_at)
          VALUES ($1, $2, 'queued', 0, 'main', '/tmp/wt', 'task/$2',
                 NOW(), NOW())`,
    args: [id, taskId],
  })
}

/** Collect all task ids passed to recoverPhase across all calls. */
function recoveredTaskIds(): string[] {
  return recoverPhaseSpy.mock.calls.flatMap((args: unknown[]) => {
    const opts = args[1] as { taskIds?: string[] } | undefined
    return opts?.taskIds ?? []
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('stale-merging-sweep: active-job guard', { timeout: 120_000 }, () => {
  let repo: string
  let client: DbClient
  /** Minimal SweepDeps — only log and bus are needed; the sweep ignores others. */
  const logLines: string[] = []
  const mockLog = (line: string) => logLines.push(line)
  const bus = new EventEmitter()

  /** 2 hours ago — well past the 40-min default threshold */
  const OLD_TS = () => Date.now() - 2 * 60 * 60 * 1000

  beforeEach(async () => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    // Use 1 ms threshold so any task inserted with a past timestamp is stale.
    // This is simpler than relying on the 0-handling edge case.
    process.env.MARS_STALE_MERGING_THRESHOLD_MS = '1'
    vi.resetModules()
    client = await makeClient(repo)
    recoverPhaseSpy.mockResolvedValue({ requeued: [], finalized: 0 })
    recoverPhaseSpy.mockClear()
    logLines.length = 0
  })

  afterEach(async () => {
    await client.close()
    delete process.env.MARS_REPO
    delete process.env.MARS_STALE_MERGING_THRESHOLD_MS
    rmSync(repo, { recursive: true, force: true })
  })

  it('skips a merging task that has a queued merge job (waiting, not stuck)', async () => {
    const taskId = 'task-with-active-job-001'
    await insertTask(client, taskId, 'merging', OLD_TS())
    await insertMergeJob(client, taskId)

    const { SWEEPS } = await import('../sweeps.js')
    const sweep = SWEEPS.find((s) => s.name === 'stale-merging-sweep')
    if (!sweep) throw new Error('stale-merging-sweep not found in SWEEPS')

    // Run with a minimal SweepDeps stub (sweep only reads log and bus from deps)
    await sweep.run({ log: mockLog, bus } as unknown as Parameters<typeof sweep.run>[0])

    // recoverPhase must NOT have been called with this task's id
    expect(recoveredTaskIds()).not.toContain(taskId)

    // The sweep must log a human-readable "waiting" message
    const logged = logLines.join('\n')
    expect(logged).toMatch(/waiting in merge queue/)
  })

  it('recovers a merging task that has no active merge job (truly stuck)', async () => {
    const taskId = 'task-no-job-001'
    await insertTask(client, taskId, 'merging', OLD_TS())
    // Intentionally no merge_jobs row for this task

    const { SWEEPS } = await import('../sweeps.js')
    const sweep = SWEEPS.find((s) => s.name === 'stale-merging-sweep')
    if (!sweep) throw new Error('stale-merging-sweep not found in SWEEPS')

    await sweep.run({ log: mockLog, bus } as unknown as Parameters<typeof sweep.run>[0])

    // recoverPhase MUST have been called with this task's id
    expect(recoveredTaskIds()).toContain(taskId)
  })

  it('separates waiting tasks from stuck tasks in the same tick', async () => {
    const waitingId = 'task-waiting-002'
    const stuckId = 'task-stuck-002'

    await insertTask(client, waitingId, 'merging', OLD_TS())
    await insertMergeJob(client, waitingId) // has an active job → waiting

    await insertTask(client, stuckId, 'merging', OLD_TS())
    // stuckId has no merge_jobs row → genuinely stuck

    const { SWEEPS } = await import('../sweeps.js')
    const sweep = SWEEPS.find((s) => s.name === 'stale-merging-sweep')!

    await sweep.run({ log: mockLog, bus } as unknown as Parameters<typeof sweep.run>[0])

    const recovered = recoveredTaskIds()
    expect(recovered).not.toContain(waitingId)
    expect(recovered).toContain(stuckId)

    const logged = logLines.join('\n')
    expect(logged).toMatch(/waiting in merge queue/)
    expect(logged).toMatch(/stale merging task/)
  })
})
