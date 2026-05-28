/**
 * KPI drift detector — pure analysis, no DB writes, no proposal calls.
 *
 * Compares a current KPI snapshot to a prior one and returns one entry per
 * KPI that regressed by at least `opts.thresholdPct`, provided BOTH
 * snapshots clear the sample-floor confidence gate.
 */

export interface KpiEntry {
  /** The measured value for this KPI in this snapshot. */
  value: number;
  /**
   * Worsening direction for this KPI.
   *  - 'higher-is-better': a decrease is a regression (e.g. success-rate).
   *  - 'lower-is-better': an increase is a regression (e.g. latency).
   */
  polarity: 'higher-is-better' | 'lower-is-better';
}

export interface KpiSnapshot {
  /**
   * Whether this snapshot cleared the sample-floor gate.
   * When false the snapshot lacks enough samples to be trustworthy and drift
   * detection is suppressed entirely.
   */
  isConfident: boolean;
  /** Per-KPI values and metadata keyed by KPI name. */
  metrics: Record<string, KpiEntry>;
}

export interface DriftFinding {
  kpi: string;
  priorValue: number;
  currentValue: number;
  /** Signed percentage change: (current - prior) / |prior| * 100. */
  deltaPct: number;
  /**
   * Cross-KPI context: all KPIs present in both snapshots.
   * Callers use this to write rich cross-KPI context into the proposal body.
   */
  vector: Record<string, { prior: number; current: number }>;
}

export interface DetectKpiDriftOptions {
  /**
   * Minimum absolute percentage regression required to surface a finding.
   * Boundary is inclusive: a regression exactly equal to thresholdPct is reported.
   */
  thresholdPct: number;
}

/**
 * Compare `current` snapshot against `prior` and return the KPIs that
 * regressed beyond `opts.thresholdPct`.
 *
 * Returns `[]` when either snapshot is not confident (low sample count).
 * Returns `[]` when no KPI worsened by at least `opts.thresholdPct`.
 */
export const detectKpiDrift = (
  current: KpiSnapshot,
  prior: KpiSnapshot,
  opts: DetectKpiDriftOptions,
): DriftFinding[] => {
  if (!current.isConfident || !prior.isConfident) {
    return [];
  }

  // Build the shared cross-KPI vector once; every finding references the same object.
  const vector: Record<string, { prior: number; current: number }> = {};
  for (const kpiName of Object.keys(current.metrics)) {
    if (kpiName in prior.metrics) {
      vector[kpiName] = {
        prior: prior.metrics[kpiName].value,
        current: current.metrics[kpiName].value,
      };
    }
  }

  const findings: DriftFinding[] = [];

  for (const kpiName of Object.keys(current.metrics)) {
    const currentEntry = current.metrics[kpiName];
    const priorEntry = prior.metrics[kpiName];

    if (priorEntry === undefined) continue;

    const priorValue = priorEntry.value;
    const currentValue = currentEntry.value;

    if (priorValue === 0) continue; // division by zero — skip

    const deltaPct = ((currentValue - priorValue) / Math.abs(priorValue)) * 100;

    // Round to 6 decimal places before threshold comparison to avoid
    // floating-point noise (e.g. -9.999999999999998 being treated as < -10).
    const deltaPctRounded = Math.round(deltaPct * 1e6) / 1e6;

    // Worsening amount is always non-negative; compare against threshold.
    const worseningPct =
      currentEntry.polarity === 'higher-is-better'
        ? -deltaPctRounded   // decrease is bad for this polarity
        : deltaPctRounded;   // increase is bad for this polarity

    if (worseningPct >= opts.thresholdPct) {
      findings.push({ kpi: kpiName, priorValue, currentValue, deltaPct, vector });
    }
  }

  return findings;
};
