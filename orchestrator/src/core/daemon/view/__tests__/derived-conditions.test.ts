/**
 * Unit tests for derived-conditions.ts — specifically the daemon-died derivation
 * and the createConditionItemsSource factory.
 *
 * Regression guard for the ESM-require bug fixed in ADR-0057 follow-up:
 * `require('node:fs')` inside deriveDaemonDiedConditions failed silently
 * (caught by the surrounding try/catch), meaning crash markers were found but
 * their pid/startedAt/crashDetectedAt were never parsed — the item was emitted
 * with placeholder values instead. This test asserts the real values from a
 * written crash marker appear in the returned item.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createConditionItemsSource } from '../derived-conditions.js'
import { humanSummary as recipeHumanSummary } from '../../../lib/action-queue-recipes.js'
import type { DbClient, DbStatement } from '../../../lib/db.js'

// ── Minimal mock DbClient ─────────────────────────────────────────────────────
// daemon-died derivation is filesystem-only; it never touches the DB.
const emptyDbClient: DbClient = {
  execute: async () => ({ rows: [], rowsAffected: 0 }),
  batch: async () => [],
  close: async () => {},
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeTmpDir = (): string => mkdtempSync(resolve(tmpdir(), 'mars-derived-conds-'))

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createConditionItemsSource — daemon-died derivation', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns empty array when crash marker is absent', async () => {
    const source = createConditionItemsSource({
      getClient: () => emptyDbClient,
      crashMarkerPath: resolve(tmpDir, 'does-not-exist.json'),
    })
    const rows = await source.derive({ kinds: new Set(['daemon-died']) })
    expect(rows).toEqual([])
  })

  it('returns a daemon-died row when crash marker file exists', async () => {
    const markerPath = resolve(tmpDir, 'daemon.crash.json')
    const crashInfo = {
      pid: 9876,
      startedAt: '2026-08-01T10:00:00.000Z',
      crashDetectedAt: '2026-08-01T10:45:00.000Z',
    }
    writeFileSync(markerPath, JSON.stringify(crashInfo))

    const source = createConditionItemsSource({
      getClient: () => emptyDbClient,
      crashMarkerPath: markerPath,
    })
    const rows = await source.derive({ kinds: new Set(['daemon-died']) })

    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.kind).toBe('daemon-died')
    expect(row.priority).toBe('high')
    expect(row.title).toBe('Daemon exited unexpectedly')
    // These three assertions fail before the fix because require('node:fs')
    // throws into the catch, leaving pid=0 and startedAt='' in the output.
    expect(row.payload).toMatchObject({
      pid: crashInfo.pid,
      startedAt: crashInfo.startedAt,
      crashDetectedAt: crashInfo.crashDetectedAt,
    })
    expect(row.body).toContain(String(crashInfo.pid))
    expect(row.body).toContain(crashInfo.startedAt)
  })

  it('still returns a row with default values when crash marker is malformed JSON', async () => {
    const markerPath = resolve(tmpDir, 'bad.json')
    writeFileSync(markerPath, 'not-valid-json')

    const source = createConditionItemsSource({
      getClient: () => emptyDbClient,
      crashMarkerPath: markerPath,
    })
    const rows = await source.derive({ kinds: new Set(['daemon-died']) })

    // A row is still emitted — presence alone is enough.
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe('daemon-died')
    // pid defaults to 0 (unknown) when JSON is unreadable.
    expect((rows[0]!.payload as { pid: number }).pid).toBe(0)
  })

  it('returns empty array when no kinds match (kinds hint respected)', async () => {
    const markerPath = resolve(tmpDir, 'daemon.crash.json')
    writeFileSync(markerPath, JSON.stringify({ pid: 1, startedAt: '2026-01-01T00:00:00.000Z', crashDetectedAt: '2026-01-01T01:00:00.000Z' }))

    const source = createConditionItemsSource({
      getClient: () => emptyDbClient,
      crashMarkerPath: markerPath,
    })
    // Requesting a kind that daemon-died is not — result must be empty.
    const rows = await source.derive({ kinds: new Set(['failed']) })
    // All DB queries return empty rows, so no 'failed' items either.
    expect(rows).toEqual([])
  })
})

// ── stale-queued: phantom in-flight-status misattribution ──────────────────
//
// Incident shape (mars-6340b827 / mars-d039e664): a hard `mars daemon
// restart` leaves N task rows in an in-flight DB status (running/verifying/
// merging/vega-reconciling) with zero live jobs in the in-memory tracker.
// `deriveStaleQueuedConditions` only suppressed the alert when the *live*
// tracker count reached the implement cap, so it never suppressed — and the
// generic recipe copy blamed "the worker pool may be saturated or the
// dispatcher may be stuck" instead of naming the actual cause. These tests
// assert the row's payload carries `inFlightStatusCount` and that the
// recipe's `humanSummary` names the phantom rows (not the queued task) as
// the cause when the mismatch is present, while staying generic when the
// tracker genuinely holds the in-flight jobs.

const IN_FLIGHT_STATUS_SQL_FRAGMENT = "IN ('running', 'verifying', 'merging', 'vega-reconciling')"

/**
 * A mock DbClient that answers the two queries `deriveStaleQueuedConditions`
 * issues: the in-flight-status COUNT(*) and the queued-tasks SELECT.
 */
