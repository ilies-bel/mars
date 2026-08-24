/**
 * Small operational tuning knobs that are read from the environment but do
 * not belong in `ControlLevers` (they are not operator levers) or the
 * `ENV_KNOBS` → `MarsConfig` registry (no persisted `daemon.json` shape).
 * The env read lives here because `src/core/config/` is the single
 * directory allowed to touch `process.env` (see the env-reads arch ratchet).
 */

/**
 * How many of HEAD's most recent ancestors the stale-tree rewind check in
 * `daemon/main-dirty-dispatch.ts` scans for an exact working-tree match.
 * Bounded because a rewind by definition happened recently; override via
 * `MARS_STALE_TREE_REWIND_DEPTH` for repos where merges land in unusually
 * large bursts.
 *
 * @param env injectable for hermetic tests; defaults to `process.env`.
 */
export const staleTreeRewindSearchDepth = (env: NodeJS.ProcessEnv = process.env): number =>
  Number(env.MARS_STALE_TREE_REWIND_DEPTH ?? 50)

/**
 * Cadence for `startPeriodicCheckpoint` in `../lib/git/checkpoint.ts`. Three
 * minutes balances "durable soon enough that a hard kill loses little"
 * against "don't shell out to `git` every few seconds for every in-flight
 * coder". Override via `MARS_CODE_CHECKPOINT_INTERVAL_MS` (used by tests and
 * available for a tighter recovery SLA in production).
 *
 * @param env injectable for hermetic tests; defaults to `process.env`.
 */
export const codeCheckpointIntervalMs = (env: NodeJS.ProcessEnv = process.env): number =>
  Number(env.MARS_CODE_CHECKPOINT_INTERVAL_MS ?? 3 * 60 * 1000)

/**
 * True when `acquireSemaphore` in `../lib/semaphore.ts` should hand back an
 * always-granted in-process permit instead of shelling out to the real
 * machine-global `sem.mjs` binary. `test/setup-env.ts` sets
 * `MARS_TEST_SEMAPHORE=inproc` unconditionally for the whole vitest suite;
 * unset in production. See that module's doc comment for the full test-seam
 * rationale.
 *
 * @param env injectable for hermetic tests; defaults to `process.env`.
 */
export const usesInProcSemaphoreMock = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.MARS_TEST_SEMAPHORE === 'inproc'

/**
 * Timeout for the `npm view <pkg> versions --json` registry lookup in
 * `../daemon/baseline-repair-wiring.ts`. Override via
 * `MARS_BASELINE_REPAIR_NPM_VIEW_TIMEOUT_MS`.
 *
 * @param env injectable for hermetic tests; defaults to `process.env`.
 */
export const baselineRepairNpmViewTimeoutMs = (env: NodeJS.ProcessEnv = process.env): number =>
  Number(env.MARS_BASELINE_REPAIR_NPM_VIEW_TIMEOUT_MS) || 15_000

/**
 * Minimum distinct-task failure count (within the rolling window) that trips
 * the signature-storm circuit breaker in `../lib/signature-storm-monitor.ts`.
 * Override via `MARS_SIGNATURE_STORM_THRESHOLD`.
 *
 * @param env injectable for hermetic tests; defaults to `process.env`.
 */
export const signatureStormTripThreshold = (env: NodeJS.ProcessEnv = process.env): number => {
  const raw = env.MARS_SIGNATURE_STORM_THRESHOLD
  if (!raw) return 3
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return 3
  return Math.floor(n)
}

/**
 * Rolling window (in ms) over which the signature-storm circuit breaker in
 * `../lib/signature-storm-monitor.ts` counts distinct-task failures.
 * Override via `MARS_SIGNATURE_STORM_WINDOW_MS`.
 *
 * @param env injectable for hermetic tests; defaults to `process.env`.
 */
export const signatureStormWindowMs = (env: NodeJS.ProcessEnv = process.env): number => {
  const raw = env.MARS_SIGNATURE_STORM_WINDOW_MS
  if (!raw) return 10 * 60 * 1000
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1000) return 10 * 60 * 1000
  return Math.floor(n)
}
