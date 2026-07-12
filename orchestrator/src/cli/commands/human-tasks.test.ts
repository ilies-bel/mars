/**
 * Tests for `mars attach` and `mars release` CLI commands.
 *
 * Uses the in-process command seam (ADR-0023) with a recording fake daemon so
 * tests assert on CLI behaviour and daemon calls without spawning a real daemon.
 *
 * The dirty-worktree guard (`release` with uncommitted changes) is verified
 * against a real git worktree to satisfy the cross-boundary check requirement.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  runCommandInProcess,
  makeFakeDaemon,
  type InProcessOptions,
} from '../test-adapter'
import type { DomainTaskStore } from '../../core/store/task-store'
import type { OrchestratorContext } from '../../core/context'
import { AWAIT_HUMAN_SENTINEL } from '../../core/lib/sentinels'

const here = dirname(fileURLToPath(import.meta.url))
// src/cli/commands -> src/cli -> src -> orchestrator
const projectRoot = resolve(here, '..', '..', '..')

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-human-tasks-test-'))
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
  const queueModule = await import('../../core/queue')
  await queueModule.migrateQueueSchema()
  const storeModule = await import('../../core/store/task-store')
  const contextModule = await import('../../core/context')
  return {
    store: storeModule.createTaskStore(queueModule.resolveQueueClient()),
    ctx: contextModule.resolveContext(repo),
  }
}

const baseOpts = async (
  daemonResponder?: Parameters<typeof makeFakeDaemon>[0],
): Promise<InProcessOptions> => {
  const fake = makeFakeDaemon(daemonResponder)
  const { store, ctx } = await loadStoreAndCtx()
  return { store, ctx, daemon: fake }
}

/**
 * Create a task in 'awaiting-human' status with the given leaseOwner.
 * Uses updateTask directly (bypasses Arc) for test setup only.
 */