const makeStaleQueuedDbClient = (opts: {
  inFlightStatusCount: number
  queuedTasks: Array<{ id: string; updatedAtIso: string; prompt: string }>
}): DbClient => ({
  execute: async (stmt: DbStatement) => {
    const sql = typeof stmt === 'string' ? stmt : stmt.sql
    if (sql.includes(IN_FLIGHT_STATUS_SQL_FRAGMENT)) {
      return { rows: [{ n: opts.inFlightStatusCount }], rowsAffected: 0 }
    }
    if (sql.includes("status = 'queued'")) {
      return {
        rows: opts.queuedTasks.map((t) => ({ id: t.id, updated_at: t.updatedAtIso, prompt: t.prompt })),
        rowsAffected: 0,
      }
    }
    return { rows: [], rowsAffected: 0 }
  },
  batch: async () => [],
  close: async () => {},
})

describe('createConditionItemsSource — stale-queued phantom in-flight attribution', () => {
  const NOW = Date.parse('2026-08-19T12:00:00.000Z')
  const STALE_UPDATED_AT = new Date(NOW - 20 * 60_000).toISOString() // 20 min ago

  it('attributes the alert to phantom in-flight rows when the tracker is empty but the DB shows the cap saturated', async () => {
    const client = makeStaleQueuedDbClient({
      inFlightStatusCount: 5,
      queuedTasks: [{ id: 'mars-stale-1', updatedAtIso: STALE_UPDATED_AT, prompt: 'do the thing' }],
    })
    const source = createConditionItemsSource({
      getClient: () => client,
      getActiveWorkerCount: () => 0,
      getImplementCap: () => 5,
      nowMs: NOW,
    })

    const rows = await source.derive({ kinds: new Set(['stale-queued']) })
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.payload['inFlightStatusCount']).toBe(5)
    expect(row.payload['activeWorkerCount']).toBe(0)
    expect(row.payload['implementCap']).toBe(5)

    const summary = recipeHumanSummary('stale-queued', row.payload)
    expect(summary).toContain('stuck in an in-flight status')
    expect(summary).toContain('mars sync')
    expect(summary).not.toContain('the worker slots may be full or the task processor may be stuck')
  })

  it('keeps the generic message when the tracker genuinely holds the in-flight jobs (no phantom mismatch)', async () => {
    const client = makeStaleQueuedDbClient({
      inFlightStatusCount: 2,
      queuedTasks: [{ id: 'mars-stale-2', updatedAtIso: STALE_UPDATED_AT, prompt: 'do another thing' }],
    })
    const source = createConditionItemsSource({
      getClient: () => client,
      getActiveWorkerCount: () => 2,
      getImplementCap: () => 5,
      nowMs: NOW,
    })

    const rows = await source.derive({ kinds: new Set(['stale-queued']) })
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.payload['inFlightStatusCount']).toBe(2)
    expect(row.payload['activeWorkerCount']).toBe(2)

    const summary = recipeHumanSummary('stale-queued', row.payload)
    expect(summary).toContain('the worker slots may be full or the task processor may be stuck')
    expect(summary).not.toContain('phantom')
    expect(summary).not.toContain('mars sync')
  })
})

