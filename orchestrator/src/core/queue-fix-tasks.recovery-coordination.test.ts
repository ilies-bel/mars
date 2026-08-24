/**
 * Recovery coordination tests for handleTaskFailureWithFixTask.
 *
 * Fix 1: Two simultaneous failure events for one origin produce exactly one
 *        recovery attempt — checked by verifying a second call returns 'noop'.
 * Fix 2: The noop result carries `supersedingTaskId` so the trace shows which
 *        in-flight task superseded the redundant attempt (explicit supersede
 *        marker, not a silent drop).
 * Fix 3: When a fix task fails but its branch has commits ahead of the
 *        integration branch, the origin is re-queued via the remerge workflow
 *        instead of escalating to the action queue.
 * Fix 4: When the branch tip has advanced past the salvage checkpoint since the
 *        failure was recorded, the recovery brief must not assert the stale
 *        "unfinished salvage checkpoint" claim with the outdated sha.
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
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  SALVAGE_CHECKPOINT_SUBJECT_PREFIX,
  SALVAGE_CHECKPOINT_TRAILER_KEY,
  SALVAGE_CHECKPOINT_TRAILER_VALUE,
} from './lib/git/checkpoint'

interface QueueModule {
  enqueueTask: typeof import('./queue').enqueueTask
  updateTask: typeof import('./queue').updateTask
  getTask: typeof import('./queue').getTask
  resolveQueueClient: typeof import('./queue').resolveQueueClient
  migrateQueueSchema: typeof import('./queue').migrateQueueSchema
}

interface FixTasksModule {
  handleTaskFailureWithFixTask: typeof import('./queue-fix-tasks').handleTaskFailureWithFixTask
}

interface RecipesModule {
  recipes: typeof import('./lib/fix-recipes').recipes
}

// ── Repo helpers ────────────────────────────────────────────────────────────

/** Minimal repo — no git initialised, mirrors the existing test pattern. */
const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-rc-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

/**
 * Repo with a proper git history: one commit on `main` plus an extra commit on
 * `branchName`. Used by Fix 3 to give `listUniqueCommitsAhead` something real
 * to find.
 */
const setupRepoWithBranchAhead = (branchName: string): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-rc-ahead-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  // Initial commit on main so the integration branch exists.
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo })
  // Branch with one commit ahead of main.
  execFileSync('git', ['checkout', '-b', branchName], { cwd: repo })
  execFileSync('git', ['commit', '--allow-empty', '-m', 'fix work'], { cwd: repo })
  // Return to main so the worktree default HEAD is main.
  execFileSync('git', ['checkout', 'main'], { cwd: repo })
  return repo
}

/**
 * Repo for Fix 4: `branchName` carries a salvage-checkpoint commit followed by
 * a real commit (simulating a coder that resumed and landed genuine work on top
 * of the checkpoint). The branch tip is therefore NOT a checkpoint, even though
 * an earlier checkpoint sha exists in the history.
 *
 * Returns both the repo path and the sha of the checkpoint commit so the test
 * can embed it into the stored (stale) `errorOutput`.
 */
const setupRepoWithCheckpointThenRealWork = (
  branchName: string,
): { repo: string; checkpointSha: string } => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-rc-stale-sha-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@mars.local'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Mars Test'], { cwd: repo })
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  // Initial commit on main so the integration branch exists.
  writeFileSync(resolve(repo, 'README.md'), 'hi\n')
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
  // Create the task branch.
  execFileSync('git', ['checkout', '-b', branchName], { cwd: repo })
  // Add a salvage checkpoint commit — structurally correct (has the trailer).
  const checkpointMsg = [
    `${SALVAGE_CHECKPOINT_SUBJECT_PREFIX} coder killed (exit 143) with 1 path — do not merge as-is`,
    '',
    `${SALVAGE_CHECKPOINT_TRAILER_KEY}: ${SALVAGE_CHECKPOINT_TRAILER_VALUE}`,
  ].join('\n')
  writeFileSync(resolve(repo, 'partial.ts'), 'const x = 1\n')
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', checkpointMsg], { cwd: repo })
  const checkpointSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repo,
    encoding: 'utf8',
  }).trim()
  // Add a real commit on top (branch advances past the checkpoint).
  writeFileSync(resolve(repo, 'partial.ts'), 'export const x = 1\n')
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'feat: real work landed by resumed coder'], {
    cwd: repo,
  })
  // Return to main so the worktree default HEAD is main.
  execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo })
  return { repo, checkpointSha }
}

// ── Template DB pattern (mirrors queue-fix-tasks.test.ts) ──────────────────

const TEMPLATE_DB_FILES = ['queue.db', 'state.db'] as const
let templateRepo: string

