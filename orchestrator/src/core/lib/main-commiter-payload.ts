/**
 * Slice F.2 main-commiter payload — the pure, dependency-free surface shared
 * by `arc.ts` (which spawns/reads the recovery task's `recovery_payload`) and
 * `lib/main-dirty.ts` (which owns detection + spawn/attach orchestration).
 *
 * This module intentionally imports nothing from `../arc` or `../queue`: it
 * used to live inline in `lib/main-dirty.ts`, which `arc.ts` imported for
 * exactly these symbols while `lib/main-dirty.ts` itself imported `Arc` from
 * `../arc` — a direct two-file cycle. Extracting the constants/types/pure
 * functions both sides need into this leaf module lets `arc.ts` depend on
 * them without depending on `lib/main-dirty.ts` at all. `lib/main-dirty.ts`
 * re-exports these so its existing consumers are unaffected.
 */

/**
 * Failure code emitted whenever dirty-main detection parks a task. Aligns
 * with the failure-reason catalog entry in `failure-reasons/built-in.ts`.
 * Kept as a module constant so the dispatch-time and verify-time call sites
 * cannot drift.
 */
export const VERIFY_MAIN_DIRTY_CODE = 'verify:main-dirty'

/**
 * Recipe name that resolves the committer agent (see
 * `recipes/built-in/main-commiter.md`). Stored on the recovery task's
 * `recovery_payload` so future actionQueue / UI code can render which recipe a
 * given recovery is running.
 */
export const MAIN_COMMITER_RECIPE = 'main-commiter'

/**
 * Shape of the JSON blob persisted on `tasks.recovery_payload` for a
 * `main-commiter` recovery. Other recipes that adopt the same column will
 * use their own shape; the column is opaque at the persistence layer.
 */
export interface MainCommiterPayload {
  recipe: typeof MAIN_COMMITER_RECIPE
  /**
   * Integration branch the committer is parked on. This is the active-committer
   * dedup key: parallel integration branches each get their own independent
   * committer, and all tasks on the same branch share one committer regardless
   * of what files are dirty or where HEAD is.
   */
  integrationBranch: string
  /**
   * Dirty paths the committer was checkpointed to clean, parsed from
   * `git status --porcelain` at spawn time. Optional — absent on legacy rows.
   *
   * Used by the verify post-check to scope the still-dirty invariant: only
   * paths in this set count as a genuine committer failure; dirt that appeared
   * after the checkpoint is handled by the next dispatch-time dirty-main check.
   */
  checkpointedPaths?: string[]
}

/**
 * Parse a recovery_payload string into a typed MainCommiterPayload, returning
 * null when the payload is missing, malformed, or for a different recipe.
 * Used by the catalog auto-resolve and aggregated-actionQueue-row paths.
 */
export const parseMainCommiterPayload = (
  raw: string | null,
): MainCommiterPayload | null => {
  if (raw === null || raw.length === 0) return null
  try {
    const parsed = JSON.parse(raw) as Partial<MainCommiterPayload>
    if (parsed.recipe !== MAIN_COMMITER_RECIPE) return null
    if (typeof parsed.integrationBranch !== 'string') return null
    const checkpointedPaths =
      Array.isArray(parsed.checkpointedPaths) &&
      parsed.checkpointedPaths.every((p) => typeof p === 'string')
        ? (parsed.checkpointedPaths as string[])
        : undefined
    return {
      recipe: MAIN_COMMITER_RECIPE,
      integrationBranch: parsed.integrationBranch,
      ...(checkpointedPaths !== undefined ? { checkpointedPaths } : {}),
    }
  } catch {
    return null
  }
}

/** Serialise a payload for the `recovery_payload` column. */
export const serialiseMainCommiterPayload = (
  payload: MainCommiterPayload,
): string => JSON.stringify(payload)

/**
 * Title surfaced on the `tasks.error` column of the source task when it
 * parks on a `main-commiter`. Kept short — the bulk of the context is on
 * the recovery task itself.
 */
export const SOURCE_ERROR_SUMMARY = (
  integrationBranch: string,
  dispatchPhase: 'dispatch' | 'verify' | 'merge',
): string =>
  `dirty integration branch (${integrationBranch}) detected at ${dispatchPhase}; parked behind main-commiter recovery`

// ---------------------------------------------------------------------------
// VerifyOutputPayload — test-assertion failure context persisted on the source
// task's `recovery_payload` column before a fix task is spawned.
// ---------------------------------------------------------------------------

/**
 * Shape of the JSON blob persisted on `tasks.recovery_payload` for a
 * `verify:test/test-assertion-error` failure. Discriminated by
 * `kind: 'verify-output'` so consumers can safely call
 * `parseMainCommiterPayload` on the same column — it returns `null` for this
 * kind, leaving the two payload shapes independent.
 *
 * Written by `handleTaskFailureWithFixTask` (queue-fix-tasks.ts) immediately
 * before `upsertFixTask` is called, so it is available to the fix-task brief
 * builder from that point forward. Only ever written for the source (origin)
 * task, never on fix-task rows.
 */
export interface VerifyOutputPayload {
  kind: 'verify-output'
  /** The full failure signature, e.g. `verify:test/test-assertion-error`. */
  signature: string
  /**
   * Full raw stdout+stderr of the failing verify step, without truncation.
   * This is the `errorOutput` received by `handleTaskFailureWithFixTask`,
   * not the `truncateFailure()` result, so the failing file path, test
   * name, assertion line, and expected-vs-received diff are all preserved.
   */
  output: string
}

/** Serialise a VerifyOutputPayload for the `recovery_payload` column. */
export const serialiseVerifyOutputPayload = (
  payload: VerifyOutputPayload,
): string => JSON.stringify(payload)

/**
 * Parse a `recovery_payload` string into a typed `VerifyOutputPayload`,
 * returning `null` when the payload is missing, malformed, or for a
 * different kind (e.g. `'main-commiter'`).
 *
 * Safe to call on any `recovery_payload` value — it discriminates on
 * `kind: 'verify-output'` and returns `null` for everything else, so
 * callers do not need to pre-filter by task type.
 */
export const parseVerifyOutputPayload = (
  raw: string | null | undefined,
): VerifyOutputPayload | null => {
  if (raw == null || raw.length === 0) return null
  try {
    const parsed = JSON.parse(raw) as Partial<VerifyOutputPayload>
    if (parsed.kind !== 'verify-output') return null
    if (typeof parsed.signature !== 'string') return null
    if (typeof parsed.output !== 'string') return null
    return {
      kind: 'verify-output',
      signature: parsed.signature,
      output: parsed.output,
    }
  } catch {
    return null
  }
}