// ── stale-queued derivation: the row's own title/body ───────────────────────
//
// Same incident, the layer above: `mars daemon status` showed 14 rows stuck in
// an in-flight DB status (`verifying`) with the live tracker reporting
// `inFlight: 0` — phantom rows left behind by a hard-stopped prior daemon. The
// queued tasks waiting behind them got flagged by stale-queued as if they were
// the problem, when the phantom rows were. Where the suite above covers the
// recipe's `humanSummary`, these assert the derived row's own `title`/`body`
// and its `phantomInFlightCount` — the DB count minus the live tracker count,
// which catches a partial mismatch and not just a fully saturated cap.
describe('createConditionItemsSource — stale-queued derivation', () => {
  const NOW = Date.parse('2026-08-19T12:00:00.000Z')
  const OLD_ENOUGH = new Date(NOW - 20 * 60_000).toISOString() // 20 min old > 10 min threshold

  /** Builds a mock DbClient that answers the two queries stale-queued issues. */
  const makeDbClient = (opts: {
    queuedRows?: Array<{ id: string; updated_at: string; prompt: string }>
    inFlightCount?: number
  }): DbClient => ({
    execute: async (stmt: DbStatement) => {
      const sql = typeof stmt === 'string' ? stmt : stmt.sql
      if (sql.includes("status = 'queued'")) {
        return { rows: opts.queuedRows ?? [], rowsAffected: 0 }
      }
      if (sql.includes('IN (')) {
        // Same `AS n` alias the derivation selects — see makeStaleQueuedDbClient.
        return { rows: [{ n: opts.inFlightCount ?? 0 }], rowsAffected: 0 }
      }
      return { rows: [], rowsAffected: 0 }
    },
    batch: async () => [],
    close: async () => {},
  })

  it('blames the queued task by default when nothing is phantom', async () => {
    const client = makeDbClient({
      queuedRows: [{ id: 'task-a', updated_at: OLD_ENOUGH, prompt: 'do the thing' }],
      inFlightCount: 0,
    })
    const source = createConditionItemsSource({
      getClient: () => client,
      getActiveWorkerCount: () => 0,
      getImplementCap: () => 6,
      nowMs: NOW,
    })

    const rows = await source.derive({ kinds: new Set(['stale-queued']) })

    expect(rows).toHaveLength(1)
    expect(rows[0]!.title).not.toContain('phantom')
    expect(rows[0]!.body).not.toContain('phantom')
    expect((rows[0]!.payload as { phantomInFlightCount: number }).phantomInFlightCount).toBe(0)
  })

  it('names phantom in-flight rows instead of blaming the queued task', async () => {
    // DB says 14 rows are in an in-flight status; the live tracker knows of
    // none of them — exactly the incident's 14/0 split.
    const client = makeDbClient({
      queuedRows: [{ id: 'task-a', updated_at: OLD_ENOUGH, prompt: 'do the thing' }],
      inFlightCount: 14,
    })
    const source = createConditionItemsSource({
      getClient: () => client,
      getActiveWorkerCount: () => 0,
      getImplementCap: () => 6,
      nowMs: NOW,
    })

    const rows = await source.derive({ kinds: new Set(['stale-queued']) })

    expect(rows).toHaveLength(1)
    expect(rows[0]!.title).toContain('phantom in-flight row')
    expect(rows[0]!.title).toContain('14')
    expect(rows[0]!.body).toContain('not at fault')
    expect(rows[0]!.body).toContain('mars sync')
    expect((rows[0]!.payload as { phantomInFlightCount: number }).phantomInFlightCount).toBe(14)
  })

  it('does not treat in-flight rows genuinely owned by live jobs as phantom', async () => {
    // DB shows 3 in-flight rows and the tracker reports the same 3 active —
    // no gap, so no phantom accusation even though the pool isn't empty.
    const client = makeDbClient({
      queuedRows: [{ id: 'task-a', updated_at: OLD_ENOUGH, prompt: 'do the thing' }],
      inFlightCount: 3,
    })
    const source = createConditionItemsSource({
      getClient: () => client,
      getActiveWorkerCount: () => 3,
      getImplementCap: () => 6,
      nowMs: NOW,
    })

    const rows = await source.derive({ kinds: new Set(['stale-queued']) })

    expect(rows).toHaveLength(1)
    expect(rows[0]!.title).not.toContain('phantom')
    expect((rows[0]!.payload as { phantomInFlightCount: number }).phantomInFlightCount).toBe(0)
  })
})

// ── deriveFailedConditions: recovery-task suppression by origin status ────────
//
// Regression guard for the 2026-08-27 incident: a recovery task (fix_for_task_id
// set) whose origin was `dropped` continued to emit a `failed` row even though
// `dropped` is a settled terminal status that carries no actionable obligation.
//
// The fix: change the suppression predicate from `origin.status = 'done'` to
// `origin.status IN ('done', 'dropped')`, matching the settlement rule in
// CLAUDE.md ("dropped settles because it is terminal and can never become done").
//
// Five cases are covered (uses a real PGlite DB to exercise the actual SQL):
//   - origin `failed`  → row emitted (recovery exhausted — the actionable case)
//   - origin `queued`  → row suppressed (non-terminal, operator cannot act)
//   - origin `done`    → row suppressed (already passing before the fix)
//   - origin `dropped` → row suppressed (the fix — was incorrectly emitted before)
//   - origin absent    → row still emitted (orphaned-origin case: keep visible)

function setupSuppressRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'mars-dc-suppress-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(join(repo, '.mars'), { recursive: true })
  return repo
}

async function makeSuppressClient(repo: string): Promise<DbClient> {
  const { openDb } = await import('../../../lib/db.js')
  const { ensureSchema } = await import('../../../lib/pg-schema.js')
  const client = openDb(resolve(repo, '.mars'))
  await ensureSchema(client)
  return client
}

