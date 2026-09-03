/**
 * Unit tests for the `budget-arc` derived condition.
 *
 * Acceptance criteria (from the task brief):
 *  1. ceiling set + arc over → one row with BudgetArcPayload
 *  2. ceiling unset (null config)     → no rows
 *  3. ceiling unset (arcTokens: null) → no rows
 *  4. arc under ceiling               → no rows
 *  5. arc settled (all tasks terminal) → row absent on next derive() call
 *  6. row ID is deterministic via deriveId('budget-arc', arcId)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DbClient } from '../../lib/db.js'
import type { BudgetConfig } from '../../lib/spend-meter.js'
import type { BudgetArcPayload } from '../../lib/payload-contracts/spend.js'

// ── Mock readBudgetConfig ─────────────────────────────────────────────────────
//
// `readBudgetConfig` reads from daemon.json via `resolveContext()`, whose
// module-level cache makes it tricky to point at the right temp repo in each
// test.  Mocking the function directly keeps the test focused on the
// derivation logic and removes the filesystem/context coupling entirely.
// vi.mock is hoisted before all imports, so `derived-conditions.ts` also
// picks up the mock when it imports `readBudgetConfig`.

vi.mock('../../lib/spend-meter.js', () => ({
  readBudgetConfig: vi.fn<() => BudgetConfig | null>(),
}))

import { readBudgetConfig } from '../../lib/spend-meter.js'
import { createConditionItemsSource } from './derived-conditions.js'

// ── DB helpers ────────────────────────────────────────────────────────────────

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'mars-budget-arc-test-'))
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

/** Insert a minimal task row. */
async function seedTask(
  client: DbClient,
  id: string,
  status: string,
  originId?: string,
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO tasks (id, prompt, status, origin_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, NOW(), NOW())`,
    args: [id, `task ${id}`, status, originId ?? null],
  })
}

/** Insert a step_ended trace event carrying a usageSignals payload. */
async function seedTraceEvent(
  client: DbClient,
  id: string,
  taskId: string,
  tokens: {
    inputTokens: number
    outputTokens: number
    cacheCreateTokens: number
    cacheReadTokens: number
  },
): Promise<void> {
  const payload = JSON.stringify({ usageSignals: tokens })
  await client.execute({
    sql: `INSERT INTO trace_events (id, timestamp, kind, task_id, payload)
          VALUES (?, ?, 'step_ended', ?, ?)`,
    args: [id, Date.now(), taskId, payload],
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('deriveBudgetArcConditions', { timeout: 60_000 }, () => {
  let repo: string
  let client: DbClient

  beforeEach(async () => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    client = await makeClient(repo)
    vi.mocked(readBudgetConfig).mockReset()
  })

  afterEach(async () => {
    await client.close()
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  // ── 1. Ceiling set + arc over → row present ─────────────────────────────

  it('emits one row with BudgetArcPayload when arc spend >= ceiling', async () => {
    // weighted = 100_000 input + 50_000 output = 150_000 (ceiling is 100_000)
    vi.mocked(readBudgetConfig).mockReturnValue({
      arcTokens: 100_000,
      windowMs: null,
      windowTokens: null,
    })
    await seedTask(client, 'arc-1', 'running')
    await seedTraceEvent(client, 'evt-1', 'arc-1', {
      inputTokens: 100_000,
      outputTokens: 50_000,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
    })

    const source = createConditionItemsSource({ getClient: () => client })
    const rows = await source.derive({ kinds: new Set(['budget-arc']) })

    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.kind).toBe('budget-arc')
    expect(row.priority).toBe('high')
    const payload = row.payload as unknown as BudgetArcPayload
    expect(payload.arcId).toBe('arc-1')
    expect(payload.spentTokens).toBeCloseTo(150_000, 0)
    expect(payload.ceilingTokens).toBe(100_000)
  })

  // ── 2. Row ID is deterministic ───────────────────────────────────────────

  it('produces the same stable row ID on repeated derive() calls', async () => {
    vi.mocked(readBudgetConfig).mockReturnValue({
      arcTokens: 50_000,
      windowMs: null,
      windowTokens: null,
    })
    await seedTask(client, 'arc-stable', 'running')
    await seedTraceEvent(client, 'evt-stable', 'arc-stable', {
      inputTokens: 100_000,
      outputTokens: 0,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
    })

    const source = createConditionItemsSource({ getClient: () => client })
    const rows1 = await source.derive({ kinds: new Set(['budget-arc']) })
    const rows2 = await source.derive({ kinds: new Set(['budget-arc']) })

    expect(rows1).toHaveLength(1)
    expect(rows2).toHaveLength(1)
    // Same arc → same deterministic ID on every read
    expect(rows1[0]!.id).toBe(rows2[0]!.id)
    // Confirm the signature encodes the arc id
    expect(rows1[0]!.signature).toBe('budget-arc:arc-stable')
  })

  // ── 3. Ceiling unset (null config) → no rows ────────────────────────────

  it('returns no rows when readBudgetConfig() returns null', async () => {
    vi.mocked(readBudgetConfig).mockReturnValue(null)
    await seedTask(client, 'arc-2', 'running')
    await seedTraceEvent(client, 'evt-2', 'arc-2', {
      inputTokens: 500_000,
      outputTokens: 500_000,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
    })

    const source = createConditionItemsSource({ getClient: () => client })
    const rows = await source.derive({ kinds: new Set(['budget-arc']) })
    expect(rows).toHaveLength(0)
  })

  // ── 4. Ceiling unset (arcTokens: null) → no rows ────────────────────────

  it('returns no rows when arcTokens is null (window-only config)', async () => {
    vi.mocked(readBudgetConfig).mockReturnValue({
      arcTokens: null,
      windowMs: 3_600_000,
      windowTokens: 1_000_000,
    })
    await seedTask(client, 'arc-3', 'running')
    await seedTraceEvent(client, 'evt-3', 'arc-3', {
      inputTokens: 500_000,
      outputTokens: 500_000,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
    })

    const source = createConditionItemsSource({ getClient: () => client })
    const rows = await source.derive({ kinds: new Set(['budget-arc']) })
    expect(rows).toHaveLength(0)
  })

  // ── 5. Arc under ceiling → no rows ──────────────────────────────────────

  it('returns no rows when arc spend is below the ceiling', async () => {
    // weighted = 100_000 + 50_000 = 150_000 but ceiling is 1_000_000
    vi.mocked(readBudgetConfig).mockReturnValue({
      arcTokens: 1_000_000,
      windowMs: null,
      windowTokens: null,
    })
    await seedTask(client, 'arc-4', 'running')
    await seedTraceEvent(client, 'evt-4', 'arc-4', {
      inputTokens: 100_000,
      outputTokens: 50_000,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
    })

    const source = createConditionItemsSource({ getClient: () => client })
    const rows = await source.derive({ kinds: new Set(['budget-arc']) })
    expect(rows).toHaveLength(0)
  })

  // ── 6. Arc settled (all tasks terminal) → row absent ────────────────────

  it('omits the row once all arc tasks reach a terminal status', async () => {
    vi.mocked(readBudgetConfig).mockReturnValue({
      arcTokens: 100_000,
      windowMs: null,
      windowTokens: null,
    })
    await seedTask(client, 'arc-5', 'done')  // terminal
    await seedTraceEvent(client, 'evt-5', 'arc-5', {
      inputTokens: 500_000,
      outputTokens: 500_000,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
    })

    const source = createConditionItemsSource({ getClient: () => client })
    const rows = await source.derive({ kinds: new Set(['budget-arc']) })
    // Arc is done → not live → condition disappears
    expect(rows).toHaveLength(0)
  })

  // ── Bonus: arc with recovery task — both count toward arc spend ──────────

  it('accumulates spend across origin and recovery tasks in the same arc', async () => {
    vi.mocked(readBudgetConfig).mockReturnValue({
      arcTokens: 100_000,
      windowMs: null,
      windowTokens: null,
    })
    // origin task (its own arc, live because the recovery is still running)
    await seedTask(client, 'origin-6', 'failed')
    // recovery task, origin_id points back to the origin so they share an arc
    await seedTask(client, 'fix-6', 'running', 'origin-6')
    // trace events for both tasks
    await seedTraceEvent(client, 'evt-6a', 'origin-6', {
      inputTokens: 60_000,
      outputTokens: 0,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
    })
    await seedTraceEvent(client, 'evt-6b', 'fix-6', {
      inputTokens: 60_000,
      outputTokens: 0,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
    })

    const source = createConditionItemsSource({ getClient: () => client })
    const rows = await source.derive({ kinds: new Set(['budget-arc']) })

    // Combined spend = 120_000, ceiling = 100_000 → one row for arc 'origin-6'
    expect(rows).toHaveLength(1)
    const payload = rows[0]!.payload as unknown as BudgetArcPayload
    expect(payload.arcId).toBe('origin-6')
    expect(payload.spentTokens).toBeCloseTo(120_000, 0)
    expect(payload.ceilingTokens).toBe(100_000)
  })
})
