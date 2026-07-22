/**
 * Learned-recipe store — operator-taught auto-run rules.
 *
 * When an operator fires a Decision on a failed-task card and answers "Yes"
 * to "Apply automatically next time?", the chosen op is persisted here keyed
 * by the failure signature. On the next occurrence of the same signature the
 * orchestrator auto-runs the stored op instead of raising a card, and logs
 * the run in `auto_recipe_runs` so the WYWA panel can surface it.
 *
 * All read/write goes through the shared state client (PGlite in tests,
 * embedded PG in production). Idempotent schema is applied once at daemon
 * startup via `ensureSchema`.
 *
 * Scope: per failure signature, global (not per-project or per-task).
 */

import { randomUUID } from 'node:crypto'
import { resolveStateClient } from '../store/state-client.js'
import type { DbClient, DbInValue } from './db.js'

// ── Types ─────────────────────────────────────────────────────────────────────

/** A stored operator teaching: for this signature, always run this op. */
export interface LearnedRecipe {
  /** The failure signature the recipe applies to. */
  failureSignature: string
  /** The ActionOp the orchestrator will auto-run on the next occurrence. */
  actionOp: string
  /** ISO-8601 timestamp when the recipe was last taught or updated. */
  learnedAt: string
}

/** One logged auto-run entry persisted in `auto_recipe_runs`. */
export interface AutoRecipeRun {
  id: string
  /** The failure signature that triggered the auto-run. */
  signature: string
  /** The ActionOp that was executed. */
  actionOp: string
  /** The task id that was acted on, if applicable. */
  taskId: string | null
  /** ISO-8601 timestamp when the auto-run executed. */
  ranAt: string
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

/**
 * Persist (or overwrite) the recovery op for a failure signature. Idempotent:
 * re-teaching replaces the existing op and refreshes `learned_at`.
 */
export async function teachRecipe(
  failureSignature: string,
  actionOp: string,
): Promise<void> {
  const client = resolveStateClient()
  const now = new Date().toISOString()
  await client.execute({
    sql: `INSERT INTO learned_recipes (failure_signature, action_op, learned_at)
          VALUES (?, ?, ?)
          ON CONFLICT (failure_signature) DO UPDATE
          SET action_op = excluded.action_op,
              learned_at = excluded.learned_at`,
    args: [failureSignature, actionOp, now],
  })
}

/**
 * Remove the stored recovery recipe for a failure signature. No-op when the
 * signature has no stored recipe.
 */
export async function unlearnRecipe(failureSignature: string): Promise<void> {
  const client = resolveStateClient()
  await client.execute({
    sql: `DELETE FROM learned_recipes WHERE failure_signature = ?`,
    args: [failureSignature],
  })
}

/**
 * Fetch the stored recipe for a failure signature. Returns `null` when no
 * recipe has been taught for this signature.
 */
export async function getLearnedRecipe(
  failureSignature: string,
): Promise<LearnedRecipe | null> {
  const client = resolveStateClient()
  const result = await client.execute({
    sql: `SELECT failure_signature, action_op, learned_at
          FROM learned_recipes
          WHERE failure_signature = ?`,
    args: [failureSignature],
  })
  if (result.rows.length === 0) return null
  const row = result.rows[0] as unknown as {
    failure_signature: string
    action_op: string
    learned_at: string
  }
  return {
    failureSignature: row.failure_signature,
    actionOp: row.action_op,
    learnedAt: row.learned_at,
  }
}

/**
 * List all stored learned recipes, newest-first by `learned_at`.
 */
export async function listLearnedRecipes(): Promise<LearnedRecipe[]> {
  const client = resolveStateClient()
  const result = await client.execute({
    sql: `SELECT failure_signature, action_op, learned_at
          FROM learned_recipes
          ORDER BY learned_at DESC`,
    args: [],
  })
  return result.rows.map((row: unknown) => {
    const r = row as { failure_signature: string; action_op: string; learned_at: string }
    return {
      failureSignature: r.failure_signature,
      actionOp: r.action_op,
      learnedAt: r.learned_at,
    }
  })
}

// ── Auto-run log ──────────────────────────────────────────────────────────────

/**
 * Persist a record of an auto-executed learned recipe. Called after the
 * auto-run succeeds so the WYWA panel can surface it to the operator.
 */
export async function logAutoRecipeRun(params: {
  signature: string
  actionOp: string
  taskId: string | null
}): Promise<void> {
  const client = resolveStateClient()
  await client.execute({
    sql: `INSERT INTO auto_recipe_runs (id, signature, action_op, task_id, ran_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [
      randomUUID(),
      params.signature,
      params.actionOp,
      params.taskId,
      new Date().toISOString(),
    ],
  })
}

/**
 * List recent auto-run log entries, newest-first.
 *
 * @param opts.since  ISO-8601 lower bound (exclusive). Only entries with
 *   `ran_at > since` are returned.
 * @param opts.limit  Maximum rows to return. Defaults to 50.
 */
export async function listAutoRecipeRuns(
  opts: { since?: string; limit?: number } = {},
): Promise<AutoRecipeRun[]> {
  const client = resolveStateClient()
  const limit = opts.limit ?? 50
  const args: DbInValue[] = []
  let sql = `SELECT id, signature, action_op, task_id, ran_at FROM auto_recipe_runs`
  if (opts.since) {
    sql += ` WHERE ran_at > ?`
    args.push(opts.since)
  }
  sql += ` ORDER BY ran_at DESC LIMIT ?`
  args.push(limit)
  const result = await client.execute({ sql, args })
  return result.rows.map((row: unknown) => {
    const r = row as {
      id: string
      signature: string
      action_op: string
      task_id: string | null
      ran_at: string
    }
    return {
      id: r.id,
      signature: r.signature,
      actionOp: r.action_op,
      taskId: r.task_id,
      ranAt: r.ran_at,
    }
  })
}

// ── Auto-run execution ────────────────────────────────────────────────────────

/**
 * Execute a learned recovery op for a task. Called by the outbox subscriber
 * when a `task.blocked` event fires for a signature that has a learned recipe.
 *
 * Supports:
 * - `restart` — tear down the worktree and re-queue from setup.
 * - `purge`   — drop the task and its worktree permanently (force=false;
 *               refuses if the branch has unmerged commits).
 *
 * Any other op is a no-op with a warning: it cannot be executed without
 * daemon-level context (process-level ops, copy-only ops, etc.).
 *
 * Errors thrown by the underlying handler (e.g. wrong status, commits ahead)
 * propagate to the caller so the caller can fall back to raising a card.
 */
export async function executeLearnedOp(
  taskId: string,
  op: string,
): Promise<void> {
  if (op === 'restart') {
    const { coreRestartTask } = await import('../daemon/restart-task.js')
    const { createQueueWorkflowStore } = await import(
      '../../workflows/queue-workflow-store.js'
    )
    await coreRestartTask(taskId, new Set(['failed']), createQueueWorkflowStore())
    return
  }

  if (op === 'purge') {
    const { corePurgeTask } = await import('../daemon/purge-task.js')
    const { integrationBranchName } = await import('../blocker-resolution.js')
    const { getRepoRoot } = await import('../context.js')
    await corePurgeTask(
      taskId,
      false,
      integrationBranchName(),
      getRepoRoot(),
    )
    return
  }

  // All other ops (investigate, diagnose-failure, copy, process-level) cannot
  // be auto-executed in the outbox subscriber context. Log and skip so the
  // caller falls back to raising a card.
  console.warn(
    `[learned-recipe] Cannot auto-run op '${op}' for task ${taskId}: ` +
      `op not supported for background execution`,
  )
  throw new Error(`op '${op}' is not supported for auto-run`)
}

// ── Test seam ─────────────────────────────────────────────────────────────────

/**
 * Test-only: expose the resolved state client so test helpers can insert
 * rows directly (e.g. with manual timestamps).
 * @internal
 */
export const __resolveStateClientForTests = (): DbClient => resolveStateClient()