async function seedSuppressTask(
  client: DbClient,
  id: string,
  status: string,
  opts: { fixForTaskId?: string } = {},
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO tasks (id, prompt, status, fix_for_task_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, NOW(), NOW())`,
    args: [id, `task ${id}`, status, opts.fixForTaskId ?? null],
  })
}

describe(
  'deriveFailedConditions — origin-status suppression for recovery tasks',
  { timeout: 60_000 },
  () => {
    let repo: string
    let client: DbClient

    beforeEach(async () => {
      repo = setupSuppressRepo()
      process.env.MARS_REPO = repo
      vi.resetModules()
      client = await makeSuppressClient(repo)
    })

    afterEach(async () => {
      await client.close()
      delete process.env.MARS_REPO
      rmSync(repo, { recursive: true, force: true })
    })

    it('emits a row when the origin is failed (recovery exhausted — actionable)', async () => {
      await seedSuppressTask(client, 'origin-failed', 'failed')
      await seedSuppressTask(client, 'fix-failed', 'failed', { fixForTaskId: 'origin-failed' })

      const source = createConditionItemsSource({ getClient: () => client })
      const rows = await source.derive({ kinds: new Set(['failed']) })
      const ids = rows.map((r) => r.payload['taskId'])

      expect(ids).toContain('fix-failed')
    })

    it('suppresses the row when the origin is queued (non-terminal, operator cannot act)', async () => {
      await seedSuppressTask(client, 'origin-queued', 'queued')
      await seedSuppressTask(client, 'fix-queued', 'failed', { fixForTaskId: 'origin-queued' })

      const source = createConditionItemsSource({ getClient: () => client })
      const rows = await source.derive({ kinds: new Set(['failed']) })
      const ids = rows.map((r) => r.payload['taskId'])

      expect(ids).not.toContain('fix-queued')
    })

    it('suppresses the row when the origin is done (recovery moot — already passing)', async () => {
      await seedSuppressTask(client, 'origin-done', 'done')
      await seedSuppressTask(client, 'fix-done', 'failed', { fixForTaskId: 'origin-done' })

      const source = createConditionItemsSource({ getClient: () => client })
      const rows = await source.derive({ kinds: new Set(['failed']) })
      const ids = rows.map((r) => r.payload['taskId'])

      expect(ids).not.toContain('fix-done')
    })

    it('suppresses the row when the origin is dropped (recovery moot — work cancelled)', async () => {
      // Regression test for 2026-08-27 incident: fix-9b733a8b kept emitting a
      // high-priority failed alert after its origin mars-efd984fb was dropped
      // (superseded). The operator was asked to act on work that already shipped
      // under mars-76c56dbe. `dropped` settles the same way `done` does.
      await seedSuppressTask(client, 'origin-dropped', 'dropped')
      await seedSuppressTask(client, 'fix-dropped', 'failed', { fixForTaskId: 'origin-dropped' })

      const source = createConditionItemsSource({ getClient: () => client })
      const rows = await source.derive({ kinds: new Set(['failed']) })
      const ids = rows.map((r) => r.payload['taskId'])

      expect(ids).not.toContain('fix-dropped')
    })

    it('still emits a row when the origin row is absent (hard-deleted / orphaned)', async () => {
      // In production, hard-deleting the origin task without the orchestrator's
      // FK-edge cleanup would leave the fix task referencing a ghost id. We
      // simulate this by temporarily dropping the FK constraint so the test can
      // insert the referentially-impossible row, exercising the NOT EXISTS logic
      // rather than the ORM deletion path. The constraint is non-deferrable and
      // PGlite is in-memory, so the test DB is ephemeral — restoration is a no-op.
      await client.execute('ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_fix_for_task_id_fkey')
      await seedSuppressTask(client, 'fix-orphan', 'failed', { fixForTaskId: 'ghost-origin' })

      const source = createConditionItemsSource({ getClient: () => client })
      const rows = await source.derive({ kinds: new Set(['failed']) })
      const ids = rows.map((r) => r.payload['taskId'])

      expect(ids).toContain('fix-orphan')
    })
  },
)

// ── derivePhantomMergeConditions — landing-verification paths ─────────────────
//
// These tests exercise the three outcomes of the git-based landing check:
//
//  1. 'landed'  — branch/checkpoint work is reachable from the integration
//                 branch → no alert raised.
//  2. 'missing' — surviving evidence shows commits NOT on the integration
//                 branch → phantom-merge alert raised, naming the ref.
//  3. 'unknown' — no branch and no checkpoint refs → phantom-merge-unknown
//                 alert raised (lower priority, informational).
//
// Each test uses a unique task ID so the module-level outcome cache never
// pollutes a sibling test.

/** Create a minimal git repo, return its absolute path and the main branch name. */
function setupPhantomRepo(): { repoRoot: string; branch: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'mars-phantom-'))
  execFileSync('git', ['init', '-q'], { cwd: repoRoot })
  execFileSync('git', ['config', 'user.email', 'ci@test'], { cwd: repoRoot })
  execFileSync('git', ['config', 'user.name', 'CI'], { cwd: repoRoot })
  writeFileSync(join(repoRoot, 'README.md'), 'init')
  // PGlite stores its data at <marsDir>.pglite (i.e. .mars.pglite/ here).
  // Without a .gitignore, `git add -A` stages those files and a subsequent
  // `git checkout <branch>` deletes them when switching back to main, which
  // corrupts the open PGlite instance and causes "could not open file" errors.
  // The .mars/ directory (tombstones, worktrees) must also be excluded so that
  // `writeTombstone` files added after branch creation are not inadvertently
  // staged by `git add -A` on the task branch.
  writeFileSync(join(repoRoot, '.gitignore'), '.mars/\n.mars.pglite/\n')
  execFileSync('git', ['add', '-A'], { cwd: repoRoot })
  execFileSync('git', ['commit', '-m', 'initial', '--no-gpg-sign'], { cwd: repoRoot })
  // Normalise to 'main' regardless of the git default.
  const currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim()
  if (currentBranch !== 'main') {
    execFileSync('git', ['branch', '-m', currentBranch, 'main'], { cwd: repoRoot })
  }
  mkdirSync(join(repoRoot, '.mars', 'worktrees'), { recursive: true })
  return { repoRoot, branch: 'main' }
}

async function makePhantomClient(repoRoot: string): Promise<DbClient> {
  const { openDb } = await import('../../../lib/db.js')
  const { ensureSchema } = await import('../../../lib/pg-schema.js')
  const client = openDb(join(repoRoot, '.mars'))
  await ensureSchema(client)
  return client
}

async function seedDoneTask(client: DbClient, taskId: string): Promise<void> {
  await client.execute({
    sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
          VALUES (?, ?, 'done', NOW(), NOW())`,
    args: [taskId, `task ${taskId}`],
  })
}

