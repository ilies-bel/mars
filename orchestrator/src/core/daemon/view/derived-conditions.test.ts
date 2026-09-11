/**
 * Tests for signature-wave bulk-verb classification in derived-conditions.ts.
 *
 * The three fixtures from the spec (ADR / task mars-b80b0125):
 *
 *  1. All members: no branch, no worktree, recovery unspent
 *     → bulkVerb='restart', recipe offers "Restart all N — discards nothing"
 *
 *  2. Mixed members: some have no branch/worktree, one has a branch
 *     → bulkVerb=null (members disagree / unknown), row still lists all ids
 *
 *  3. All members: worktree exists on disk, recovery unspent
 *     → bulkVerb='continue', recipe offers "Continue all N"
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createConditionItemsSource } from './derived-conditions.js'
import { lookupRecipe, getRecipeVerbs } from '../../lib/action-queue-recipes.js'
import type { DbClient } from '../../lib/db.js'
import type { RecipeContext } from '../../lib/action-queue-recipes.js'

// ── Test helpers ──────────────────────────────────────────────────────────────

/**
 * A DbClient that returns the given task rows for failure_signature queries
 * and empty rows for everything else.
 */
const makeWaveDbClient = (taskRows: Array<Record<string, unknown>>): DbClient => ({
  execute: async (sqlOrObj: unknown) => {
    const sql =
      typeof sqlOrObj === 'string'
        ? sqlOrObj
        : (sqlOrObj as { sql: string }).sql
    // The signature-wave query selects from tasks WHERE failure_signature IS NOT NULL.
    if (typeof sql === 'string' && sql.includes('failure_signature')) {
      return { rows: taskRows, rowsAffected: 0 }
    }
    return { rows: [], rowsAffected: 0 }
  },
  batch: async () => [],
  close: async () => {},
})

/**
 * A diagnostic, named-cause signature that groups by family (sig-keyed bucket).
 * `verify:typecheck` passes isDiagnosticSignature AND signatureNamesASharedCause.
 */
const SHARED_SIG = 'verify:typecheck/typecheck-error'

/** Build N task rows, each sharing SHARED_SIG plus per-row overrides. */
const makeTaskRows = (
  n: number,
  overrides: Partial<Record<string, unknown>> = {},
): Array<Record<string, unknown>> =>
  Array.from({ length: n }, (_, i) => ({
    id: `task-${String.fromCharCode(65 + i)}`, // task-A, task-B, …
    failure_signature: SHARED_SIG,
    error: null,
    updated_at: '2026-01-01T00:00:00Z',
    worktree_path: null,
    failure_reason: null,
    branch: null,
    ...overrides,
  }))

/** Derive signature-wave rows from a given DB client. */
const deriveWaveRows = async (client: DbClient) => {
  const source = createConditionItemsSource({ getClient: () => client })
  return source.derive({ kinds: new Set(['signature-wave']) })
}

/** Build a RecipeContext for a signature-wave row. */
const makeWaveCtx = (
  waveRow: Awaited<ReturnType<typeof deriveWaveRows>>[number],
): RecipeContext => ({
  kind: 'signature-wave',
  entityId: waveRow.id,
  payload: waveRow.payload as Record<string, unknown>,
  context: waveRow.context,
  title: waveRow.title,
  body: waveRow.body,
  raisedAt: new Date(waveRow.raisedAt).toISOString(),
})

// ── Suite: signature-wave bulk-verb unanimity ─────────────────────────────────

describe('signature-wave bulk-verb classification', () => {
  // ── Fixture 1: setup-style failure — no branch, no worktree, recovery unspent

  it('offers Restart all N when every member has no branch, no worktree, recovery unspent', async () => {
    const rows = makeTaskRows(4) // 4 > threshold of 3
    const waveRows = await deriveWaveRows(makeWaveDbClient(rows))

    expect(waveRows).toHaveLength(1)
    const waveRow = waveRows[0]!
    expect(waveRow.kind).toBe('signature-wave')

    // Payload carries the unanimous verb.
    expect(waveRow.payload.bulkVerb).toBe('restart')

    // Recipe translates bulkVerb='restart' to a restart-wave verb.
    const recipe = lookupRecipe('signature-wave')
    const verbs = getRecipeVerbs(recipe, makeWaveCtx(waveRow))

    // signature-wave is a derived kind — no Snooze appended.
    expect(verbs).toHaveLength(1)
    const [primaryVerb] = verbs
    expect(primaryVerb).toMatchObject({ op: 'restart-wave', style: 'primary' })
    // Label must name the task count and state that nothing is discarded.
    expect(primaryVerb!.label).toContain('Restart all 4')
    expect(primaryVerb!.label).toContain('discards nothing')
  })

  // ── Fixture 2: members disagree — some no-branch/no-worktree, one with a branch

  it('offers no bulk verb when members disagree, and still renders the affected-id list', async () => {
    // Tasks A-C: no branch, no worktree → classify as 'restart'.
    // Task D: has a branch (realCommitsAhead not probed) → 'unknown'.
    // Unanimous check fails → bulkVerb=null.
    const taskRows: Array<Record<string, unknown>> = [
      ...makeTaskRows(3),
      {
        id: 'task-D',
        failure_signature: SHARED_SIG,
        error: null,
        updated_at: '2026-01-01T00:00:00Z',
        worktree_path: null,
        failure_reason: null,
        branch: 'task/task-D', // branch present → realCommitsAhead treated as null (not probed)
      },
    ]
    const waveRows = await deriveWaveRows(makeWaveDbClient(taskRows))

    expect(waveRows).toHaveLength(1)
    const waveRow = waveRows[0]!

    // No unanimous verb.
    expect(waveRow.payload.bulkVerb).toBeNull()

    // Positive control: the affected-id list is still present and complete.
    expect(waveRow.payload.caughtTaskIds).toHaveLength(4)
    expect(Array.isArray(waveRow.payload.caughtTaskIds)).toBe(true)

    // Recipe returns no verbs (derived kind, no agreement → no bulk button).
    const recipe = lookupRecipe('signature-wave')
    const verbs = getRecipeVerbs(recipe, makeWaveCtx(waveRow))
    expect(verbs).toEqual([])
  })

  // ── Fixture 3: all members continuable — existing worktree, recovery unspent

  it('offers Continue all N when every member has an existing worktree and recovery unspent', async () => {
    // Use a real temp directory so existsSync() returns true naturally.
    const tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-wave-continue-test-'))
    try {
      const rows = makeTaskRows(4, { worktree_path: tmpDir })
      const waveRows = await deriveWaveRows(makeWaveDbClient(rows))

      expect(waveRows).toHaveLength(1)
      const waveRow = waveRows[0]!

      // Payload carries the unanimous verb.
      expect(waveRow.payload.bulkVerb).toBe('continue')

      // Recipe translates bulkVerb='continue' to a continue-wave verb.
      const recipe = lookupRecipe('signature-wave')
      const verbs = getRecipeVerbs(recipe, makeWaveCtx(waveRow))

      // signature-wave is a derived kind — no Snooze appended.
      expect(verbs).toHaveLength(1)
      expect(verbs[0]).toMatchObject({
        op: 'continue-wave',
        label: 'Continue all 4',
        style: 'primary',
      })
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
