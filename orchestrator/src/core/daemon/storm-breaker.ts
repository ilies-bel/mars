/**
 * Daemon-side controller for the signature-storm circuit breaker.
 *
 * When the all-gate breaker trips, dispatch is PAUSED and a write-capable
 * Steward is woken on its own worktree to land a fix. Two defects made that
 * pause the single largest source of dead queue time:
 *
 *  A. A Steward that did nothing was indistinguishable from one that worked.
 *     The dispatch path recorded no ledger row, so a run that produced zero
 *     commits, a clean worktree and no report left no evidence at all — and a
 *     non-zero exit only reached a log line.
 *  B. Resume was driven by a 30-minute fallback timer on every path except
 *     "the Steward landed a fix". A Steward that finished and reported "I
 *     cannot fix this" still held dispatch down for the full bound.
 *
 * This module inverts that: the Steward's **report** is the resume trigger,
 * for every terminal outcome (`fixed`, `no-op`, `failed`). The fallback timer
 * covers only the case where the run never reports at all — the daemon-level
 * crash or hang. Because `runSteward` here is invoked inside a try/catch that
 * synthesises a `failed` report from a thrown error, "never reports" really
 * does mean the coroutine died or wedged, not merely that the agent errored.
 *
 * Every terminal outcome is appended to `steward_ledger`, so a no-op Steward
 * is now a first-class, queryable fact rather than an absence of evidence.
 *
 * ## Pause invariant
 *
 * `resume()` clears the in-memory pause AND the durable breaker flag together
 * so the two halves cannot drift, and is a no-op unless the pause reason is
 * `'storm'` — an operator pause is never clobbered by a storm resume.
 *
 * ## Escalation (no silent pause/resume cycling)
 *
 * Resuming while the root cause is unfixed re-trips the breaker; that is
 * intended and self-limiting, because every re-trip costs N real task
 * failures. What is NOT acceptable is spawning a fresh Steward worktree on
 * each cycle forever — a Steward that dies in a second (missing binary, bad
 * credentials) would otherwise loop tightly. So each failure signature gets a
 * budget of {@link STORM_STEWARD_ATTEMPTS_PER_SIGNATURE} Steward dispatches.
 * Once spent, the signature is ESCALATED: no pause, no Steward, one urgent
 * operator row (deduped, so repeats bump `seen_count`). The budget resets when
 * a Steward actually fixes the signature, or when the daemon restarts (a
 * restart is itself an environment change worth one more attempt).
 */

import { STEWARD_STORM_TIMEOUT_MS } from '../agents/steward'
import type { StewardLedgerEntry } from '../steward-ledger'
import type { PauseController } from './pause-state'

/** Terminal classification of one storm-Steward run. */
export type StormStewardOutcome = 'fixed' | 'no-op' | 'failed'

/** The trip notification the recovery-spawner hands the daemon. */
export interface StormTrip {
  signature: string
  streak: number
  lastTaskId: string
}

/**
 * What the daemon learned from one Steward run. `runSteward` must return one
 * of these for every outcome it can classify; only a thrown error or a hang is
 * treated as "did not report".
 */
export interface StormStewardReport {
  outcome: StormStewardOutcome
  /** The dispatched steward id, or null when the run died before dispatch. */
  stewardId: string | null
  branch: string | null
  worktree: string | null
  /** The Steward's own report, or the failure that ended the run. */
  rationale: string
  /** Head sha of the branch when the run landed commits, else null. */
  commitSha: string | null
  /**
   * False when the brief carried no real captured output (empty `error`
   * columns, or derived `recovery_failed:` status padding). A no-op with
   * `evidenceUsable: false` is a Mars data problem, not a Steward that gave
   * up — the ledger has to keep the two apart.
   */
  evidenceUsable: boolean
}

/** Context for the operator escalation raised once a signature's budget is spent. */
export interface StormEscalation extends StormTrip {
  /** Steward dispatches already spent on this signature. */
  attempts: number
  lastOutcome: StormStewardOutcome
  lastRationale: string
}

export interface StormBreakerDeps {
  log: (message: string) => void
  /** The daemon's ONE authoritative dispatch-pause state. */
  pause: PauseController
  /** Clear the durable `tripped` flag + streak (resetFailureSignatureStreak). */
  clearBreakerFlag: () => Promise<void>
  /** Post-resume side effects: view broadcast + drain. */
  onResumed: () => void
  /** Run the write-capable Steward. May throw; a throw becomes a `failed` report. */
  runSteward: (trip: StormTrip) => Promise<StormStewardReport>
  /** Append the terminal outcome to `steward_ledger`. */
  recordLedger: (entry: StewardLedgerEntry) => Promise<unknown>
  /** Raise the urgent operator row for a signature whose Steward budget is spent. */
  raiseEscalation: (escalation: StormEscalation) => Promise<void>
  /** Override the crash/hang fallback bound (tests). Defaults to the resolved value. */
  fallbackResumeMs?: number
}

