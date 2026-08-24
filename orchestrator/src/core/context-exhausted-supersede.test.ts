/**
 * Behaviour of the supersede-on-context-exhausted-recovery playbook.
 *
 * Asserted through the public failure-handler entry point and the resulting
 * task rows — never against the module's internals — so a refactor that keeps
 * the same arc outcome keeps these tests green.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { buildContextExhaustedSupersedePrompt } from './context-exhausted-supersede'
import { SALVAGE_CHECKPOINT_SUBJECT_PREFIX } from './lib/git/checkpoint'

interface QueueModule {
  enqueueTask: typeof import('./queue').enqueueTask
  getTask: typeof import('./queue').getTask
  updateTask: typeof import('./queue').updateTask
  resolveQueueClient: typeof import('./queue').resolveQueueClient
  ensureQueueSchema: typeof import('./queue').ensureQueueSchema
}

interface FixTasksModule {
  handleTaskFailureWithFixTask: typeof import('./queue-fix-tasks').handleTaskFailureWithFixTask
  upsertFixTask: typeof import('./queue-fix-tasks').upsertFixTask
}

const CONTEXT_EXHAUSTED_STEP = 'code:context-exhausted'
const CONTEXT_EXHAUSTED_SIGNATURE = 'code:context-exhausted/unclassified'
const EXHAUSTION_OUTPUT = 'context budget exhausted (maxContextTokens) mid-code'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-ctx-supersede-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

/**
 * Give `repo` an initial commit on `main` and a `branch` carrying one commit,
 * using the REAL git binary and the real salvage-checkpoint commit shape
 * (subject prefix plus the `Mars-Checkpoint: salvage` trailer). The branch
 * classification this module makes is a read against git, so it is verified
 * against git rather than against a stub.
 */
const seedBranch = (repo: string, branch: string, salvage: boolean): void => {
  writeFileSync(resolve(repo, 'README.md'), 'base\n')
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['commit', '-qm', 'chore: base'], { cwd: repo })
  execFileSync('git', ['checkout', '-q', '-b', branch], { cwd: repo })
  writeFileSync(resolve(repo, 'work.txt'), 'partial\n')
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync(
    'git',
    [
      'commit',
      '-qm',
      salvage
        ? `${SALVAGE_CHECKPOINT_SUBJECT_PREFIX} coder ran out of context (exit 138) with 1 uncommitted path(s) — do not merge as-is\n\nMars-Checkpoint: salvage`
        : 'feat(verify): add schema column for verify output',
    ],
    { cwd: repo },
  )
  // Leave the repo on main so the branch is free for `git worktree add`.
  execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo })
}

/** See rescue-operator-spawn.test.ts — each test owns its own embedded PG. */
let currentDb: { __resetDbRegistryForTests: () => Promise<void> } | null = null

const loadModules = async (repo: string): Promise<{ q: QueueModule; ft: FixTasksModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  currentDb = (await import('./lib/db')) as unknown as {
    __resetDbRegistryForTests: () => Promise<void>
  }
  const q = (await import('./queue')) as unknown as QueueModule
  await q.ensureQueueSchema()
  const ft = (await import('./queue-fix-tasks')) as unknown as FixTasksModule
  return { q, ft }
}

/** Spawn a recovery task for `originId` without going through a real failure. */
const spawnRecoveryFor = async (
  ft: FixTasksModule,
  originId: string,
  originPrompt: string,
): Promise<string> => {
  const fix = await ft.upsertFixTask({
    sourceTaskId: originId,
    failureSignature: CONTEXT_EXHAUSTED_SIGNATURE,
    failingStep: CONTEXT_EXHAUSTED_STEP,
    truncatedError: EXHAUSTION_OUTPUT,
    branch: null,
    recipeContext: {
      targetPath: '/tmp/test',
      statusOutput: '',
      targetBranch: 'main',
      originalPrompt: originPrompt,
    },
  })
  return fix.fixTaskId
}

const rowsOf = async <T>(q: QueueModule, sql: string, args: unknown[] = []): Promise<T[]> => {
  const r = await q.resolveQueueClient().execute({ sql, args: args as never })
  return r.rows as unknown as T[]
}

