/**
 * Regression: post-merge cleanup must not reclaim a worktree another live task
 * is standing on, and the resulting failure must not be able to halt the queue.
 *
 * THE DISEASE. A recovery (`kind='fix'`) does not carve its own worktree —
 * `attachToOriginWorktree` binds it to the ORIGIN's directory and branch so it
 * can continue that work in place. Both rows therefore carry the same
 * `worktree_path` / `branch`. Post-merge cleanup removed the directory and
 * deleted the branch for whichever task merged, with no check for other
 * referencing rows, so a recovery landing its work reclaimed the origin's
 * worktree while the origin was still live and still dispatchable. Observed on
 * mars-a13334fd: recovery fix-7a001daa merged, cleanup ran, and the origin
 * re-dispatched into a deleted directory ten times in under a minute.
 *
 * THE SECOND-ORDER BUG. That produces `verify:worktree-missing`, which was
 * designed to fail ONCE per task with a named signature — correct in itself,
 * but three DIFFERENT tasks each failing once still hits
 * SIGNATURE_STORM_TRIP_THRESHOLD and pauses ALL dispatch. A deliberate,
 * expected, per-task outcome must not read as a systemic storm.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { DbResultSet, DbStatement, DbInValue } from '../db'
import type { DomainTaskStore } from '../../store/task-store'
import { __resetDbRegistryForTests, openDb } from '../db'
import { createTaskStore } from '../../store/task-store'

afterEach(async () => {
  await __resetDbRegistryForTests()
})

/**
 * Minimal store stand-in: records the statement and replays canned rows. Only
 * `query` is exercised, so the rest of DomainTaskStore is deliberately absent.
 */
const stubStore = (
  rows: { id: string; status: string }[],
  capture?: { sql?: string; args?: readonly DbInValue[] },
): DomainTaskStore => {
  const store = {
    query: async (
      stmt: DbStatement | string,
      params?: DbInValue[],
    ): Promise<DbResultSet> => {
      if (capture) {
        capture.sql = typeof stmt === 'string' ? stmt : stmt.sql
        capture.args = typeof stmt === 'string' ? (params ?? []) : (stmt.args ?? [])
      }
      return { rows, columns: ['id', 'status'], rowsAffected: 0 } as unknown as DbResultSet
    },
  }
  return store as unknown as DomainTaskStore
}

