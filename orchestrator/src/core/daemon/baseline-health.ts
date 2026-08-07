/**
 * Baseline health checker for the integration branch.
 *
 * Detects a "poisoned baseline" — the case where the integration branch
 * itself fails a required task-tier verify gate — BEFORE dispatching tasks,
 * so individual failures aren't misattributed as code defects and don't drive
 * the signature-storm streak.
 *
 * Design decisions:
 *
 *   1. Gate scope. We run the same "task-tier" required gates that per-task
 *      verify runs, because those are the gates that will fail for every task
 *      dispatched off a broken baseline.  "integration" tier gates are a
 *      separate concern (they run at merge time, not per-task) and are ignored
 *      here.
 *
 *   2. Exactly-one action-queue row. `raiseActionQueueItem` deduplicates on
 *      `(kind, signature)` when `originTaskId` is absent; we always use
 *      `kind='baseline-broken'` and `signature='baseline-broken'`, so a
 *      second call while the row is still open is a no-op bump of `seen_count`.
 *      When the baseline recovers we call `supersedeActionQueueItemsBySignature`
 *      which closes the row idempotently.
 *
 *   3. First-cause-wins pause. `pause.pause('baseline', ...)` returns false
 *      when dispatch is already paused for another reason, which is fine — we
 *      still set `_poisoned = true` so the override callback works.  When the
 *      baseline recovers we call `pause.resume()` only if the current cause is
 *      `'baseline'`, to avoid silently clearing an unrelated operator/storm pause.
 *
 *   4. Poison override. `isBaselinePoisoned()` is polled by the closure that
 *      the daemon passes as `overrideFailingStep` to `drainRecoverySpawner`.
 *      When true AND the task's derived failing step starts with `verify:`, the
 *      step is replaced with `verify:poisoned-baseline`, which (a) exempts it
 *      from the storm streak and (b) makes the failure clearly attributed.
 *
 * All external dependencies are injected so the module is independently unit
 * testable without a real daemon or database.
 */

import type { PauseController } from './pause-state.js'

/** A single gate to probe on the integration branch. */
export interface BaselineGate {
  id: string
  name: string
  cmd: string
  args: string[]
  /** Repo-relative scope directory; '.' means the repo root. */
  scope: string
  required: boolean
}

/** Result of running one gate. */
export interface GateResult {
  gate: BaselineGate
  exitCode: number
  stdout: string
  stderr: string
}

/** Injectable side-effect dependencies. */
export interface BaselineHealthDeps {
  /** Absolute path to the repo root (where the integration branch lives). */
  repoRoot: string
  /** Load the required task-tier gates that should be probed. */
  loadGates: () => Promise<BaselineGate[]>
  /** Run a single gate in `cwd`. Returns the raw process result. */
  runGate: (gate: BaselineGate, cwd: string) => Promise<GateResult>
  /** The daemon's shared pause controller. */
  pause: PauseController
  /**
   * Raise a `baseline-broken` action-queue item. Implementors should call
   * `raiseActionQueueItem` with `kind='baseline-broken'` and a fixed signature
   * so the existing dedup logic ensures exactly one open row.
   */
  raiseActionQueueRow: (failingGateName: string, output: string) => Promise<void>
  /**
   * Resolve the open `baseline-broken` row, if any.  Called when the baseline
   * passes all gates again.
   */
  resolveActionQueueRow: () => Promise<void>
  /** Optional logger. */
  log?: (msg: string) => void
}

/** Public surface exposed to the rest of the daemon. */
export interface BaselineHealthChecker {
  /**
   * Run all required task-tier gates against the integration branch.
   * Pauses dispatch (reason=`'baseline'`) and raises one action-queue item on
   * the first failing required gate; resumes and resolves the item when all
   * pass.
   *
   * @returns `{ poisoned: true }` when at least one required gate failed.
   */
  check(): Promise<{ poisoned: boolean }>
  /**
   * True while the integration branch is known to fail at least one required
   * task-tier gate.  Polled by `drainRecoverySpawner`'s `overrideFailingStep`
   * callback to reclassify task verify failures as `verify:poisoned-baseline`.
   */
  isBaselinePoisoned(): boolean
}

/**
 * Factory function — wires up a {@link BaselineHealthChecker} from injected
 * dependencies.
 */
export const createBaselineHealthChecker = (
  deps: BaselineHealthDeps,
): BaselineHealthChecker => {
  const { repoRoot, loadGates, runGate, pause, raiseActionQueueRow, resolveActionQueueRow, log } =
    deps

  let _poisoned = false

  return {
    isBaselinePoisoned: () => _poisoned,

    async check(): Promise<{ poisoned: boolean }> {
      let gates: BaselineGate[]
      try {
        gates = await loadGates()
      } catch (err) {
        log?.(
          `[baseline-health] could not load gates (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
        // When we cannot even read the gate list, conservatively do not change
        // the current poison state — avoid a transient DB hiccup clearing a
        // real poison flag.
        return { poisoned: _poisoned }
      }

      // Only required task-tier gates are relevant: those are the gates that
      // fail a task during the verify phase.
      const required = gates.filter((g) => g.required)
      if (required.length === 0) {
        // No gates configured yet.  Treat baseline as healthy and clear any
        // stale poison state from a prior run.
        if (_poisoned) {
          _poisoned = false
          if (pause.get().reason === 'baseline') pause.resume()
          await resolveActionQueueRow().catch((err) =>
            log?.(
              `[baseline-health] resolveActionQueueRow failed (non-fatal): ${
                err instanceof Error ? err.message : String(err)
              }`,
            ),
          )
        }
        return { poisoned: false }
      }

      for (const gate of required) {
        const cwd = gate.scope === '.' ? repoRoot : `${repoRoot}/${gate.scope}`
        let result: GateResult
        try {
          result = await runGate(gate, cwd)
        } catch (err) {
          log?.(
            `[baseline-health] gate "${gate.name}" errored (treating as pass): ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
          // An unexpected execution error (e.g. binary not found) is not the
          // same as a gate failure — don't pause dispatch over it.
          continue
        }

        if (result.exitCode !== 0) {
          const output = [result.stdout, result.stderr].filter(Boolean).join('\n').slice(0, 2000)
          log?.(
            `[baseline-health] gate "${gate.name}" FAILED on integration branch (exit ${result.exitCode})`,
          )

          _poisoned = true

          // First-cause-wins: if another reason already holds the pause, don't
          // stomp it — but still mark the baseline as poisoned so the override
          // callback re-classifies subsequent task failures.
          pause.pause('baseline', `gate "${gate.name}" fails on integration branch`)

          try {
            await raiseActionQueueRow(gate.name, output)
          } catch (err) {
            log?.(
              `[baseline-health] raiseActionQueueRow failed (non-fatal): ${
                err instanceof Error ? err.message : String(err)
              }`,
            )
          }

          return { poisoned: true }
        }
      }

      // All required gates passed — baseline is healthy.
      if (_poisoned) {
        log?.('[baseline-health] all required gates pass — baseline recovered')
        _poisoned = false
        if (pause.get().reason === 'baseline') pause.resume()
        await resolveActionQueueRow().catch((err) =>
          log?.(
            `[baseline-health] resolveActionQueueRow failed (non-fatal): ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        )
      } else {
        log?.('[baseline-health] all required gates pass')
      }

      return { poisoned: false }
    },
  }
}