const createAwaitingHumanTask = async (
  leaseOwner: string | null,
  worktreePath?: string | null,
): Promise<string> => {
  const { enqueueTask, updateTask } = await import('../../core/queue')
  const task = await enqueueTask('test task for human work', undefined, {
    skipTriage: true,
  })
  await updateTask(task.id, {
    status: 'awaiting-human',
    branch: `task/${task.id}`,
    worktreePath: worktreePath ?? null,
    leaseOwner,
    leasedAt: leaseOwner !== null ? new Date().toISOString() : null,
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
  rmSync(repo, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// mars attach
// ---------------------------------------------------------------------------

describe('mars attach', () => {
  it('sends an attach request with user@host as leaseOwner and prints worktree path', async () => {
    const taskId = await createAwaitingHumanTask(null, '/some/worktree/path')
    const fake = makeFakeDaemon(() => ({
      worktreePath: '/some/worktree/path',
      branch: `task/${taskId}`,
      title: 'test task for human work',
      doneCriteria: ['do the thing', 'verify it'],
      completionReport: null,
      commitsAhead: [],
      checklistState: [
        { criterion: 'do the thing', checked: false },
        { criterion: 'verify it', checked: false },
      ],
      progressTail: [],
    }))
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['attach', taskId], {
      store,
      ctx,
      daemon: fake,
    })

    expect(r.code).toBe(0)
    expect(fake.calls).toHaveLength(1)
    const req = fake.calls[0] as { op: string; id: string; leaseOwner: string }
    expect(req.op).toBe('attach')
    expect(req.id).toBe(taskId)
    // leaseOwner must contain '@'
    expect(req.leaseOwner).toMatch(/@/)

    // CLI output includes worktree path and hint
    const outJoined = r.out.join('\n')
    expect(outJoined).toContain('/some/worktree/path')
    expect(outJoined).toContain('hint: cd /some/worktree/path && claude')
    // Done criteria are rendered using checklistState (unchecked)
    expect(outJoined).toContain('- [ ] do the thing')
    expect(outJoined).toContain('- [ ] verify it')
  })

  it('prints task title and branch', async () => {
    const taskId = await createAwaitingHumanTask(null, '/wt')
    const fake = makeFakeDaemon(() => ({
      worktreePath: '/wt',
      branch: `task/${taskId}`,
      title: 'Implement the feature',
      doneCriteria: [],
      completionReport: null,
      commitsAhead: [],
      checklistState: [],
      progressTail: [],
    }))
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['attach', taskId], { store, ctx, daemon: fake })

    expect(r.code).toBe(0)
    const outJoined = r.out.join('\n')
    expect(outJoined).toContain('Implement the feature')
    expect(outJoined).toContain(`task/${taskId}`)
  })

  it('double-attach: refuses when another active lease exists (daemon error)', async () => {
    const taskId = await createAwaitingHumanTask('user@host', '/wt')
    const fake = makeFakeDaemon(() => {
      throw new Error(
        `task ${taskId} already has an active lease (owner: user@host); release it first`,
      )
    })
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['attach', taskId], { store, ctx, daemon: fake })

    expect(r.code).toBe(1)
    const errJoined = r.err.join('\n')
    expect(errJoined).toContain('active lease')
  })

  it('attach succeeds when task is parked with AWAIT_HUMAN_SENTINEL (workflow park sentinel)', async () => {
    // Regression: onManualPark previously wrote 'workflow:manual-step' as the
    // lease owner, which the attach handler did not recognise as a takeover-able
    // sentinel — causing 'already has an active lease' on every live task.
    // After the fix, both onManualPark and awaitHuman write AWAIT_HUMAN_SENTINEL,
    // which the handler accepts.
    const taskId = await createAwaitingHumanTask(AWAIT_HUMAN_SENTINEL, '/some/worktree/path')
    const fake = makeFakeDaemon(() => ({
      worktreePath: '/some/worktree/path',
      branch: `task/${taskId}`,
      title: 'test task',
      doneCriteria: [],
      completionReport: null,
      commitsAhead: [],
      checklistState: [],
      progressTail: [],
    }))
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['attach', taskId], { store, ctx, daemon: fake })

    // Attach should succeed — AWAIT_HUMAN_SENTINEL is a takeover-able slot
    expect(r.code).toBe(0)
    expect(fake.calls).toHaveLength(1)
    const req = fake.calls[0] as { op: string; id: string; leaseOwner: string }
    expect(req.op).toBe('attach')
    expect(req.id).toBe(taskId)
  })

  it('returns usage error when no task id is provided', async () => {
    const opts = await baseOpts()
    const r = await runCommandInProcess(['attach'], opts)

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('usage: mars attach')
  })

  // ---------------------------------------------------------------------------
  // Handoff-section tests
  // ---------------------------------------------------------------------------

  it('prints completion report when worker coded the task', async () => {
    const taskId = await createAwaitingHumanTask(null, '/wt')
    const fake = makeFakeDaemon(() => ({
      worktreePath: '/wt',
      branch: `task/${taskId}`,
      title: 'test task',
      doneCriteria: ['do the thing'],
      completionReport: {
        kind: 'parsed' as const,
        lines: [{ status: 'done' as const, criterion: 'do the thing', evidence: 'test.ts:45' }],
      },
      commitsAhead: ['abc1234 Add feature X', 'def5678 Fix bug Y'],
      checklistState: [{ criterion: 'do the thing', checked: true }],
      progressTail: [],
    }))
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['attach', taskId], { store, ctx, daemon: fake })

    expect(r.code).toBe(0)
    const outJoined = r.out.join('\n')
    // Completion report section is present
    expect(outJoined).toContain('completion report')
    expect(outJoined).toContain('[done] do the thing')
    expect(outJoined).toContain('test.ts:45')
    // Commits ahead section is present
    expect(outJoined).toContain('commits ahead')
    expect(outJoined).toContain('abc1234 Add feature X')
    expect(outJoined).toContain('def5678 Fix bug Y')
    // Checked criterion
    expect(outJoined).toContain('- [x] do the thing')
  })

  it('omits handoff sections when no code step ran (empty handoff)', async () => {
    const taskId = await createAwaitingHumanTask(null, '/wt')
    const fake = makeFakeDaemon(() => ({
      worktreePath: '/wt',
      branch: `task/${taskId}`,
      title: 'test task',
      doneCriteria: [],
      completionReport: null,
      commitsAhead: [],
      checklistState: [],
      progressTail: [],
    }))
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['attach', taskId], { store, ctx, daemon: fake })

    expect(r.code).toBe(0)
    const outJoined = r.out.join('\n')
    // Basic fields still printed
    expect(outJoined).toContain('/wt')
    expect(outJoined).toContain('hint:')
    // Handoff sections absent — no placeholder noise
    expect(outJoined).not.toContain('completion report')
    expect(outJoined).not.toContain('commits ahead')
    expect(outJoined).not.toContain('journal')
  })

  it('renders checklist using checklistState (progress-derived state)', async () => {
    const taskId = await createAwaitingHumanTask(null, '/wt')
    const fake = makeFakeDaemon(() => ({
      worktreePath: '/wt',
      branch: `task/${taskId}`,
      title: 'test',
      doneCriteria: ['criterion 1', 'criterion 2'],
      completionReport: null,
      commitsAhead: [],
      checklistState: [
        { criterion: 'criterion 1', checked: true },
        { criterion: 'criterion 2', checked: false },
      ],
      progressTail: [],
    }))
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['attach', taskId], { store, ctx, daemon: fake })

    expect(r.code).toBe(0)
    const outJoined = r.out.join('\n')
    expect(outJoined).toContain('- [x] criterion 1')
    expect(outJoined).toContain('- [ ] criterion 2')
  })

  it('prints progress journal tail when entries are present', async () => {
    const taskId = await createAwaitingHumanTask(null, '/wt')
    const fake = makeFakeDaemon(() => ({
      worktreePath: '/wt',
      branch: `task/${taskId}`,
      title: 'test',
      doneCriteria: [],
      completionReport: null,
      commitsAhead: [],
      checklistState: [],
      progressTail: [
        {
          id: 'prog-abc123',
          taskId,
          createdAt: '2026-07-04T10:00:00Z',
          author: 'worker',
          kind: 'note' as const,
          body: 'Started implementation',
          criterionIndex: null,
        },
      ],
    }))
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['attach', taskId], { store, ctx, daemon: fake })

    expect(r.code).toBe(0)
    const outJoined = r.out.join('\n')
    expect(outJoined).toContain('journal')
    expect(outJoined).toContain('worker')
    expect(outJoined).toContain('Started implementation')
  })
})

