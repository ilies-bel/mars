/**
 * Unit tests for the `stale-worktree` derived condition.
 *
 * Acceptance criteria (from the task brief):
 *  1. A worktree whose root dir mtime is old but whose .git was touched
 *     recently is NOT reported stale.
 *  2. A worktree where nothing has moved IS reported stale.
 *  3. The humanSummary copy makes no claim that anything is being cleaned up.
 *  4. `awaiting-human` tasks are excluded from the condition entirely.
 *  5. The `updated_at` DB signal counts as activity (recent DB row suppresses the row).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DbClient } from '../../lib/db.js'

// ── Mock readBudgetConfig (pulled in transitively by derived-conditions.ts) ────
vi.mock('../../lib/spend-meter.js', () => ({
  readBudgetConfig: vi.fn(() => null),
}))

import { createConditionItemsSource } from './derived-conditions.js'
import { lookupRecipe } from '../../lib/action-queue-recipes.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'mars-stale-wt-test-'))
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

/**
 * Insert a minimal task row with an explicit `updated_at` expressed as an
 * ISO string.  SQLite stores it verbatim; the derivation parses it with
 * `new Date(updated_at).getTime()`.
 */
async function seedTask(
  client: DbClient,
  id: string,
  status: string,
  updatedAtIso: string,
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO tasks (id, prompt, status, origin_id, created_at, updated_at)
          VALUES (?, ?, ?, NULL, ?, ?)`,
    args: [id, `task ${id}`, status, updatedAtIso, updatedAtIso],
  })
}

/**
 * Create a minimal fake worktree directory under `<repo>/.mars/worktrees/<id>`.
 * Returns the worktree path.
 */
function createWorktreeDir(repo: string, taskId: string): string {
  const worktreePath = join(repo, '.mars', 'worktrees', taskId)
  mkdirSync(worktreePath, { recursive: true })
  return worktreePath
}

/**
 * Create `<worktree>/.git` (as a directory with a HEAD file so it looks like
 * a real git worktree entry) and backdate the worktree root dir.
 *
 * Returns { worktreePath, gitPath }.
 */
function createWorktreeWithGit(
  repo: string,
  taskId: string,
): { worktreePath: string; gitPath: string } {
  const worktreePath = createWorktreeDir(repo, taskId)
  const gitPath = join(worktreePath, '.git')
  mkdirSync(gitPath, { recursive: true })
  writeFileSync(join(gitPath, 'HEAD'), 'ref: refs/heads/main\n')
  return { worktreePath, gitPath }
}

/** Set the mtime of a path to a given Date. */
function setMtime(p: string, d: Date): void {
  utimesSync(p, d, d)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('deriveStaleWorktreeConditions', { timeout: 60_000 }, () => {
  let repo: string
  let client: DbClient

  beforeEach(async () => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    // Disable the threshold env var so tests control staleness purely via
    // timestamps relative to the injected `nowMs`.
    delete process.env.MARS_STALE_WORKTREE_HOURS
    client = await makeClient(repo)
  })

  afterEach(async () => {
    await client.close()
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  // ── 1. Recent .git mtime suppresses the stale row ─────────────────────────

  it('does NOT report stale when .git was touched recently', async () => {
    const taskId = 'task-git-recent'
    const nowMs = Date.now()
    // Root dir and updated_at are 48 h old (well past the 24h default).
    const oldDate = new Date(nowMs - 48 * 3_600_000)
    // .git mtime is 1 h old (within the 24h threshold).
    const recentDate = new Date(nowMs - 1 * 3_600_000)

    const { worktreePath, gitPath } = createWorktreeWithGit(repo, taskId)
    setMtime(worktreePath, oldDate)
    setMtime(gitPath, recentDate)

    await seedTask(client, taskId, 'running', oldDate.toISOString())

    const source = createConditionItemsSource({
      getClient: () => client,
      repoRoot: repo,
      nowMs,
    })
    const rows = await source.derive({ kinds: new Set(['stale-worktree']) })
    expect(rows).toHaveLength(0)
  })

  // ── 2. Nothing moved → row is emitted ────────────────────────────────────

  it('reports stale when root dir, .git, and updated_at are all old', async () => {
    const taskId = 'task-all-old'
    const nowMs = Date.now()
    const oldDate = new Date(nowMs - 48 * 3_600_000)

    const { worktreePath, gitPath } = createWorktreeWithGit(repo, taskId)
    setMtime(worktreePath, oldDate)
    setMtime(gitPath, oldDate)

    await seedTask(client, taskId, 'running', oldDate.toISOString())

    const source = createConditionItemsSource({
      getClient: () => client,
      repoRoot: repo,
      nowMs,
    })
    const rows = await source.derive({ kinds: new Set(['stale-worktree']) })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe('stale-worktree')
    expect(rows[0]!.payload).toMatchObject({ status: 'running' })
  })

  // ── 3. humanSummary contains no cleanup/deletion language ─────────────────

  it('humanSummary makes no claim that anything is being cleaned up', () => {
    const recipe = lookupRecipe('stale-worktree')
    const summary = recipe.humanSummary({
      kind: 'stale-worktree',
      entityId: 'task-copy-test',
      payload: { ageHours: 42, status: 'running' } as Record<string, unknown>,
      raisedAt: new Date().toISOString(),
      title: '',
      body: '',
      context: {},
    })

    // Must NOT claim Mars is cleaning up, deleting, or removing anything.
    expect(summary).not.toMatch(/clean(?:ing)? up/i)
    expect(summary).not.toMatch(/delet/i)
    expect(summary).not.toMatch(/remov/i)
    // Must NOT tell the operator "no action needed" (it may be exactly backwards).
    expect(summary).not.toMatch(/no action needed/i)
    // Should still mention the age.
    expect(summary).toContain('42h')
  })

  // ── 4. awaiting-human tasks are excluded ─────────────────────────────────

  it('never emits a row for an awaiting-human task', async () => {
    const taskId = 'task-awaiting'
    const nowMs = Date.now()
    const oldDate = new Date(nowMs - 72 * 3_600_000) // very old

    const { worktreePath, gitPath } = createWorktreeWithGit(repo, taskId)
    setMtime(worktreePath, oldDate)
    setMtime(gitPath, oldDate)

    await seedTask(client, taskId, 'awaiting-human', oldDate.toISOString())

    const source = createConditionItemsSource({
      getClient: () => client,
      repoRoot: repo,
      nowMs,
    })
    const rows = await source.derive({ kinds: new Set(['stale-worktree']) })
    expect(rows).toHaveLength(0)
  })

  // ── 5. Recent updated_at suppresses the stale row ─────────────────────────

  it('does NOT report stale when updated_at is recent (even if filesystem is old)', async () => {
    const taskId = 'task-db-recent'
    const nowMs = Date.now()
    const oldDate = new Date(nowMs - 48 * 3_600_000)
    const recentDate = new Date(nowMs - 1 * 3_600_000)

    const { worktreePath, gitPath } = createWorktreeWithGit(repo, taskId)
    setMtime(worktreePath, oldDate)
    setMtime(gitPath, oldDate)

    // updated_at is recent — should suppress the stale row
    await seedTask(client, taskId, 'running', recentDate.toISOString())

    const source = createConditionItemsSource({
      getClient: () => client,
      repoRoot: repo,
      nowMs,
    })
    const rows = await source.derive({ kinds: new Set(['stale-worktree']) })
    expect(rows).toHaveLength(0)
  })
})
