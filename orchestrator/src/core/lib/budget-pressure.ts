import type { UsageSnapshotRow } from './usage-snapshot-store.js'

export type BudgetPressure = 'ok' | 'tight' | 'critical'

export interface BudgetPressureConfig {
  tightPct: number
  criticalPct: number
}

const DEFAULT_CONFIG: BudgetPressureConfig = {
  tightPct: 70,
  criticalPct: 90,
}

const resolvePercent = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : fallback
}

/** Resolve environment overrides once for callers to reuse while scheduling. */
export const getBudgetPressureConfig = (): BudgetPressureConfig => ({
  tightPct: resolvePercent(process.env.MARS_BUDGET_TIGHT_PCT, DEFAULT_CONFIG.tightPct),
  criticalPct: resolvePercent(process.env.MARS_BUDGET_CRITICAL_PCT, DEFAULT_CONFIG.criticalPct),
})

/**
 * Classify a sampled provider window. The usage sampler keeps these two
 * provider-specific fields in `rawJson` so the persisted snapshot schema
 * remains provider agnostic:
 *
 * - `usedPct`: percentage of the current window already consumed
 * - `nextResetAt`: ISO-8601 reset time, or `null` when unavailable
 */
export const computeBudgetPressure = (
  snapshot: UsageSnapshotRow,
  cfg: BudgetPressureConfig,
): BudgetPressure => {
  const usedPct = snapshot.rawJson['usedPct']
  const nextResetAt = snapshot.rawJson['nextResetAt']
  if (typeof usedPct !== 'number' || !Number.isFinite(usedPct) || nextResetAt === null) {
    return 'ok'
  }
  if (typeof nextResetAt !== 'string') return 'ok'

  const resetAtMs = Date.parse(nextResetAt)
  const remainingMs = resetAtMs - Date.now()
  if (!Number.isFinite(resetAtMs) || remainingMs <= 0) return 'ok'
  if (usedPct >= cfg.criticalPct) return 'critical'
  return usedPct >= cfg.tightPct && remainingMs > 2 * 60 * 60 * 1000 ? 'tight' : 'ok'
}
