/**
 * Tests for baseline-caused failure attribution — the fix for the 2026-08-18
 * incident where a poisoned integration branch (an unsatisfiable dependency
 * pin) caused N tasks to die in `setup` with an identical
 * `setup:install/install-frozen-lockfile` signature, and the action queue
 * rendered that as N independent `failed` rows instead of the one shared
 * cause.
 *
 * `findBaselineCaughtTaskIds` (baseline-attribution.ts) correlates on TIME —
 * a task counts as baseline-caught when it reached `failed` at or after the
 * baseline pause began — while the checker says the baseline is poisoned and
 * the pause controller says dispatch is down specifically because of it
 * (`reason: 'baseline'`). `derived-conditions.ts` wires that set into both
 * `deriveFailedConditions` (suppresses the rows it accounts for) and
 * `deriveBaselineBrokenConditions` (names how many it caught).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DbClient } from '../../lib/db.js'
import { createConditionItemsSource } from '../view/derived-conditions.js'
import { lookupRecipe } from '../../lib/action-queue-recipes.js'

// ── DB helpers (mirrors derived-conditions-failed-recovery.test.ts) ─────────

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'mars-baseline-attribution-test-'))
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

/** Insert a `failed` task with an explicit `updated_at`, for time-correlation tests. */
async function seedFailedTask(
  client: DbClient,
  id: string,
  opts: { updatedAt: string; failureSignature?: string },
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO tasks (id, prompt, status, failure_signature, created_at, updated_at)
          VALUES (?, ?, 'failed', ?, ?, ?)`,
    args: [
      id,
      `task ${id}`,
      opts.failureSignature ?? 'setup:install/install-frozen-lockfile',
      opts.updatedAt,
      opts.updatedAt,
    ],
  })
}

describe('baseline-caused failure attribution', { timeout: 60_000 }, () => {
  let repo: string
  let client: DbClient

  beforeEach(async () => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    client = await makeClient(repo)
  })

  afterEach(async () => {
    await client.close()
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('collapses N identical setup:install failures into one baseline-broken row and suppresses their failed rows', async () => {
    const pauseSince = '2026-08-18T00:00:00.000Z'
    await seedFailedTask(client, 'caught-1', { updatedAt: '2026-08-18T00:01:00.000Z' })
    await seedFailedTask(client, 'caught-2', { updatedAt: '2026-08-18T00:02:00.000Z' })
    await seedFailedTask(client, 'caught-3', { updatedAt: '2026-08-18T00:03:00.000Z' })

    const source = createConditionItemsSource({
      getClient: () => client,
      isBaselinePoisoned: () => true,
      baselineDetail: () => ({
        failingGateName: 'dependency install',
        output: 'npm ERR! frozen-lockfile',
      }),
      getPauseState: () => ({
        paused: true,
        reason: 'baseline',
        since: pauseSince,
        detail: 'dependency install fails on integration branch',
      }),
    })

    const rows = await source.derive({ kinds: new Set(['failed', 'baseline-broken']) })

    const baselineRows = rows.filter((r) => r.kind === 'baseline-broken')
    expect(baselineRows).toHaveLength(1)
    expect(baselineRows[0]!.payload['caughtTaskCount']).toBe(3)
    expect(baselineRows[0]!.payload['caughtTaskIds']).toEqual(['caught-1', 'caught-2', 'caught-3'])
    expect(baselineRows[0]!.payload['installSignature']).toBe('setup:install/install-frozen-lockfile')

    // The three tasks the baseline row accounts for must NOT also render as
    // independent `failed` rows — that duplication is the exact incident shape.
    expect(rows.filter((r) => r.kind === 'failed')).toHaveLength(0)
  })

  it('reports ordinary per-task failures per-task when the baseline is healthy', async () => {
    await seedFailedTask(client, 'plain-fail', {
      updatedAt: '2026-08-19T00:00:00.000Z',
      failureSignature: 'code:unclassified',
    })

    const source = createConditionItemsSource({
      getClient: () => client,
      isBaselinePoisoned: () => false,
    })
    const rows = await source.derive({ kinds: new Set(['failed', 'baseline-broken']) })

    expect(rows.filter((r) => r.kind === 'baseline-broken')).toHaveLength(0)
    const failedIds = rows.filter((r) => r.kind === 'failed').map((r) => r.payload['taskId'])
    expect(failedIds).toContain('plain-fail')
  })

  it('does not suppress a failed task that predates the baseline pause', async () => {
    const pauseSince = '2026-08-18T00:00:00.000Z'
    await seedFailedTask(client, 'pre-existing-fail', {
      updatedAt: '2026-08-17T23:00:00.000Z',
      failureSignature: 'code:unclassified',
    })

    const source = createConditionItemsSource({
      getClient: () => client,
      isBaselinePoisoned: () => true,
      baselineDetail: () => ({ failingGateName: 'dependency install', output: 'frozen-lockfile' }),
      getPauseState: () => ({ paused: true, reason: 'baseline', since: pauseSince, detail: null }),
    })

    const rows = await source.derive({ kinds: new Set(['failed']) })
    const failedIds = rows.map((r) => r.payload['taskId'])
    expect(failedIds).toContain('pre-existing-fail')
  })

  it('does not attribute anything when dispatch is paused for a different reason (first-cause-wins)', async () => {
    const pauseSince = '2026-08-18T00:00:00.000Z'
    await seedFailedTask(client, 'storm-caught', { updatedAt: '2026-08-18T00:01:00.000Z' })

    const source = createConditionItemsSource({
      getClient: () => client,
      isBaselinePoisoned: () => true,
      baselineDetail: () => ({ failingGateName: 'dependency install', output: 'frozen-lockfile' }),
      getPauseState: () => ({
        paused: true,
        reason: 'storm',
        since: pauseSince,
        detail: 'signature storm: setup:install/install-frozen-lockfile x1',
      }),
    })

    const rows = await source.derive({ kinds: new Set(['failed', 'baseline-broken']) })
    const baselineRows = rows.filter((r) => r.kind === 'baseline-broken')
    expect(baselineRows[0]!.payload['caughtTaskCount']).toBe(0)
    // Not attributed to the baseline, so the task's own `failed` row still renders.
    const failedIds = rows.filter((r) => r.kind === 'failed').map((r) => r.payload['taskId'])
    expect(failedIds).toContain('storm-caught')
  })

  it("the baseline-broken recipe's humanDetail reads only keys the derived row's payload carries", async () => {
    const source = createConditionItemsSource({
      getClient: () => client,
      isBaselinePoisoned: () => true,
      baselineDetail: () => ({
        failingGateName: 'dependency install',
        output: 'npm ERR! frozen-lockfile',
      }),
      getPauseState: () => ({
        paused: true,
        reason: 'baseline',
        since: '2026-08-18T00:00:00.000Z',
        detail: null,
      }),
    })
    const rows = await source.derive({ kinds: new Set(['baseline-broken']) })
    const row = rows[0]!
    const recipe = lookupRecipe('baseline-broken')

    const detail = recipe.humanDetail({
      kind: 'baseline-broken',
      entityId: row.id,
      payload: row.payload,
      context: row.context,
      title: row.title,
      body: row.body,
      raisedAt: new Date(row.raisedAt).toISOString(),
    })
    for (const key of Object.keys(detail)) {
      expect(Object.prototype.hasOwnProperty.call(row.payload, key) || key === 'raisedAt' || key === 'entityId').toBe(
        true,
      )
    }
    expect(detail['installSignature']).toBe('setup:install/install-frozen-lockfile')
    expect(detail['caughtTaskCount']).toBe(0)

    const summary = recipe.humanSummary({
      kind: 'baseline-broken',
      entityId: row.id,
      payload: row.payload,
      context: row.context,
      title: row.title,
      body: row.body,
      raisedAt: new Date(row.raisedAt).toISOString(),
    })
    expect(summary).toContain('dependency install')
  })
})