// ---------------------------------------------------------------------------
// mars release
// ---------------------------------------------------------------------------

describe('mars release', () => {
  it('sends release-lease request and outputs re-queued message', async () => {
    // Create a clean git worktree so the dirty-worktree check passes.
    const wt = mkdtempSync(resolve(tmpdir(), 'mars-wt-clean-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: wt })
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: wt })
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: wt })
      // Commit something so the worktree is clean (no staged/unstaged)
      writeFileSync(resolve(wt, 'README.md'), 'hello')
      execFileSync('git', ['add', '.'], { cwd: wt })
      execFileSync('git', ['commit', '-m', 'initial', '--allow-empty'], { cwd: wt })

      const taskId = await createAwaitingHumanTask('user@host', wt)
      const fake = makeFakeDaemon(() => undefined)
      const { store, ctx } = await loadStoreAndCtx()

      const r = await runCommandInProcess(['release', taskId], { store, ctx, daemon: fake })

      expect(r.code).toBe(0)
      expect(fake.calls).toHaveLength(1)
      const req = fake.calls[0] as { op: string; id: string; abort: boolean }
      expect(req.op).toBe('release-lease')
      expect(req.id).toBe(taskId)
      expect(req.abort).toBe(false)
      expect(r.out.join('\n')).toContain('re-queued')
    } finally {
      rmSync(wt, { recursive: true, force: true })
    }
  })

  it('--abort: sends release-lease with abort=true and outputs failure-path message', async () => {
    const wt = mkdtempSync(resolve(tmpdir(), 'mars-wt-abort-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: wt })
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: wt })
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: wt })
      writeFileSync(resolve(wt, 'README.md'), 'hello')
      execFileSync('git', ['add', '.'], { cwd: wt })
      execFileSync('git', ['commit', '-m', 'initial'], { cwd: wt })

      const taskId = await createAwaitingHumanTask('user@host', wt)
      const fake = makeFakeDaemon(() => undefined)
      const { store, ctx } = await loadStoreAndCtx()

      const r = await runCommandInProcess(['release', '--abort', taskId], {
        store,
        ctx,
        daemon: fake,
      })

      expect(r.code).toBe(0)
      expect(fake.calls).toHaveLength(1)
      const req = fake.calls[0] as { op: string; id: string; abort: boolean }
      expect(req.op).toBe('release-lease')
      expect(req.abort).toBe(true)
      expect(r.out.join('\n')).toContain('failure path')
    } finally {
      rmSync(wt, { recursive: true, force: true })
    }
  })

  it('refuses on dirty worktree (real git check)', async () => {
    // Create a worktree with an uncommitted (untracked) file — git status
    // returns non-empty output so the guard fires.
    const wt = mkdtempSync(resolve(tmpdir(), 'mars-wt-dirty-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: wt })
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: wt })
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: wt })
      // Add an untracked file (dirty worktree)
      writeFileSync(resolve(wt, 'dirty.txt'), 'uncommitted')

      const taskId = await createAwaitingHumanTask('user@host', wt)
      const fake = makeFakeDaemon(() => undefined)
      const { store, ctx } = await loadStoreAndCtx()

      const r = await runCommandInProcess(['release', taskId], { store, ctx, daemon: fake })

      expect(r.code).toBe(1)
      const errJoined = r.err.join('\n')
      expect(errJoined).toContain('uncommitted changes')
      // Daemon should NOT have been called
      expect(fake.calls).toHaveLength(0)
    } finally {
      rmSync(wt, { recursive: true, force: true })
    }
  })

  it('refuses when task is not in awaiting-human status', async () => {
    // Create a task in 'queued' status (not awaiting-human)
    const { enqueueTask } = await import('../../core/queue')
    const task = await enqueueTask('test queued task', undefined, { skipTriage: true })
    const fake = makeFakeDaemon(() => undefined)
    const { store, ctx } = await loadStoreAndCtx()

    const r = await runCommandInProcess(['release', task.id], { store, ctx, daemon: fake })

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toMatch(/awaiting-human/)
    expect(fake.calls).toHaveLength(0)
  })

  it('refuses when no active lease is set', async () => {
    const taskId = await createAwaitingHumanTask(null)
    const fake = makeFakeDaemon(() => undefined)
    const { store, ctx } = await loadStoreAndCtx()

    const r = await runCommandInProcess(['release', taskId], { store, ctx, daemon: fake })

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('no active lease')
    expect(fake.calls).toHaveLength(0)
  })

  it('returns usage error when no task id is provided', async () => {
    const opts = await baseOpts()
    const r = await runCommandInProcess(['release'], opts)

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('usage: mars release')
  })
})
