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
 *
 * ADR-0099 ("Self-improvement loops induce the weakest valid hypothesis")
 * requires every autonomous recipe to carry a measurable breadth and an
 * outcome log consulted before re-firing. Two distinct breadth metrics are
 * tracked here:
 *
 *  - `LearnedRecipe.autoRunCount` — how many times this recipe has actually
 *    auto-fired (a count of logged `auto_recipe_runs` rows). Zero for a
 *    freshly-taught recipe.
 *  - `LearnedRecipe.breadth` — {@link MatcherBreadth}: how many PAST
 *    failures this recipe's signature would have matched, exactly and by
 *    family, regardless of whether the recipe existed at the time. Computed
 *    by `listLearnedRecipes()` via `wouldHaveFiredOnMany` so an operator can
 *    see whether a recipe taught from one click is narrow (matches exactly
 *    one historic failure) or broad, without waiting for it to actually fire
 *    again.
 *
 * The outcome log itself: each auto-run starts `outcome: 'pending'` and is
 * later resolved via `recordAutoRecipeOutcome` once the acted-on task's fate
 * is known, so `listAutoRecipeRuns({ signature })` can be checked before
 * trusting the recipe again.
 */

import { randomUUID } from 'node:crypto'
import { resolveStateClient } from '../store/state-client.js'
import type { DbClient, DbInValue } from './db.js'
import { type MatcherBreadth, wouldHaveFiredOnMany } from './matcher-breadth.js'

// ── Types ─────────────────────────────────────────────────────────────────────

/** A stored operator teaching: for this signature, always run this op. */
export interface LearnedRecipe {
  /** The failure signature the recipe applies to. */
  failureSignature: string
  /** The ActionOp the orchestrator will auto-run on the next occurrence. */
  actionOp: string
  /** ISO-8601 timestamp when the recipe was last taught or updated. */
  learnedAt: string
  /**
   * The number of past instances (logged `auto_recipe_runs` rows) this
   * recipe has actually fired on. Lets an operator see whether a recipe is
   * well-exercised, without changing the exact-match semantics of when it
   * fires.
   */
  autoRunCount: number
  /**
   * Matcher breadth (ADR-0099): how many PAST failures (by
   * `tasks.failure_signature`) this recipe's signature would have matched,
   * exactly and by family — see {@link MatcherBreadth}. Populated by
   * `listLearnedRecipes()` in one batched query; `getLearnedRecipe()` (the
   * exact-match single-row lookup autonomous firing uses) leaves it
   * `undefined`.
   */
  breadth?: MatcherBreadth
}

/**
 * The resolved effect of an auto-executed recipe, once known.
 * - `pending` — logged at run time; the acted-on task's fate is not yet known.
 * - `success` — the recipe's action resolved the failure (the task recovered).
 * - `failure` — the recipe's action did not resolve the failure (e.g. the
 *   task failed again, possibly with the same signature).
 */
export type AutoRecipeOutcome = 'pending' | 'success' | 'failure'

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
  /** Outcome feedback (ADR-0099), resolved after the fact via `recordAutoRecipeOutcome`. */
  outcome: AutoRecipeOutcome
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
    sql: `SELECT lr.failure_signature, lr.action_op, lr.learned_at,
                 COALESCE(arr.auto_run_count, 0) AS auto_run_count
          FROM learned_recipes lr
          LEFT JOIN (
            SELECT signature, COUNT(*) AS auto_run_count
            FROM auto_recipe_runs
            GROUP BY signature
          ) arr ON arr.signature = lr.failure_signature
          WHERE lr.failure_signature = ?`,
    args: [failureSignature],
  })
  if (result.rows.length === 0) return null
  const row = result.rows[0] as unknown as {
    failure_signature: string
    action_op: string
    learned_at: string
    auto_run_count: number | string
  }
  return {
    failureSignature: row.failure_signature,
    actionOp: row.action_op,
    learnedAt: row.learned_at,
    autoRunCount: Number(row.auto_run_count),
  }
}

/**
 * List all stored learned recipes, newest-first by `learned_at`. Populates
 * `breadth` (ADR-0099) for every row via a single batched
 * {@link wouldHaveFiredOnMany} call — never one query per row.
 */
