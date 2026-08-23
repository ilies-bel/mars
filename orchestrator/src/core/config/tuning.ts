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