function writeTombstone(repoRoot: string, taskId: string): void {
  // Ensure the directory exists — openDb() may recreate .mars/ contents
  // after setupPhantomRepo() creates worktrees/, so we guard here.
  const worktreesDir = join(repoRoot, '.mars', 'worktrees')
  mkdirSync(worktreesDir, { recursive: true })
  const tombstone = {
    taskId,
    reason: 'merged',
    mergeCommitSha: null,
    removedAt: new Date().toISOString(),
  }
  writeFileSync(join(worktreesDir, `${taskId}.removed.json`), JSON.stringify(tombstone))
}

describe(
  'derivePhantomMergeConditions — landing verification',
  { timeout: 60_000 },
  () => {
    let repoRoot: string
    let client: DbClient
    const origIntBranch = process.env.INTEGRATION_BRANCH

    beforeEach(async () => {
      const setup = setupPhantomRepo()
      repoRoot = setup.repoRoot
      // Pin INTEGRATION_BRANCH to 'main' so integrationBranchName() resolves
      // to the same name as the branch we create in git init above.
      process.env.INTEGRATION_BRANCH = 'main'
      vi.resetModules()
      client = await makePhantomClient(repoRoot)
    })

    afterEach(async () => {
      await client.close()
      if (origIntBranch === undefined) {
        delete process.env.INTEGRATION_BRANCH
      } else {
        process.env.INTEGRATION_BRANCH = origIntBranch
      }
      rmSync(repoRoot, { recursive: true, force: true })
    })

    it('does not raise phantom-merge when the task branch has 0 commits ahead of main', async () => {
      const taskId = 'mars-pm-branch-clean'
      await seedDoneTask(client, taskId)
      writeTombstone(repoRoot, taskId)

      // Create the task branch at the same commit as main — zero commits ahead.
      execFileSync('git', ['branch', `task/${taskId}`], { cwd: repoRoot })

      const source = createConditionItemsSource({ getClient: () => client, repoRoot })
      const rows = await source.derive({
        kinds: new Set(['phantom-merge', 'phantom-merge-unknown']),
      })
      expect(rows).toHaveLength(0)
    })

    it('does not raise phantom-merge when a checkpoint ref commit is reachable from main', async () => {
      const taskId = 'mars-pm-ckpt-clean'
      await seedDoneTask(client, taskId)
      writeTombstone(repoRoot, taskId)

      // Land the "task's" commit directly on main — the checkpoint SHA is on main.
      writeFileSync(join(repoRoot, `${taskId}.txt`), 'landed content')
      execFileSync('git', ['add', '-A'], { cwd: repoRoot })
      execFileSync('git', ['commit', '-m', `feat: ${taskId}`, '--no-gpg-sign'], { cwd: repoRoot })
      const landedSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf8',
      }).trim()

      // Point a checkpoint ref at that already-landed SHA (no task branch).
      execFileSync(
        'git',
        ['update-ref', `refs/mars/checkpoint/${taskId}-code-periodic`, landedSha],
        { cwd: repoRoot },
      )

      const source = createConditionItemsSource({ getClient: () => client, repoRoot })
      const rows = await source.derive({
        kinds: new Set(['phantom-merge', 'phantom-merge-unknown']),
      })
      expect(rows).toHaveLength(0)
    })

    it('raises phantom-merge when the task branch has commits not on main', async () => {
      const taskId = 'mars-pm-unlanded'
      await seedDoneTask(client, taskId)

      // Create a divergent commit on the task branch that never landed on main.
      // IMPORTANT: write the tombstone AFTER returning to main — git checkout main
      // removes files that were added only on the task branch from the working tree,
      // and "git add -A" would stage the tombstone and commit it to the task branch.
      execFileSync('git', ['checkout', '-b', `task/${taskId}`, '--no-track', 'main'], {
        cwd: repoRoot,
      })
      writeFileSync(join(repoRoot, `${taskId}.txt`), 'unlanded work')
      execFileSync('git', ['add', '-A'], { cwd: repoRoot })
      execFileSync('git', ['commit', '-m', `feat: ${taskId} work`, '--no-gpg-sign'], {
        cwd: repoRoot,
      })
      execFileSync('git', ['checkout', 'main'], { cwd: repoRoot })
      // Write tombstone now — after returning to main so it survives in the worktree.
      writeTombstone(repoRoot, taskId)

      const source = createConditionItemsSource({ getClient: () => client, repoRoot })
      const rows = await source.derive({
        kinds: new Set(['phantom-merge', 'phantom-merge-unknown']),
      })

      const phantomRow = rows.find((r) => r.kind === 'phantom-merge')
      expect(phantomRow).toBeDefined()
      expect(phantomRow?.payload['taskId']).toBe(taskId)
      // The body must name the task branch so the operator knows what to recover from.
      expect(phantomRow?.body).toContain(`task/${taskId}`)
    })

    it('raises phantom-merge-unknown when no branch and no checkpoint refs survive', async () => {
      const taskId = 'mars-pm-no-evidence'
      await seedDoneTask(client, taskId)
      writeTombstone(repoRoot, taskId)
      // No branch and no checkpoint refs — nothing to verify against.

      const source = createConditionItemsSource({ getClient: () => client, repoRoot })
      const rows = await source.derive({
        kinds: new Set(['phantom-merge', 'phantom-merge-unknown']),
      })

      const unknownRow = rows.find((r) => r.kind === 'phantom-merge-unknown')
      expect(unknownRow).toBeDefined()
      expect(unknownRow?.payload['taskId']).toBe(taskId)
      // Must NOT raise a high-priority phantom-merge for an unknown outcome.
      expect(rows.filter((r) => r.kind === 'phantom-merge')).toHaveLength(0)
    })

    // Regression test for the false-positive phantom-merge bug:
    // A checkpoint ref that is NOT patch-equivalent to the integration branch
    // (git cherry would report '+') but whose touched paths ARE all present on
    // the integration branch must yield outcome='landed' and raise NO row.
    //
    // This is the exact scenario that produced the four permanently-open false
    // positives documented in the task brief: a periodic snapshot is by
    // construction almost never patch-identical to what eventually merged
    // (the coder kept editing; the branch was rebased; the merge may have
    // squashed) even when the work clearly landed.
    it('does not raise phantom-merge when checkpoint paths are present on main despite not being patch-equivalent', async () => {
      const taskId = 'mars-pm-ckpt-content-match'
      await seedDoneTask(client, taskId)

      // Create a task branch with a "checkpoint" commit that adds taskFile.txt
      // with content "checkpoint snapshot — not the final version".
      execFileSync('git', ['checkout', '-b', `task/${taskId}`, 'main'], { cwd: repoRoot })
      writeFileSync(join(repoRoot, `${taskId}.txt`), 'checkpoint snapshot — not the final version')
      execFileSync('git', ['add', '-A'], { cwd: repoRoot })
      execFileSync(
        'git',
        ['commit', '-m', `wip: ${taskId} mid-work snapshot`, '--no-gpg-sign'],
        { cwd: repoRoot },
      )
      const checkpointSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf8',
      }).trim()

      // Back on main, land the FINAL version of the same file — different content
      // so git cherry reports '+' (not patch-equivalent) yet the path is present.
      execFileSync('git', ['checkout', 'main'], { cwd: repoRoot })
      writeFileSync(join(repoRoot, `${taskId}.txt`), 'final landed content — different from snapshot')
      execFileSync('git', ['add', '-A'], { cwd: repoRoot })
      execFileSync(
        'git',
        ['commit', '-m', `feat: ${taskId} final version`, '--no-gpg-sign'],
        { cwd: repoRoot },
      )

      // Delete the task branch (simulating post-merge cleanup) and write the
      // tombstone so the function under test picks it up.
      execFileSync('git', ['branch', '-D', `task/${taskId}`], { cwd: repoRoot })
      writeTombstone(repoRoot, taskId)

      // Point the checkpoint ref at the mid-work snapshot — NOT the commit that
      // actually landed on main.
      execFileSync(
        'git',
        ['update-ref', `refs/mars/checkpoint/${taskId}-code-periodic`, checkpointSha],
        { cwd: repoRoot },
      )

      const source = createConditionItemsSource({ getClient: () => client, repoRoot })
      const rows = await source.derive({
        kinds: new Set(['phantom-merge', 'phantom-merge-unknown']),
      })

      // Content-containment should detect that taskId.txt is present on main
      // and yield outcome='landed' — no row of any kind should be raised.
      expect(rows).toHaveLength(0)
    })

    it('raises phantom-merge naming missing paths when checkpoint paths are absent from main', async () => {
      const taskId = 'mars-pm-ckpt-missing-paths'
      await seedDoneTask(client, taskId)

      // Create a task branch with a commit that adds a file that NEVER lands
      // on main — the work genuinely did not land.
      execFileSync('git', ['checkout', '-b', `task/${taskId}`, 'main'], { cwd: repoRoot })
      writeFileSync(join(repoRoot, `${taskId}-unlanded.txt`), 'this file will not land on main')
      execFileSync('git', ['add', '-A'], { cwd: repoRoot })
      execFileSync(
        'git',
        ['commit', '-m', `feat: ${taskId} work`, '--no-gpg-sign'],
        { cwd: repoRoot },
      )
      const checkpointSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf8',
      }).trim()

      // Return to main WITHOUT committing the task file.
      execFileSync('git', ['checkout', 'main'], { cwd: repoRoot })
      execFileSync('git', ['branch', '-D', `task/${taskId}`], { cwd: repoRoot })
      writeTombstone(repoRoot, taskId)

      execFileSync(
        'git',
        ['update-ref', `refs/mars/checkpoint/${taskId}-code-periodic`, checkpointSha],
        { cwd: repoRoot },
      )

      const source = createConditionItemsSource({ getClient: () => client, repoRoot })
      const rows = await source.derive({
        kinds: new Set(['phantom-merge', 'phantom-merge-unknown']),
      })

      const phantomRow = rows.find((r) => r.kind === 'phantom-merge')
      expect(phantomRow).toBeDefined()
      expect(phantomRow?.payload['taskId']).toBe(taskId)
      // The body must name the missing path so the operator knows what to recover.
      expect(phantomRow?.body).toContain(`${taskId}-unlanded.txt`)
    })
  },
)

