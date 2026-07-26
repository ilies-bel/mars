/**
 * Pure spend-controller decision function.
 *
 * `decideDispatchControl(inputs)` maps current signals — rolling token spend,
 * circuit-breaker state, recent task-health counters, and operator levers —
 * to an explicit decision object. No I/O, no implicit clocks; pass `nowMs`
 * explicitly so tests remain deterministic without mocking globals.
 *
 * Determination order:
 *   1. Circuit-breaker tripped → paused.
 *   2. spendWindow.usedPct >= levers.pauseThresholdPct → paused.
 *   3. wasPaused AND usedPct >= levers.resumeThresholdPct → still paused
 *      (hysteresis: hold until we drop below the resume threshold).
 *   4. wasPaused AND usedPct < levers.resumeThresholdPct → paused=false,
 *      rampBackFactor = rampBackStepPct / 100.
 *   5. Otherwise → paused=false, rampBackFactor=1.
 *
 * suppressRecovery is true when levers.suppressRecovery OR paused
 * OR health.recentRecoveryFailures >= 3.
 */

import { z } from 'zod'
import { SpendControlLevers } from './store.js'

// ── Input schemas ──────────────────────────────────────────────────────────────

/** Rolling spend window signal. */
export const SpendWindow = z.object({
  /** Current spend utilisation as a percentage 0–100. */
  usedPct: z.number().min(0).max(100),
  /** Whether dispatch was paused on the previous evaluation cycle. */
  wasPaused: z.boolean(),
})
export type SpendWindow = z.infer<typeof SpendWindow>

/** Snapshot of the API circuit-breaker state (mirrors BreakerState). */
export const BreakerSnapshot = z.object({
  open: z.boolean(),
  reason: z.string().nullable(),
  openedAt: z.number().nullable(),
})
export type BreakerSnapshot = z.infer<typeof BreakerSnapshot>

/** Recent task-health counters. */
export const HealthCounters = z.object({
  /** Number of recovery/fix-tasks that have failed in the recent window. */
  recentRecoveryFailures: z.number().int().nonnegative(),
})
export type HealthCounters = z.infer<typeof HealthCounters>

/** All inputs required for a dispatch-control decision. */
export const DecisionInputs = z.object({
  spendWindow: SpendWindow,
  breaker: BreakerSnapshot,
  health: HealthCounters,
  levers: SpendControlLevers,
  /**
   * Wall-clock timestamp (ms since epoch). Accepted explicitly so the
   * function remains pure and tests need not mock Date.now().
   */
  nowMs: z.number(),
})
export type DecisionInputs = z.infer<typeof DecisionInputs>

// ── Output schema ──────────────────────────────────────────────────────────────

/** The controller's decision for the current evaluation cycle. */
export const SpendControlDecision = z.object({
  /** When true, no new tasks should be dispatched this cycle. */
  paused: z.boolean(),
  /**
   * Effective per-kind concurrency ceilings. Empty record means no per-kind
   * override (ambient semaphore caps apply). Values from levers.perKindCeilings
   * are passed through; null levers produce an empty record.
   */
  perKindCeilings: z.record(z.string(), z.number()),
  /** When true, recovery / fix-task spawning should be suppressed. */
  suppressRecovery: z.boolean(),
  /** Human-readable explanation of the decision. */
  reason: z.string(),
  /**
   * Fraction of normal concurrency to apply (0–1). 1 = full throughput;
   * <1 = incremental ramp-back after a pause clears; 0 = fully paused.
   */
  rampBackFactor: z.number().min(0).max(1),
})
export type SpendControlDecision = z.infer<typeof SpendControlDecision>

// ── Decision function ──────────────────────────────────────────────────────────

/**
 * Compute the dispatch-control decision for the current cycle.
 *
 * Pure: no side effects, no I/O, no implicit time sources.
 */
export function decideDispatchControl(inputs: DecisionInputs): SpendControlDecision {
  const { spendWindow, breaker, health, levers } = inputs
  const { usedPct, wasPaused } = spendWindow
  const { pauseThresholdPct, resumeThresholdPct, rampBackStepPct, perKindCeilings } = levers

  const effectiveCeilings: Record<string, number> = perKindCeilings ?? {}

  // 1. Circuit-breaker tripped → paused.
  if (breaker.open) {
    return {
      paused: true,
      perKindCeilings: effectiveCeilings,
      suppressRecovery: true,
      reason: `circuit breaker open: ${breaker.reason ?? 'unknown'}`,
      rampBackFactor: 0,
    }
  }

  // 2. Spend at or above pause threshold → paused.
  if (usedPct >= pauseThresholdPct) {
    return {
      paused: true,
      perKindCeilings: effectiveCeilings,
      suppressRecovery: true,
      reason: `spend rate ${usedPct}% >= pause threshold ${pauseThresholdPct}%`,
      rampBackFactor: 0,
    }
  }

  // 3. Hysteresis hold: previously paused, not yet below resume threshold.
  if (wasPaused && usedPct >= resumeThresholdPct) {
    return {
      paused: true,
      perKindCeilings: effectiveCeilings,
      suppressRecovery: true,
      reason: `spend rate ${usedPct}% above resume threshold ${resumeThresholdPct}% (recovering)`,
      rampBackFactor: 0,
    }
  }

  // 4. Previously paused, now below resume threshold → ramp back.
  if (wasPaused) {
    const rampBackFactor = rampBackStepPct / 100
    const suppressRecovery =
      levers.suppressRecovery || health.recentRecoveryFailures >= 3
    return {
      paused: false,
      perKindCeilings: effectiveCeilings,
      suppressRecovery,
      reason: `spend rate ${usedPct}% below resume threshold ${resumeThresholdPct}% (ramping back at ${rampBackFactor})`,
      rampBackFactor,
    }
  }

  // 5. Normal: within budget, not previously paused.
  const suppressRecovery = levers.suppressRecovery || health.recentRecoveryFailures >= 3
  return {
    paused: false,
    perKindCeilings: effectiveCeilings,
    suppressRecovery,
    reason: 'within budget',
    rampBackFactor: 1,
  }
}