describe('findLiveWorktreeDependents — who else is standing on this worktree', () => {
  it('reports a live origin sharing the merged recovery’s worktree and branch', async () => {
    const { findLiveWorktreeDependents } = await import('../worktree-dependents')
    const dependents = await findLiveWorktreeDependents({
      taskId: 'fix-7a001daa',
      worktreePath: '/repo/.mars/worktrees/mars-a13334fd',
      branch: 'task/mars-a13334fd',
      store: stubStore([{ id: 'mars-a13334fd', status: 'queued' }]),
    })

    // Non-empty means cleanup must keep the tree AND the branch.
    expect(dependents).toEqual([{ id: 'mars-a13334fd', status: 'queued' }])
  })

  it('excludes the merging task itself and every terminal row', async () => {
    const { findLiveWorktreeDependents } = await import('../worktree-dependents')
    const capture: { sql?: string; args?: readonly DbInValue[] } = {}
    await findLiveWorktreeDependents({
      taskId: 'fix-7a001daa',
      worktreePath: '/repo/.mars/worktrees/mars-a13334fd',
      branch: 'task/mars-a13334fd',
      store: stubStore([], capture),
    })

    // The merging task must never count as its own dependent...
    expect(capture.sql).toContain('id != ?')
    expect(capture.args?.[0]).toBe('fix-7a001daa')
    // ...and a terminal row can never be dispatched again, so it cannot be
    // harmed by the removal and must not block it.
    expect(capture.sql).toContain('status NOT IN')
    expect(capture.args).toContain('done')
    expect(capture.args).toContain('failed')
    expect(capture.args).toContain('dropped')
    // Matching on EITHER key: a row can carry the branch without the path.
    expect(capture.sql).toContain('worktree_path = ?')
    expect(capture.sql).toContain('branch = ?')
  })

  it('returns none when nothing else references the worktree (cleanup proceeds)', async () => {
    const { findLiveWorktreeDependents } = await import('../worktree-dependents')
    const dependents = await findLiveWorktreeDependents({
      taskId: 'mars-solo',
      worktreePath: '/repo/.mars/worktrees/mars-solo',
      branch: 'task/mars-solo',
      store: stubStore([]),
    })
    expect(dependents).toEqual([])
  })

  it('short-circuits without querying when the task has no worktree or branch', async () => {
    const { findLiveWorktreeDependents } = await import('../worktree-dependents')
    const capture: { sql?: string } = {}
    const dependents = await findLiveWorktreeDependents({
      taskId: 'mars-none',
      worktreePath: null,
      branch: null,
      store: stubStore([{ id: 'other', status: 'queued' }], capture),
    })
    expect(dependents).toEqual([])
    expect(capture.sql).toBeUndefined()
  })

  it('finds path-only and branch-only live collisions through the PostgreSQL query boundary', async () => {
    const { findLiveWorktreeDependents } = await import('../worktree-dependents')
    const store = createTaskStore(openDb(`worktree-dependents-${crypto.randomUUID()}`))
    const createdAt = new Date().toISOString()
    const insert = async (id: string, status: string, worktreePath: string | null, branch: string | null) => {
      await store.execute({
        sql: `INSERT INTO tasks (id, prompt, status, worktree_path, branch, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [id, 'collision fixture', status, worktreePath, branch, createdAt, createdAt],
      })
    }
    await insert('merging', 'merging', '/worktrees/merging', 'task/merging')
    await insert('path-collision', 'queued', '/worktrees/shared', null)
    await insert('branch-collision', 'running', null, 'task/shared')
    await insert('terminal-collision', 'done', '/worktrees/shared', 'task/shared')

    await expect(
      findLiveWorktreeDependents({
        taskId: 'merging',
        worktreePath: '/worktrees/shared',
        branch: null,
        store,
      }),
    ).resolves.toEqual([{ id: 'path-collision', status: 'queued' }])

    await expect(
      findLiveWorktreeDependents({
        taskId: 'merging',
        worktreePath: null,
        branch: 'task/shared',
        store,
      }),
    ).resolves.toEqual([{ id: 'branch-collision', status: 'running' }])
  })

  it('surfaces a collision lookup failure instead of treating it as no collision', async () => {
    const { findLiveWorktreeDependents } = await import('../worktree-dependents')
    const exploding = {
      query: async (): Promise<DbResultSet> => {
        throw new Error('connection reset')
      },
    } as unknown as DomainTaskStore

    await expect(
      findLiveWorktreeDependents({
        taskId: 'mars-x',
        worktreePath: '/repo/.mars/worktrees/mars-x',
        branch: 'task/mars-x',
        store: exploding,
      }),
    ).rejects.toThrow('connection reset')
  })
})

describe('verify:worktree-missing must not be able to pause the queue', () => {
  it('is registered environmental, so it never feeds the storm streak', async () => {
    const { isEnvironmentalSignature, lookupFailureKind } = await import(
      '../failure-kinds'
    )
    const sig = 'verify:worktree-missing/unclassified'

    // `isEnvironmentalSignature` is the gate queue-fix-tasks consults before
    // calling recordFailureSignature. Environmental => no streak, no pause,
    // auto-restart onto a fresh worktree instead.
    expect(isEnvironmentalSignature(sig)).toBe(true)

    const entry = lookupFailureKind(sig)
    expect(entry).not.toBeNull()
    expect(entry?.staticEncodable).toMatchObject({
      encodable: false,
      reason: 'environmental',
    })
    // The copy must not blame the coder for a tree that was taken away.
    expect(entry?.verboseReason.toLowerCase()).toContain('infrastructure')
    expect(entry?.verboseReason.toLowerCase()).not.toContain('did not produce')
  })

  it('stays orchestration-classified, so no code fixer is spawned for a missing tree', async () => {
    const { classifyFailure, isNonCodeFailure } = await import('../failure-class')
    const sig = 'verify:worktree-missing/unclassified'
    expect(classifyFailure(sig)).toBe('orchestration')
    expect(isNonCodeFailure(sig)).toBe(true)
  })

  it('does not accidentally make the has-diff no-commits verdict environmental', async () => {
    const { isEnvironmentalSignature } = await import('../failure-kinds')
    // A coder that genuinely produced nothing is still a real, coder-owned
    // failure — it must keep feeding the streak and keep its recovery.
    expect(isEnvironmentalSignature('verify:has-diff/no-commits-ahead')).toBe(false)
  })
})