describe('buildContextExhaustedSupersedePrompt', () => {
  const base = {
    originId: 'mars-origin1',
    exhaustedRecoveryId: 'fix-abc123',
    integrationBranch: 'main',
    originPrompt: 'Add durable storage for verify gate output.',
  }

  it('names the salvage-checkpoint tip and the finish-or-reset first action', () => {
    const prompt = buildContextExhaustedSupersedePrompt({
      ...base,
      branch: 'task/mars-origin1',
      commitsAhead: [
        { shortSha: 'aaa1111', subject: `${SALVAGE_CHECKPOINT_SUBJECT_PREFIX} coder ran out of context` },
        { shortSha: 'bbb2222', subject: 'feat(verify): add schema column' },
      ],
      tipIsSalvageCheckpoint: true,
    })

    // (a) the branch tip state is named, with the actual commits
    expect(prompt).toContain('task/mars-origin1')
    expect(prompt).toContain('2 commit(s)** ahead of `main`')
    expect(prompt).toContain('aaa1111')
    expect(prompt).toContain('salvage checkpoint')
    // ...and the correct first action is finish-or-reset, not "build on top"
    expect(prompt).toContain('finish-or-reset')
    expect(prompt).toContain('git reset --hard HEAD~1')
    expect(prompt).toContain('must NOT end on a checkpoint commit')
  })

  it('inlines the origin prompt and the context discipline rules', () => {
    const prompt = buildContextExhaustedSupersedePrompt({
      ...base,
      branch: 'task/mars-origin1',
      commitsAhead: [],
      tipIsSalvageCheckpoint: false,
    })

    // (b) the original goal is inlined verbatim
    expect(prompt).toContain('Add durable storage for verify gate output.')
    // (c) incremental-commit + low-context-handoff discipline
    expect(prompt).toContain('Commit incrementally')
    expect(prompt).toContain('mars task add --blocked-by')
    expect(prompt).toContain('Save your work')
    // and it names both dead predecessors so the coder knows what happened
    expect(prompt).toContain('fix-abc123')
    expect(prompt).toContain('mars-origin1')
  })

  it('reports an empty branch as a clean base rather than inventing a checkpoint', () => {
    const prompt = buildContextExhaustedSupersedePrompt({
      ...base,
      branch: 'task/mars-origin1',
      commitsAhead: [],
      tipIsSalvageCheckpoint: false,
    })

    expect(prompt).toContain('no commits** ahead')
    expect(prompt).not.toContain('finish-or-reset')
  })
})