// ── gate-broken recipe: no UUID or CLI command in humanSummary (DEC-18) ─────────
//
// The gate-broken card has a "Restore gate" button and a "Copy restore command"
// button. The body must carry only the intent — not the machine string
// (UUID gate id or CLI command). This was a regression: the body used to end
// with `Run \`mars verify-gate restore <uuid>\``, duplicating what the buttons
// already provide and exposing a raw UUID on the card face.

describe('gate-broken recipe — humanSummary', () => {
  it('does not expose the gate UUID or CLI command when scope/name are present', () => {
    const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
    const gateUuid = '98f6af73-da2f-44d0-9264-e1da2bcc493e'
    const summary = recipeHumanSummary('gate-broken', {
      gate: gateUuid,
      scope: 'ui',
      name: 'e2e-smoke',
      required: false,
      verdict: 'flaky-test',
    })
    // The UUID must not appear — the "Copy restore command" button is its home.
    expect(summary).not.toMatch(UUID_RE)
    // The human-readable identity must be used instead.
    expect(summary).toContain('ui/e2e-smoke')
    // The button carries the action; the body carries only the intent.
    expect(summary).toContain('Restore it once the underlying failure is fixed')
    // No CLI instruction should appear on the card face.
    expect(summary).not.toContain('mars verify-gate restore')
  })

  it('does not expose the gate UUID even when scope/name fall back to gate', () => {
    // When scope/name are absent, identity falls back to verdict || gate.
    // Even in that case the CLI command must not appear.
    const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
    const gateUuid = '98f6af73-da2f-44d0-9264-e1da2bcc493e'
    const summary = recipeHumanSummary('gate-broken', {
      gate: gateUuid,
      scope: '',
      name: '',
      required: false,
      verdict: 'flaky-test',
    })
    // verdict is present so identity = 'flaky-test', not the UUID.
    expect(summary).not.toMatch(UUID_RE)
    expect(summary).not.toContain('mars verify-gate restore')
    expect(summary).toContain('Restore it once the underlying failure is fixed')
  })
})