export interface StormBreaker {
  /** Handle a first-trip storm notification. Fire-and-forget by design. */
  onTrip: (trip: StormTrip) => void
  /**
   * Release a storm pause: clears the in-memory pause AND the durable breaker
   * flag in one step. No-op when the current pause is not a storm pause.
   */
  resume: (by: string) => Promise<void>
  /**
   * Arm the crash/hang fallback for a storm restored at daemon startup (the
   * durable `tripped` flag survived a restart, so no Steward is in flight).
   */
  armFallback: (signature: string) => void
  /** Resolves once the in-flight episode (if any) has settled. Test seam. */
  settled: () => Promise<void>
  /** Drop the fallback timer on shutdown. */
  dispose: () => void
  /** The effective crash/hang fallback bound, for logging and tests. */
  readonly fallbackResumeMs: number
}

/**
 * Slack added on top of the Steward's own wall-clock budget to derive the
 * crash/hang fallback bound. The fallback MUST outlast a healthy Steward run
 * or it fires mid-diagnosis, resumes into the unfixed signature, and re-trips
 * the breaker while the first Steward is still working.
 */
export const STORM_FALLBACK_GRACE_MS = 2 * 60_000

/** Steward dispatches allowed per failure signature before escalating. */
export const STORM_STEWARD_ATTEMPTS_PER_SIGNATURE = 2

/** Dedup key for the escalation row. Distinct from the storm row's own key. */
export const stormEscalationSignature = (signature: string): string =>
  `signature-storm-unresolved:${signature}`

/**
 * The bound on how long a storm may hold dispatch when the Steward run never
 * reports back.
 *
 * Derived rather than magic: `runClaudeCode` already kills the Steward at
 * {@link STEWARD_STORM_TIMEOUT_MS} and returns exit 124, which this module
 * turns into a `failed` report and an immediate resume. So the fallback only
 * fires when that inner timeout ALSO failed — a wedged event loop or a
 * coroutine that never settles. It must therefore be strictly greater than the
 * inner budget (hence the grace), and there is no reason for it to be any
 * larger than that. `MARS_STORM_RESUME_MS` overrides it.
 */
export const resolveStormFallbackResumeMs = (
  stewardTimeoutMs: number = STEWARD_STORM_TIMEOUT_MS,
): number => {
  const raw = Number(process.env.MARS_STORM_RESUME_MS)
  if (Number.isFinite(raw) && raw > 0) return raw
  return stewardTimeoutMs + STORM_FALLBACK_GRACE_MS
}

interface EpisodeState {
  /** Steward dispatches already spent on this signature. */
  stewardAttempts: number
  /** True once the budget is spent and the operator owns the signature. */
  escalated: boolean
  lastOutcome: StormStewardOutcome | null
  lastRationale: string
}