const cloneTemplateDbs = (destRepo: string): void => {
  for (const file of TEMPLATE_DB_FILES) {
    const src = resolve(templateRepo, '.mars', file)
    if (!existsSync(src)) continue
    copyFileSync(src, resolve(destRepo, '.mars', file))
  }
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; ft: FixTasksModule; rc: RecipesModule }> => {
  try {
    const { closeAllDbs } = await import('./lib/db')
    await closeAllDbs()
  } catch {
    // Non-fatal: first call or already-closed instance.
  }
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('./queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const ft = (await import('./queue-fix-tasks')) as unknown as FixTasksModule
  const rc = (await import('./lib/fix-recipes')) as unknown as RecipesModule
  return { q, ft, rc }
}

const registerTestRecipe = (
  rc: RecipesModule,
  signature: string,
): (() => void) => {
  rc.recipes[signature] = {
    signature,
    title: () => `test recipe: ${signature}`,
    buildPrompt: () => `synthetic recovery prompt for ${signature}`,
  }
  return () => {
    delete rc.recipes[signature]
  }
}

// ── Suite ───────────────────────────────────────────────────────────────────

describe('queue-fix-tasks: recovery coordination', () => {
  let repo: string

  beforeAll(async () => {
    templateRepo = setupRepo()
    vi.resetModules()
    process.env.MARS_REPO = templateRepo
    const q = (await import('./queue')) as unknown as QueueModule
    await q.migrateQueueSchema()
    const actionQueue = (await import('./lib/action-queue')) as unknown as {
      initActionQueue: typeof import('./lib/action-queue').initActionQueue
    }
    await actionQueue.initActionQueue()
    delete process.env.MARS_REPO
    const { closeAllDbs } = await import('./lib/db')
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
    rmSync(repo, { recursive: true, force: true })
  })

  // ── Fix 1 ────────────────────────────────────────────────────────────────

  it('Fix 1: two simultaneous failure events for one origin produce exactly one recovery attempt', async () => {
    const { q, ft, rc } = await loadModules(repo)
    const sig = 'verify:typecheck/unclassified'
    const cleanup = registerTestRecipe(rc, sig)

    const origin = await q.enqueueTask('origin task', undefined, { skipTriage: true })

    // First failure — spawns the fix task, origin → blocked.
    const r1 = await ft.handleTaskFailureWithFixTask({
      taskId: origin.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304',
    })
    expect(r1.outcome).toBe('blocked')
    const fixTaskId = r1.fixTaskId!
    expect(fixTaskId).toBeTruthy()

    // Fix task is now queued — origin is blocked on it.
    const afterFirst = await q.getTask(origin.id)
    expect(afterFirst?.status).toBe('blocked')

    // Second (simultaneous) failure event for the SAME origin.
    const r2 = await ft.handleTaskFailureWithFixTask({
      taskId: origin.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304',
    })
    // Must be a noop — the in-flight fix task is the authoritative recovery.
    expect(r2.outcome).toBe('noop')

    // Origin stays blocked — no terminal transition.
    const afterSecond = await q.getTask(origin.id)
    expect(afterSecond?.status).toBe('blocked')

    // Exactly ONE fix task was ever created for this origin.
    const { rows } = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE fix_for_task_id = ?`,
      args: [origin.id],
    })
    expect(Number((rows[0] as unknown as { n: number }).n)).toBe(1)

    cleanup()
  })

  // ── Fix 2 ────────────────────────────────────────────────────────────────

  it('Fix 2: noop result carries supersedingTaskId for an in-flight fix task', async () => {
    const { q, ft, rc } = await loadModules(repo)
    const sig = 'verify:typecheck/unclassified'
    const cleanup = registerTestRecipe(rc, sig)

    const origin = await q.enqueueTask('origin task', undefined, { skipTriage: true })

    // First failure — fix task spawned.
    const r1 = await ft.handleTaskFailureWithFixTask({
      taskId: origin.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304',
    })
    expect(r1.outcome).toBe('blocked')
    const fixTaskId = r1.fixTaskId!

    // Second failure — superseded by the in-flight fix task.
    const r2 = await ft.handleTaskFailureWithFixTask({
      taskId: origin.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304',
    })
    expect(r2.outcome).toBe('noop')
    // supersedingTaskId must point to the existing fix task (Fix 2 marker).
    expect(r2.supersedingTaskId).toBe(fixTaskId)

    cleanup()
  })

  it('Fix 2: noop result carries supersedingTaskId for an in-flight rescue task', async () => {
    // A rescue task (tagged rescue-operator) for the same origin arc should
    // also suppress a new recovery attempt and surface as supersedingTaskId.
    const { q, ft } = await loadModules(repo)

    const origin = await q.enqueueTask('origin task', undefined, { skipTriage: true })

    // Manually enqueue a rescue task for the origin (skips triage, tagged rescue-operator).
    const rescue = await q.enqueueTask('rescue task', undefined, {
      skipTriage: true,
      tags: ['rescue-operator'],
      originId: origin.id,
    })
    expect(rescue.status).toBe('queued')

    // Now simulate a failure event for the origin. A rescue is already in flight.
    const r = await ft.handleTaskFailureWithFixTask({
      taskId: origin.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304',
    })
    // Must be noop — the rescue task covers this arc.
    expect(r.outcome).toBe('noop')
    // supersedingTaskId identifies the rescue (Fix 2: explicit supersede trace).
    expect(r.supersedingTaskId).toBe(rescue.id)

    // No fix task was spawned.
    const { rows } = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE fix_for_task_id = ?`,
      args: [origin.id],
    })
    expect(Number((rows[0] as unknown as { n: number }).n)).toBe(0)
  })

  // ── Fix 3 ────────────────────────────────────────────────────────────────

  it('Fix 3: dead-arc escalation re-routes origin through remerge when branch tip is ahead', async () => {
    // Use a repo that has an initial commit on main and a branch ahead of it.
    const fixBranch = 'task/fix-ahead'
    const repoWithHistory = setupRepoWithBranchAhead(fixBranch)
    cloneTemplateDbs(repoWithHistory)

    const { q, ft, rc } = await loadModules(repoWithHistory)
    const sig = 'verify:typecheck/unclassified'
    const cleanup = registerTestRecipe(rc, sig)

    // Create the origin and spawn a fix task for it.
    const origin = await q.enqueueTask('origin task', undefined, { skipTriage: true })
    const r1 = await ft.handleTaskFailureWithFixTask({
      taskId: origin.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304',
    })
    expect(r1.outcome).toBe('blocked')
    const fixTaskId = r1.fixTaskId!

    // Simulate the fix task having committed work: set its branch to the branch
    // that is ahead of main in the git repo. (In production, the dispatch loop
    // sets the branch when it provisions the worktree.)
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET branch = ? WHERE id = ?`,
      args: [fixBranch, fixTaskId],
    })

    // Now the fix task itself fails. Branch is ahead of main → remerge path.
    const r2 = await ft.handleTaskFailureWithFixTask({
      taskId: fixTaskId,
      failingStep: 'verify:typecheck',
      errorOutput: 'fix task also failed',
    })

    // Fix 3: should requeue the origin for remerge instead of escalating.
    expect(r2.outcome).toBe('requeued-for-remerge')

    // Origin must now be queued with the remerge workflow.
    const reloadedOrigin = await q.getTask(origin.id)
    expect(reloadedOrigin?.status).toBe('queued')
    expect(reloadedOrigin?.workflow).toBe('remerge')

    // Fix task must be dropped as superseded (clear trace).
    const reloadedFix = await q.getTask(fixTaskId)
    expect(reloadedFix?.status).toBe('dropped')
    expect(reloadedFix?.dropReason).toBe('superseded')

    // The task_blockers edge (origin→fix) must have been removed.
    const { rows: blockerRows } = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE task_id = ? AND blocker_task_id = ?`,
      args: [origin.id, fixTaskId],
    })
    expect(Number((blockerRows[0] as unknown as { n: number }).n)).toBe(0)

    cleanup()
    rmSync(repoWithHistory, { recursive: true, force: true })
  })

  // ── Fix 4 ────────────────────────────────────────────────────────────────

  it('Fix 4: recovery brief does not contain stale salvage-checkpoint claim when branch tip has advanced', async () => {
    // Simulate the incident: the merge step recorded a failure with a checkpoint
    // sha in the error text, but a later coder attempt then landed a real commit
    // on top of that checkpoint (advancing the branch tip). The recovery brief
    // must NOT repeat the stale "branch tip is an unfinished salvage checkpoint
    // (OLDSHA)" claim, which names a sha that is no longer the branch tip.
    const branch = 'task/mars-stale-sha-rc-test-01'
    const { repo: repoWithHistory, checkpointSha } = setupRepoWithCheckpointThenRealWork(branch)

    const { q, ft } = await loadModules(repoWithHistory)

    // The stored error text embeds the checkpoint sha that was captured when the
    // failure was originally recorded — the "branch tip was a checkpoint" claim.
    // By the time recovery runs, the branch has advanced past that sha.
    const storedError =
      `branch tip is an unfinished salvage checkpoint (${checkpointSha.slice(0, 9)}) and no coder ` +
      `attempt on this branch has ever landed a real commit — split the task or start a fresh ` +
      `attempt with \`mars task add --supersede origin-id\` rather than continuing on this worktree`

    const origin = await q.enqueueTask('do some work', undefined, { skipTriage: true })

    // Call the failure handler with the stale errorOutput. Pass branch explicitly
    // (mirrors what the recovery subscriber does after reading task.branch).
    const result = await ft.handleTaskFailureWithFixTask({
      taskId: origin.id,
      failingStep: 'code',
      errorOutput: storedError,
      branch,
    })

    expect(result.outcome).toBe('blocked')
    const fixTaskId = result.fixTaskId
    expect(fixTaskId).toBeTruthy()

    const fixTask = await q.getTask(fixTaskId!)
    expect(fixTask).not.toBeNull()

    // The fix task prompt must NOT contain the stale salvage-checkpoint claim.
    // The stale sha (checkpointSha) and the distinctive phrase must both be absent.
    expect(fixTask!.prompt).not.toContain('unfinished salvage checkpoint')
    // It must acknowledge that the branch has since advanced.
    expect(fixTask!.prompt).toContain('stale at recovery time')

    rmSync(repoWithHistory, { recursive: true, force: true })
  })
})
