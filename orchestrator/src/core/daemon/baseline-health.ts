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
 *   5. Install probe, fingerprint-gated. The required-gate list (typecheck,
 *      tests, ...) assumes `node_modules` already matches the current
 *      manifests — it does not itself prove the integration branch's
 *      dependencies are installable, which is exactly what broke in the
 *      motivating incident (an unsatisfiable version pin in a merged
 *      `package.json`). `check()` runs a cheap, separate install probe
 *      (`runInstallProbe`, e.g. `npm ci --dry-run`) against the integration
 *      branch's current manifests before the gate list, and pauses dispatch
 *      the same way a failing required gate would. Because most merges don't
 *      touch `package.json`/lockfiles, the probe is skipped — a no-op —
 *      whenever a fingerprint of the manifests/lockfiles (the same idea as
 *      the per-worktree `depFingerprintPath` skip in `setup-worktree.ts`)
 *      matches the one recorded at the last known-good check and the
 *      baseline is not currently poisoned. This is reactive (startup + after
 *      every successful merge — see server.ts), never a fixed-interval poll;
 *      the required-gate run itself is unchanged and always runs.
 *
 * All external dependencies are injected so the module is independently unit
 * testable without a real daemon or database.
 */

import type { PauseController } from './pause-state.js'

// ── Pure detection helper ─────────────────────────────────────────────────────

/**
 * Result of running the baseline detection logic without side effects.
 *
 * Returned by {@link isBaselineBroken}. The reactive
 * {@link createBaselineHealthChecker} and the scheduled registry check both
 * call this helper so the detection logic lives in exactly one place.
 */
export interface BaselineDetection {
  /** True when at least one required gate fails on the integration branch. */
  broken: boolean
  /** Name of the first failing gate (present only when broken=true). */
  failingGateName?: string
  /** Trimmed combined stdout/stderr of the failing gate (present when broken=true). */
  output?: string
  /**
   * Set when the gate list itself could not be loaded.
   * Callers should treat the baseline state as unknown and preserve existing state.
   */
  loadError?: Error
}

/**
 * Pure baseline-broken predicate — runs the required task-tier gates and
 * returns a structured result with no side effects (no pause, no AQ raise).
 *
 * Two production callers share this implementation:
 *   1. {@link createBaselineHealthChecker}.check() — the reactive path.
 *   2. The `baseline.broken` registry check's `run()` — the scheduled pass.
 *
 * @param deps - Subset of {@link BaselineHealthDeps} needed for detection.
 */
export async function isBaselineBroken(deps: {
  repoRoot: string
  loadGates: () => Promise<BaselineGate[]>
  runGate: (gate: BaselineGate, cwd: string) => Promise<GateResult>
}): Promise<BaselineDetection> {
  const { repoRoot, loadGates, runGate } = deps

  let gates: BaselineGate[]
  try {
    gates = await loadGates()
  } catch (err) {
    return { broken: false, loadError: err instanceof Error ? err : new Error(String(err)) }
  }

  const required = gates.filter((g) => g.required)
  if (required.length === 0) return { broken: false }

  for (const gate of required) {
    const cwd = gate.scope === '.' ? repoRoot : `${repoRoot}/${gate.scope}`
    let result: GateResult
    try {
      result = await runGate(gate, cwd)
    } catch {
      // An unexpected execution error (e.g. binary not found) is not the
      // same as a gate failure — treat as pass (conservative).
      continue
    }
    if (result.exitCode !== 0) {
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n').slice(0, 2000)
      return { broken: true, failingGateName: gate.name, output }
    }
  }
  return { broken: false }
}