const newEpisode = (): EpisodeState => ({
  stewardAttempts: 0,
  escalated: false,
  lastOutcome: null,
  lastRationale: '',
})

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export const createStormBreaker = (deps: StormBreakerDeps): StormBreaker => {
  const { log, pause } = deps
  const fallbackResumeMs = deps.fallbackResumeMs ?? resolveStormFallbackResumeMs()
  const episodes = new Map<string, EpisodeState>()

  let fallbackTimer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> = Promise.resolve()

  const clearFallbackTimer = (): void => {
    if (fallbackTimer !== null) {
      clearTimeout(fallbackTimer)
      fallbackTimer = null
    }
  }

  const resume = async (by: string): Promise<void> => {
    if (pause.get().reason !== 'storm') {
      // Not our pause to lift — an operator (or quota) pause owns the slot.
      return
    }
    clearFallbackTimer()
    pause.resume()
    try {
      await deps.clearBreakerFlag()
    } catch (err) {
      log(`[signature-storm] breaker reset failed (non-fatal): ${errText(err)}`)
    }
    log(`[signature-storm] dispatch resumed (${by})`)
    deps.onResumed()
  }

  /**
   * Clear the durable breaker flag without touching a pause we do not own.
   * Used on the escalated path, where we deliberately never paused: leaving
   * `tripped` set would suppress every future trip notification AND re-pause
   * the queue on the next daemon restart.
   */
  const clearBreakerOnly = async (by: string): Promise<void> => {
    try {
      await deps.clearBreakerFlag()
      log(`[signature-storm] breaker flag cleared without pausing (${by})`)
    } catch (err) {
      log(`[signature-storm] breaker reset failed (non-fatal): ${errText(err)}`)
    }
  }

  const armFallback = (signature: string): void => {
    if (fallbackTimer !== null) return
    const at = new Date(Date.now() + fallbackResumeMs).toISOString()
    log(`[signature-storm] crash/hang fallback resume armed for ${at}`)
    fallbackTimer = setTimeout(() => {
      fallbackTimer = null
      log(
        `[signature-storm] fallback resume firing — the Steward for "${signature}" never reported an outcome`,
      )
      void resume('fallback timer (Steward never reported)')
    }, fallbackResumeMs)
    // Never hold the process open on this timer.
    fallbackTimer.unref?.()
  }

  const writeLedger = async (
    trip: StormTrip,
    report: StormStewardReport,
  ): Promise<void> => {
    try {
      await deps.recordLedger({
        targetKind: 'signature-storm',
        targetId: trip.signature,
        // The streak is what makes one episode distinguishable from the next
        // occurrence of the same signature.
        targetVersion: `streak-${trip.streak}`,
        recipeId: 'signature-storm-steward',
        rationale: report.rationale,
        outcome: JSON.stringify({
          state: report.outcome,
          stewardId: report.stewardId,
          branch: report.branch,
          worktree: report.worktree,
          signature: trip.signature,
          streak: trip.streak,
          lastTaskId: trip.lastTaskId,
          evidence: report.evidenceUsable ? 'usable' : 'insufficient',
        }),
        commitSha: report.commitSha,
      })
    } catch (err) {
      // Best-effort: losing the evidence must not also lose the resume.
      log(`[signature-storm] ledger write failed (non-fatal): ${errText(err)}`)
    }
  }

  const runEpisode = async (trip: StormTrip, episode: EpisodeState): Promise<void> => {
    episode.stewardAttempts += 1
    let report: StormStewardReport
    try {
      report = await deps.runSteward(trip)
    } catch (err) {
      // A throw is still an outcome the daemon can name — it is NOT the
      // "never reported" case the fallback timer exists for.
      report = {
        outcome: 'failed',
        stewardId: null,
        branch: null,
        worktree: null,
        rationale: `steward dispatch threw before reporting: ${errText(err)}`,
        commitSha: null,
        evidenceUsable: false,
      }
    }

    episode.lastOutcome = report.outcome
    episode.lastRationale = report.rationale
    await writeLedger(trip, report)
    log(
      `[signature-storm] steward ${report.stewardId ?? '(undispatched)'} reported ` +
        `${report.outcome} for "${trip.signature}" (attempt ${episode.stewardAttempts}/${STORM_STEWARD_ATTEMPTS_PER_SIGNATURE})`,
    )

    if (report.outcome === 'fixed') {
      // The signature is presumed healthy again; give it a full budget back.
      episodes.delete(trip.signature)
    } else if (episode.stewardAttempts >= STORM_STEWARD_ATTEMPTS_PER_SIGNATURE) {
      episode.escalated = true
      log(
        `[signature-storm] "${trip.signature}" escalated to the operator — ` +
          `${episode.stewardAttempts} Steward attempt(s) produced no fix`,
      )
      await escalate(trip, episode)
    }

    // Every reported outcome resumes immediately. Waiting out a timer after the
    // Steward has already said "I could not fix this" is pure dead queue.
    await resume(`steward reported ${report.outcome}`)
  }

  const escalate = async (trip: StormTrip, episode: EpisodeState): Promise<void> => {
    try {
      await deps.raiseEscalation({
        ...trip,
        attempts: episode.stewardAttempts,
        lastOutcome: episode.lastOutcome ?? 'failed',
        lastRationale: episode.lastRationale,
      })
    } catch (err) {
      log(`[signature-storm] escalation raise failed (non-fatal): ${errText(err)}`)
    }
  }

  const onTrip = (trip: StormTrip): void => {
    const episode = episodes.get(trip.signature) ?? newEpisode()
    episodes.set(trip.signature, episode)

    if (episode.escalated) {
      // The operator owns this signature now. Do NOT pause and do NOT spawn a
      // third Steward: that is exactly the silent pause/resume cycle this
      // budget exists to stop. Re-raise (deduped) so the row's seen_count
      // records that the storm is still happening.
      log(
        `[signature-storm] "${trip.signature}" x${trip.streak} re-tripped while escalated — ` +
          `not pausing, not dispatching another Steward`,
      )
      inFlight = (async () => {
        await escalate(trip, episode)
        await clearBreakerOnly(`escalated signature ${trip.signature}`)
        deps.onResumed()
      })()
      return
    }

    if (!pause.pause('storm', `signature storm: ${trip.signature} x${trip.streak}`)) {
      // Already paused (concurrent storm, quota rejection, or an operator
      // pause). The action-queue row is already up; no duplicate side effects.
      log(
        `[signature-storm] already paused (${pause.get().reason}) — storm for "${trip.signature}" x${trip.streak} noted (no-op)`,
      )
      return
    }

    log(
      `[signature-storm] dispatch paused — "${trip.signature}" failed ${trip.streak} consecutive tasks; waking write-capable steward`,
    )
    // Bound the pause FIRST: if the run below never reports, dispatch still
    // comes back on its own.
    armFallback(trip.signature)
    inFlight = runEpisode(trip, episode)
  }

  return {
    onTrip,
    resume,
    armFallback,
    settled: () => inFlight,
    dispose: clearFallbackTimer,
    fallbackResumeMs,
  }
}