export async function listLearnedRecipes(): Promise<LearnedRecipe[]> {
  const client = resolveStateClient()
  const result = await client.execute({
    sql: `SELECT lr.failure_signature, lr.action_op, lr.learned_at,
                 COALESCE(arr.auto_run_count, 0) AS auto_run_count
          FROM learned_recipes lr
          LEFT JOIN (
            SELECT signature, COUNT(*) AS auto_run_count
            FROM auto_recipe_runs
            GROUP BY signature
          ) arr ON arr.signature = lr.failure_signature
          ORDER BY lr.learned_at DESC`,
    args: [],
  })
  const rows = result.rows.map((row: unknown) => {
    const r = row as {
      failure_signature: string
      action_op: string
      learned_at: string
      auto_run_count: number | string
    }
    return {
      failureSignature: r.failure_signature,
      actionOp: r.action_op,
      learnedAt: r.learned_at,
      autoRunCount: Number(r.auto_run_count),
    }
  })
  if (rows.length === 0) return rows

  // wouldHaveFiredOnMany guarantees one map entry per input signature.
  const breadthBySignature = await wouldHaveFiredOnMany(rows.map((r) => r.failureSignature))
  return rows.map((r) => ({
    ...r,
    breadth: breadthBySignature.get(r.failureSignature)!,
  }))
}

// ── Auto-run log ──────────────────────────────────────────────────────────────

/**
 * Persist a record of an auto-executed learned recipe. Called after the
 * auto-run succeeds so the WYWA panel can surface it to the operator.
 *
 * The row starts with `outcome: 'pending'` (ADR-0099) — the auto-run
 * mechanics only confirm the op itself executed without throwing, not that
 * it resolved the underlying failure. Callers that observe the acted-on
 * task's eventual fate should follow up with `recordAutoRecipeOutcome`
 * using the id returned here.
 *
 * @returns the id of the inserted `auto_recipe_runs` row.
 */
export async function logAutoRecipeRun(params: {
  signature: string
  actionOp: string
  taskId: string | null
}): Promise<string> {
  const client = resolveStateClient()
  const id = randomUUID()
  await client.execute({
    sql: `INSERT INTO auto_recipe_runs (id, signature, action_op, task_id, ran_at, outcome)
          VALUES (?, ?, ?, ?, ?, 'pending')`,
    args: [id, params.signature, params.actionOp, params.taskId, new Date().toISOString()],
  })
  return id
}

/**
 * Resolve the outcome of a previously logged auto-run once the acted-on
 * task's fate is known. No-op when `id` does not match a logged row.
 */
export async function recordAutoRecipeOutcome(
  id: string,
  outcome: Exclude<AutoRecipeOutcome, 'pending'>,
): Promise<void> {
  const client = resolveStateClient()
  await client.execute({
    sql: `UPDATE auto_recipe_runs SET outcome = ? WHERE id = ?`,
    args: [outcome, id],
  })
}

/**
 * List recent auto-run log entries, newest-first. Passing `signature`
 * consults a single recipe's outcome log — e.g. to check for recent
 * `failure` outcomes before trusting it to auto-run again (ADR-0099).
 *
 * @param opts.signature  Restrict to auto-runs of this failure signature.
 * @param opts.since  ISO-8601 lower bound (exclusive). Only entries with
 *   `ran_at > since` are returned.
 * @param opts.limit  Maximum rows to return. Defaults to 50.
 */
export async function listAutoRecipeRuns(
  opts: { signature?: string; since?: string; limit?: number } = {},
): Promise<AutoRecipeRun[]> {
  const client = resolveStateClient()
  const limit = opts.limit ?? 50
  const args: DbInValue[] = []
  const conditions: string[] = []
  if (opts.signature) {
    conditions.push(`signature = ?`)
    args.push(opts.signature)
  }
  if (opts.since) {
    conditions.push(`ran_at > ?`)
    args.push(opts.since)
  }
  let sql = `SELECT id, signature, action_op, task_id, ran_at, outcome FROM auto_recipe_runs`
  if (conditions.length > 0) {
    sql += ` WHERE ${conditions.join(' AND ')}`
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
      outcome: AutoRecipeOutcome
    }
    return {
      id: r.id,
      signature: r.signature,
      actionOp: r.action_op,
      taskId: r.task_id,
      ranAt: r.ran_at,
      outcome: r.outcome,
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