describe('supersede on context-exhausted recovery', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(async () => {
    delete process.env.MARS_REPO
    await currentDb?.__resetDbRegistryForTests()
    currentDb = null
    rmSync(repo, { recursive: true, force: true })
  })

  it('carries the arc forward onto a fresh superseding task instead of parking it', async () => {
    const { q, ft } = await loadModules(repo)
    const originPrompt = 'Classify and durably store verify gate error output.'
    const origin = await q.enqueueTask(originPrompt, undefined, { skipTriage: true })
    const recoveryId = await spawnRecoveryFor(ft, origin.id, originPrompt)

    const r = await ft.handleTaskFailureWithFixTask({
      taskId: recoveryId,
      failingStep: CONTEXT_EXHAUSTED_STEP,
      errorOutput: EXHAUSTION_OUTPUT,
    })

    expect(r.outcome).toBe('superseded-on-context-exhaustion')
    expect(r.supersedingTaskId).toBeTruthy()

    // The superseding task inherits the arc and is dispatchable immediately.
    const supersede = await q.getTask(r.supersedingTaskId as string)
    expect(supersede?.status).toBe('queued')
    expect(supersede?.originId).toBe(origin.id)
    expect(supersede?.prompt).toContain(originPrompt)

    // Both dead rows are retired, so nothing re-drives the arc.
    expect((await q.getTask(origin.id))?.status).toBe('dropped')
    expect((await q.getTask(recoveryId))?.status).toBe('dropped')

    // No recovery-failed escalation was raised — the whole point is that the
    // operator is not pulled in on the first exhaustion.
    const alerts = await rowsOf<{ n: number | bigint }>(
      q,
      `SELECT COUNT(*) AS n FROM action_queue_items WHERE kind = 'failed' AND status = 'open'`,
    )
    expect(Number(alerts[0]!.n)).toBe(0)
  })

  it('supersedes at most once per arc — a second exhaustion parks as before', async () => {
    const { q, ft } = await loadModules(repo)
    const originPrompt = 'Classify and durably store verify gate error output.'
    const origin = await q.enqueueTask(originPrompt, undefined, { skipTriage: true })

    const firstRecovery = await spawnRecoveryFor(ft, origin.id, originPrompt)
    const first = await ft.handleTaskFailureWithFixTask({
      taskId: firstRecovery,
      failingStep: CONTEXT_EXHAUSTED_STEP,
      errorOutput: EXHAUSTION_OUTPUT,
    })
    expect(first.outcome).toBe('superseded-on-context-exhaustion')
    const supersedeId = first.supersedingTaskId as string

    // The superseding task now exhausts in turn: its own recovery is spawned,
    // and that recovery runs out of context too.
    const secondRecovery = await spawnRecoveryFor(ft, supersedeId, originPrompt)
    const second = await ft.handleTaskFailureWithFixTask({
      taskId: secondRecovery,
      failingStep: CONTEXT_EXHAUSTED_STEP,
      errorOutput: EXHAUSTION_OUTPUT,
    })

    // Parked exactly as it is today — no second supersede, no loop.
    expect(second.outcome).toBe('escalated')
    const spawned = await rowsOf<{ n: number | bigint }>(
      q,
      `SELECT COUNT(*) AS n FROM tasks WHERE followup_dedup_key LIKE 'context-exhausted-supersede:%'`,
    )
    expect(Number(spawned[0]!.n)).toBe(1)
    expect((await q.getTask(secondRecovery))?.status).toBe('failed')
  })

  it('briefs the coder about a real salvage-checkpoint tip on the inherited branch', async () => {
    const { q, ft } = await loadModules(repo)
    const originPrompt = 'Classify and durably store verify gate error output.'
    const origin = await q.enqueueTask(originPrompt, undefined, { skipTriage: true })
    const branch = `task/${origin.id}`
    seedBranch(repo, branch, true)
    await q.updateTask(origin.id, { branch })
    const recoveryId = await spawnRecoveryFor(ft, origin.id, originPrompt)

    const r = await ft.handleTaskFailureWithFixTask({
      taskId: recoveryId,
      failingStep: CONTEXT_EXHAUSTED_STEP,
      errorOutput: EXHAUSTION_OUTPUT,
    })

    expect(r.outcome).toBe('superseded-on-context-exhaustion')
    const supersede = await q.getTask(r.supersedingTaskId as string)
    // The branch (and therefore the salvaged work) is carried forward.
    expect(supersede?.branch).toBe(branch)
    expect(supersede?.worktreePath).toBeTruthy()
    // The checkpoint tip is named, with the finish-or-reset first action.
    expect(supersede?.prompt).toContain('salvage checkpoint')
    expect(supersede?.prompt).toContain('finish-or-reset')
    expect(supersede?.prompt).toContain('1 commit(s)** ahead of `main`')
  })

  it('defers to auto-remerge when the branch holds real coder commits', async () => {
    const { q, ft } = await loadModules(repo)
    const originPrompt = 'Classify and durably store verify gate error output.'
    const origin = await q.enqueueTask(originPrompt, undefined, { skipTriage: true })
    const branch = `task/${origin.id}`
    seedBranch(repo, branch, false)
    await q.updateTask(origin.id, { branch })
    const recoveryId = await spawnRecoveryFor(ft, origin.id, originPrompt)
    // The recovery runs on the origin's branch, which is what the remerge
    // check below reads. It is also already 'failed' by the time the handler
    // runs — `coder-exit.ts` stamps the failure before dispatching here — and
    // 'failed' is terminal, so the remerge path's own drop of this row has to
    // go through the reopen seam or it throws and the arc both remerges AND
    // escalates.
    await q.updateTask(recoveryId, { branch })
    await q.updateTask(recoveryId, {
      status: 'failed',
      failedPhase: 'code',
      failureReason: 'context-exhausted',
      error: EXHAUSTION_OUTPUT,
    })

    const r = await ft.handleTaskFailureWithFixTask({
      taskId: recoveryId,
      failingStep: CONTEXT_EXHAUSTED_STEP,
      errorOutput: EXHAUSTION_OUTPUT,
      branch,
    })

    // Landing the real work beats handing it to a fresh coder.
    expect(r.outcome).toBe('requeued-for-remerge')
    const spawned = await rowsOf<{ n: number | bigint }>(
      q,
      `SELECT COUNT(*) AS n FROM tasks WHERE followup_dedup_key LIKE 'context-exhausted-supersede:%'`,
    )
    expect(Number(spawned[0]!.n)).toBe(0)

    // The arc continues through the origin's remerge, and the dead recovery is
    // retired rather than left 'failed' for the drain to re-escalate.
    const originAfter = await q.getTask(origin.id)
    expect(originAfter?.status).toBe('queued')
    expect(originAfter?.workflow).toBe('remerge')
    expect((await q.getTask(recoveryId))?.status).toBe('dropped')

    // ...and no action-queue escalation was raised alongside the remerge.
    const alerts = await rowsOf<{ n: number | bigint }>(
      q,
      `SELECT COUNT(*) AS n FROM action_queue_items WHERE kind = 'failed' AND status = 'open'`,
    )
    expect(Number(alerts[0]!.n)).toBe(0)
  })

  it('leaves non-context-exhausted recovery failures on the unchanged escalation path', async () => {
    const { q, ft } = await loadModules(repo)
    const origin = await q.enqueueTask('do a thing', undefined, { skipTriage: true })
    const recoveryId = await spawnRecoveryFor(ft, origin.id, 'do a thing')

    const r = await ft.handleTaskFailureWithFixTask({
      taskId: recoveryId,
      failingStep: 'verify:test',
      errorOutput: 'AssertionError: expected 1 to be 2',
    })

    expect(r.outcome).toBe('escalated')
    const spawned = await rowsOf<{ n: number | bigint }>(
      q,
      `SELECT COUNT(*) AS n FROM tasks WHERE followup_dedup_key LIKE 'context-exhausted-supersede:%'`,
    )
    expect(Number(spawned[0]!.n)).toBe(0)
    // The origin is untouched by this path — it stays blocked on its recovery.
    expect((await q.getTask(origin.id))?.status).toBe('blocked')
  })
})