// ── signature-wave: bulkContinuable payload field ────────────────────────────
//
// `deriveSignatureWaveConditions` must compute `bulkContinuable` from the
// `worktree_path` and `failure_reason` columns fetched alongside the tasks.
// The wave is only bulk-continuable when EVERY member has an existing worktree
// AND has not exhausted its recovery slot.

const WAVE_SIGNATURE = 'code/rate-limit'
const NOW_WAVE = Date.parse('2026-09-11T12:00:00.000Z')
const UPDATED_AT = new Date(NOW_WAVE - 60_000).toISOString()

/**
 * Build a mock DbClient that answers the `failure_signature IS NOT NULL`
 * query with the given task rows.
 */
const makeWaveDbClient = (
  tasks: Array<{
    id: string
    failure_signature: string
    error: string | null
    updated_at: string
    worktree_path: string | null
    failure_reason: string | null
  }>,
): DbClient => ({
  execute: async (stmt: DbStatement) => {
    const sql = typeof stmt === 'string' ? stmt : stmt.sql
    if (sql.includes('failure_signature IS NOT NULL')) {
      return { rows: tasks, rowsAffected: 0 }
    }
    return { rows: [], rowsAffected: 0 }
  },
  batch: async () => [],
  close: async () => {},
})

describe('signature-wave — bulkContinuable payload', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-wave-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('sets bulkContinuable=true when all members have existing worktrees and no exhausted slots', async () => {
    const tasks = [
      { id: 'mars-1', failure_signature: WAVE_SIGNATURE, error: null, updated_at: UPDATED_AT, worktree_path: tmpDir, failure_reason: null },
      { id: 'mars-2', failure_signature: WAVE_SIGNATURE, error: null, updated_at: UPDATED_AT, worktree_path: tmpDir, failure_reason: null },
      { id: 'mars-3', failure_signature: WAVE_SIGNATURE, error: null, updated_at: UPDATED_AT, worktree_path: tmpDir, failure_reason: null },
    ]
    const source = createConditionItemsSource({
      getClient: () => makeWaveDbClient(tasks),
      nowMs: NOW_WAVE,
    })
    const rows = await source.derive({ kinds: new Set(['signature-wave']) })

    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.kind).toBe('signature-wave')
    expect(row.payload['bulkContinuable']).toBe(true)
    expect(row.payload['caughtTaskIds']).toEqual(['mars-1', 'mars-2', 'mars-3'])
  })

  it('sets bulkContinuable=false when any member has a recovery-exhausted reason', async () => {
    const tasks = [
      { id: 'mars-1', failure_signature: WAVE_SIGNATURE, error: null, updated_at: UPDATED_AT, worktree_path: tmpDir, failure_reason: null },
      { id: 'mars-2', failure_signature: WAVE_SIGNATURE, error: null, updated_at: UPDATED_AT, worktree_path: tmpDir, failure_reason: 'recovery_exhausted:prior recovery failed' },
      { id: 'mars-3', failure_signature: WAVE_SIGNATURE, error: null, updated_at: UPDATED_AT, worktree_path: tmpDir, failure_reason: null },
    ]
    const source = createConditionItemsSource({
      getClient: () => makeWaveDbClient(tasks),
      nowMs: NOW_WAVE,
    })
    const rows = await source.derive({ kinds: new Set(['signature-wave']) })

    expect(rows).toHaveLength(1)
    expect(rows[0]!.payload['bulkContinuable']).toBe(false)
    // caughtTaskIds must still be present regardless of bulkContinuable
    expect(Array.isArray(rows[0]!.payload['caughtTaskIds'])).toBe(true)
    expect((rows[0]!.payload['caughtTaskIds'] as string[]).length).toBe(3)
  })

  it('sets bulkContinuable=false when any member has a null worktree_path', async () => {
    const tasks = [
      { id: 'mars-1', failure_signature: WAVE_SIGNATURE, error: null, updated_at: UPDATED_AT, worktree_path: tmpDir, failure_reason: null },
      { id: 'mars-2', failure_signature: WAVE_SIGNATURE, error: null, updated_at: UPDATED_AT, worktree_path: null, failure_reason: null },
      { id: 'mars-3', failure_signature: WAVE_SIGNATURE, error: null, updated_at: UPDATED_AT, worktree_path: tmpDir, failure_reason: null },
    ]
    const source = createConditionItemsSource({
      getClient: () => makeWaveDbClient(tasks),
      nowMs: NOW_WAVE,
    })
    const rows = await source.derive({ kinds: new Set(['signature-wave']) })

    expect(rows).toHaveLength(1)
    expect(rows[0]!.payload['bulkContinuable']).toBe(false)
  })

  it('sets bulkContinuable=false when any member worktree path does not exist on disk', async () => {
    const tasks = [
      { id: 'mars-1', failure_signature: WAVE_SIGNATURE, error: null, updated_at: UPDATED_AT, worktree_path: tmpDir, failure_reason: null },
      { id: 'mars-2', failure_signature: WAVE_SIGNATURE, error: null, updated_at: UPDATED_AT, worktree_path: '/nonexistent/path/mars-xxx', failure_reason: null },
      { id: 'mars-3', failure_signature: WAVE_SIGNATURE, error: null, updated_at: UPDATED_AT, worktree_path: tmpDir, failure_reason: null },
    ]
    const source = createConditionItemsSource({
      getClient: () => makeWaveDbClient(tasks),
      nowMs: NOW_WAVE,
    })
    const rows = await source.derive({ kinds: new Set(['signature-wave']) })

    expect(rows).toHaveLength(1)
    expect(rows[0]!.payload['bulkContinuable']).toBe(false)
  })

  it('emits no signature-wave row when the group has fewer than the threshold', async () => {
    // Only 2 tasks — below SIGNATURE_WAVE_THRESHOLD (3)
    const tasks = [
      { id: 'mars-1', failure_signature: WAVE_SIGNATURE, error: null, updated_at: UPDATED_AT, worktree_path: tmpDir, failure_reason: null },
      { id: 'mars-2', failure_signature: WAVE_SIGNATURE, error: null, updated_at: UPDATED_AT, worktree_path: tmpDir, failure_reason: null },
    ]
    const source = createConditionItemsSource({
      getClient: () => makeWaveDbClient(tasks),
      nowMs: NOW_WAVE,
    })
    const rows = await source.derive({ kinds: new Set(['signature-wave']) })
    expect(rows).toHaveLength(0)
  })
})

