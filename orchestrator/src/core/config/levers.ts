/**
 * The ONE place operator control levers are resolved into data.
 *
 * Before this module the daemon projected levers into `process.env`
 * (`applyControlLevers` wrote `MARS_RECOVERY_DISABLED` /
 * `MARS_SCORING_DISABLED`) and every consumer read them back as a process
 * global. That made a lever change an ambient mutation: nothing in a
 * consumer's signature said it depended on a lever, tests had to poke
 * `process.env`, and any process that was not the daemon (a CLI invocation,
 * a worker child) silently saw the default because nobody had run the
 * projection there.
 *
 * Now `resolveControlLevers()` composes the two real sources — the persisted
 * `controlLevers` block in `daemon.json` and the documented `MARS_*_DISABLED`
 * env escape hatches — into a plain `ControlLevers` value, and consumers take
 * that value as a parameter. The env read lives here and nowhere else, so
 * "which levers are in effect" is answerable by reading one function instead
 * of grepping for env-var names.
 *
 * Resolution order: `daemon.json` first, then the env override. An env
 * override can only DISABLE (`=1` means off), matching the semantics the
 * projection had — there was never an env value that turned a persisted
 * `off` back on.
 */
import { readControlLevers, type ControlLevers } from '../daemon/config'

/**
 * The env escape hatch for each lever that has one. `=1` forces the lever
 * `off` for this process; any other value (including absent) defers to
 * `daemon.json`. Documented to operators by `mars install` (see
 * `src/cli/commands/install.ts`).
 */
const LEVER_ENV_OVERRIDES: ReadonlyArray<{
  lever: 'recovery' | 'scoring'
  varName: string
}> = [
  { lever: 'recovery', varName: 'MARS_RECOVERY_DISABLED' },
  { lever: 'scoring', varName: 'MARS_SCORING_DISABLED' },
]

/**
 * The effective control levers for this process: persisted `daemon.json`
 * values with the `MARS_*_DISABLED` env overrides applied on top.
 *
 * Resolved on every call rather than cached, because `mars operator set
 * <lever>` persists to `daemon.json` and expects the running daemon to pick
 * the new value up without a restart — the same live-effect guarantee the
 * old `apply-lever` RPC provided by mutating `process.env`.
 *
 * @param env injectable for hermetic tests; defaults to `process.env`.
 */
export const resolveControlLevers = (env: NodeJS.ProcessEnv = process.env): ControlLevers => {
  const levers = { ...readControlLevers() }
  for (const { lever, varName } of LEVER_ENV_OVERRIDES) {
    if (env[varName] === '1') levers[lever] = 'off'
  }
  return levers
}

/** True when self-heal (fix-task and Investigator spawning) must not run. */
export const isRecoveryDisabled = (levers: ControlLevers): boolean => levers.recovery === 'off'

/**
 * True when the operator has disabled auto-commit of dirty operator edits on
 * `main` before a merge fast-forward. No env override — `operatorAutoCommit`
 * is absent from `LEVER_ENV_OVERRIDES`. Nothing consumes this yet (lever
 * surface only, PRD ce46f01e-concurrent-writing-on-main-rebase-verify
 * slice 9); a later slice wires the behaviour in.
 */
export const isOperatorAutoCommitDisabled = (levers: ControlLevers): boolean =>
  levers.operatorAutoCommit === 'off'