/** A single gate to probe on the integration branch. */
export interface BaselineGate {
  id: string
  name: string
  cmd: string
  args: string[]
  /** Repo-relative scope directory; '.' means the repo root. */
  scope: string
  required: boolean
  /**
   * Per-gate wall-clock limit in minutes.
   *
   * Timeout semantics: an implementation of `runGate` SHOULD enforce this
   * limit (e.g. by passing `timeoutMs = timeoutMin * 60_000` to `execProbe`).
   * When the child process is killed for exceeding the limit it exits with a
   * signal (SIGTERM → exit 143, SIGKILL → exit 137), which is a non-zero exit
   * code and therefore treated as a gate FAILURE (`broken = true`) by
   * {@link isBaselineBroken}.  A timeout is NOT a conservative pass.
   *
   * Only an unexpected `runGate` throw — e.g. a spawn error when the binary
   * is missing — is treated as a conservative pass (the gate was not runnable,
   * not that it failed).
   *
   * `null` or absent means no per-gate timeout; implementations should apply
   * whatever process-wide default is appropriate (e.g. 15 minutes).
   */
  timeoutMin?: number | null
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
  /** Optional logger. */
  log?: (msg: string) => void
  /**
   * Compute a fingerprint of the integration branch's package manifests and
   * lockfiles (mirrors the per-worktree dep-fingerprint used by
   * `setup-worktree.ts`'s install-skip). Returns `null` when no manifest or
   * lockfile is found. When the fingerprint matches the one recorded at the
   * last known-good check, `check()` skips `runInstallProbe` rather than
   * calling it. A `null` fingerprint never matches, so the probe always runs.
   */
  computeDepFingerprint: (repoRoot: string) => Promise<string | null>
  /**
   * Cheap probe of the integration branch's install state (e.g.
   * `npm ci --dry-run` in `repoRoot`) — does not mutate `node_modules`.
   * A non-zero exit poisons the baseline immediately, without waiting for
   * the required-gate list (which assumes deps are already installed and
   * would fail for an unhelpful, unrelated reason).
   */
  runInstallProbe: (
    repoRoot: string,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>
}

/** Public surface exposed to the rest of the daemon. */
export interface BaselineHealthChecker {
  /**
   * Run all required task-tier gates against the integration branch.
   * Pauses dispatch (reason=`'baseline'`) when a required gate fails and
   * resumes when all pass.
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
  /**
   * Returns the last recorded baseline detection result, or null when no
   * check has been run yet.  Used by the derivation layer to populate the
   * `baseline-broken` action-queue row with the failing gate name and output.
   */
  getLastDetection(): BaselineDetection | null
}

/**
 * Factory function — wires up a {@link BaselineHealthChecker} from injected
 * dependencies.
 */
export const createBaselineHealthChecker = (
  deps: BaselineHealthDeps,
): BaselineHealthChecker => {
  const { repoRoot, loadGates, runGate, pause, log, computeDepFingerprint, runInstallProbe } = deps

  let _poisoned = false
  let _lastDetection: BaselineDetection | null = null
  let _lastGoodFingerprint: string | null = null
  // Deduplication slot: when a check is already in flight, concurrent callers
  // receive the same promise rather than spawning a second gate sweep.
  // Without this, a slow check started while the baseline was broken can
  // finish AFTER a fast check that proved recovery, overwriting the correct
  // in-memory state with stale gate results whose subprocess had already been
  // spawned against the old, broken code.
  let _checkInProgress: Promise<{ poisoned: boolean }> | null = null

  return {
    isBaselinePoisoned: () => _poisoned,
    getLastDetection: () => _lastDetection,

    check(): Promise<{ poisoned: boolean }> {
      if (_checkInProgress !== null) return _checkInProgress

      const p = (async (): Promise<{ poisoned: boolean }> => {
        let fingerprint: string | null = null
        try {
          fingerprint = await computeDepFingerprint(repoRoot)
        } catch (err) {
          // A fingerprint failure must not block the probe — fall through to a
          // real install probe (equivalent to a fingerprint that never matches).
          log?.(
            `[baseline-health] could not compute dependency fingerprint (non-fatal): ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }

        const skipInstallProbe =
          !_poisoned && fingerprint !== null && fingerprint === _lastGoodFingerprint

        if (skipInstallProbe) {
          log?.(
            '[baseline-health] dependency fingerprint unchanged since last known-good check — skipping install probe',
          )
        } else {
          let install: { exitCode: number; stdout: string; stderr: string } | null = null
          try {
            install = await runInstallProbe(repoRoot)
          } catch (err) {
            // An unexpected execution error (e.g. binary not found) is not the
            // same as an install failure — treat as pass (conservative), same
            // policy as a gate that throws in isBaselineBroken.
            log?.(
              `[baseline-health] install probe errored (non-fatal, treated as pass): ${
                err instanceof Error ? err.message : String(err)
              }`,
            )
          }

          if (install && install.exitCode !== 0) {
            const output = [install.stdout, install.stderr].filter(Boolean).join('\n').slice(0, 2000)
            log?.('[baseline-health] dependency install FAILED on integration branch')
            _lastDetection = { broken: true, failingGateName: 'dependency install', output }
            _poisoned = true
            pause.pause('baseline', 'dependency install fails on integration branch')
            return { poisoned: true }
          }
        }

        const detection = await isBaselineBroken({ repoRoot, loadGates, runGate })

        if (detection.loadError) {
          log?.(
            `[baseline-health] could not load gates (non-fatal): ${detection.loadError.message}`,
          )
          // When we cannot even read the gate list, conservatively do not change
          // the current poison state — avoid a transient DB hiccup clearing a
          // real poison flag.
          return { poisoned: _poisoned }
        }

        if (!detection.broken) {
          // No required gates configured, or all required gates (and the
          // install probe, if it ran) passed. Record the fingerprint behind
          // this healthy result so the next check() can skip the install probe
          // if nothing changed.
          //
          // Clear any stale detection data: captured gate output must not
          // outlive the verdict that produced it. Callers reading
          // getLastDetection() after recovery must get null, not the previous
          // failing probe's output.
          _lastDetection = null
          if (fingerprint !== null) _lastGoodFingerprint = fingerprint
          if (_poisoned) {
            log?.('[baseline-health] all required gates pass — baseline recovered')
            _poisoned = false
            if (pause.get().reason === 'baseline') pause.resume()
          } else {
            log?.('[baseline-health] all required gates pass')
          }
          return { poisoned: false }
        }

        // At least one required gate failed.
        _lastDetection = detection
        const { failingGateName = '(unknown)' } = detection
        log?.(
          `[baseline-health] gate "${failingGateName}" FAILED on integration branch`,
        )

        _poisoned = true

        // First-cause-wins: if another reason already holds the pause, don't
        // stomp it — but still mark the baseline as poisoned so the override
        // callback re-classifies subsequent task failures.
        pause.pause('baseline', `gate "${failingGateName}" fails on integration branch`)

        return { poisoned: true }
      })()

      _checkInProgress = p
      // Clear the dedup slot once the promise settles so the next independent
      // call starts a fresh gate sweep rather than awaiting a stale promise.
      void p.finally(() => { _checkInProgress = null })
      return p
    },
  }
}

// ── Baseline pause watcher ─────────────────────────────────────────────────

/**
 * Periodic watcher that re-runs the baseline health check whenever the
 * integration branch SHA advances while dispatch is paused for `'baseline'`.
 *
 * Motivation (observed incident 2026-09-01): the only previous trigger for
 * re-running the health check was a `task.completed` event, which never fires
 * while dispatch is paused — creating a self-deadlock. This watcher breaks
 * that cycle by polling the branch SHA independently of dispatch:
 *
 *   1. Every `intervalMs` (default 60 s), read the current integration-branch
 *      SHA via `getIntegrationBranchSha`.
 *   2. Skip the check when dispatch is not paused for `'baseline'` — the
 *      watcher is a no-op in the healthy-dispatch steady state.
 *   3. When the observed SHA differs from the last-known SHA, call
 *      `checkBaseline()`. If the gates now pass the checker's internal state
 *      transitions from poisoned → healthy and the pause is cleared.
 *
 * The SHA comparison prevents the expensive gate run from firing on every
 * tick; the gates only run when the integration branch actually moved.
 *
 * The timer is `unref()`'d so it never prevents a clean process exit.
 * Call `stop()` in the daemon's shutdown path to disarm it explicitly.
 */
export interface BaselinePauseWatcher {
  stop(): void
}

export interface BaselinePauseWatcherDeps {
  /** The daemon's shared pause controller — read-only from this watcher. */
  pause: PauseController
  /**
   * Read the current SHA of the integration branch. May return `null` on git
   * error; a null SHA never matches a previous non-null one, so a transient
   * git error triggers a check rather than suppressing one. Non-fatal: an
   * error here is swallowed and the next tick retries.
   */
  getIntegrationBranchSha: () => Promise<string | null>
  /**
   * Run the baseline health check (delegates to
   * {@link BaselineHealthChecker.check}). Called only when the integration
   * branch SHA advances while dispatch is paused for `'baseline'`.
   */
  checkBaseline: () => Promise<{ poisoned: boolean }>
  /** Poll cadence in milliseconds. Defaults to 60 000 (1 minute). */
  intervalMs?: number
  /** Optional logger. */
  log?: (msg: string) => void
}

/**
 * Factory — creates and starts a {@link BaselinePauseWatcher}.
 *
 * Wire this in `startDaemon` immediately after the baseline health checker is
 * created, and call `stop()` inside the daemon's `shutdown()` closure.
 */
export function startBaselinePauseWatcher(
  deps: BaselinePauseWatcherDeps,
): BaselinePauseWatcher {
  const { pause, getIntegrationBranchSha, checkBaseline, log } = deps
  const intervalMs = deps.intervalMs ?? 60_000

  let _lastObservedSha: string | null = null
  let _checkInFlight = false

  const tick = async (): Promise<void> => {
    if (pause.get().reason !== 'baseline') return

    let sha: string | null
    try {
      sha = await getIntegrationBranchSha()
    } catch (err) {
      log?.(
        `[baseline-pause-watcher] could not read integration branch SHA (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      return
    }

    if (sha === _lastObservedSha) return
    _lastObservedSha = sha

    if (_checkInFlight) return
    _checkInFlight = true
    try {
      log?.(
        `[baseline-pause-watcher] integration branch advanced (sha=${sha ?? 'null'}) — re-checking baseline`,
      )
      const { poisoned } = await checkBaseline()
      if (!poisoned) {
        log?.('[baseline-pause-watcher] baseline recovered — dispatch resumed')
      }
    } catch (err) {
      log?.(
        `[baseline-pause-watcher] check failed (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    } finally {
      _checkInFlight = false
    }
  }

  const timer = setInterval(() => {
    void tick()
  }, intervalMs)
  timer.unref()

  return {
    stop: () => clearInterval(timer),
  }
}
