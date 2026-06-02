import { describe, it, expect } from 'vitest';
import { detectKpiDrift, type KpiSnapshot } from '../kpi-drift.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const confident = (metrics: KpiSnapshot['metrics']): KpiSnapshot => ({
  isConfident: true,
  metrics,
});

const lowConfidence = (metrics: KpiSnapshot['metrics']): KpiSnapshot => ({
  isConfident: false,
  metrics,
});

const successRate = (value: number) => ({
  value,
  polarity: 'higher-is-better' as const,
});

const latency = (value: number) => ({
  value,
  polarity: 'lower-is-better' as const,
});

// ---------------------------------------------------------------------------
// 1. Sample-floor confidence gate
// ---------------------------------------------------------------------------

describe('detectKpiDrift — confidence gate', () => {
  it('returns [] when current snapshot is low-confidence', () => {
    const prior = confident({ successRate: successRate(0.9) });
    const current = lowConfidence({ successRate: successRate(0.7) });

    expect(detectKpiDrift(current, prior, { thresholdPct: 5 })).toEqual([]);
  });

  it('returns [] when prior snapshot is low-confidence', () => {
    const prior = lowConfidence({ successRate: successRate(0.9) });
    const current = confident({ successRate: successRate(0.7) });

    expect(detectKpiDrift(current, prior, { thresholdPct: 5 })).toEqual([]);
  });

  it('returns [] when BOTH snapshots are low-confidence', () => {
    const prior = lowConfidence({ successRate: successRate(0.9) });
    const current = lowConfidence({ successRate: successRate(0.7) });

    expect(detectKpiDrift(current, prior, { thresholdPct: 5 })).toEqual([]);
  });

  it('proceeds normally when both snapshots are confident', () => {
    const prior = confident({ successRate: successRate(0.9) });
    // No regression → still returns [] but for the right reason (threshold)
    const current = confident({ successRate: successRate(0.9) });

    expect(detectKpiDrift(current, prior, { thresholdPct: 5 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Threshold boundary — higher-is-better KPI (success-rate)
// ---------------------------------------------------------------------------

describe('detectKpiDrift — threshold boundary (higher-is-better)', () => {
  // Prior value 1.0; thresholdPct = 10 → a drop to ≤ 0.9 surfaces a finding.

  it('does NOT report a regression just below the threshold', () => {
    // deltaPct = -9.9 % → worseningPct 9.9 < 10
    const prior = confident({ sr: successRate(1.0) });
    const current = confident({ sr: successRate(0.901) });

    const findings = detectKpiDrift(current, prior, { thresholdPct: 10 });
    expect(findings).toEqual([]);
  });

  it('reports a regression exactly at the threshold', () => {
    // deltaPct = -10 % → worseningPct 10 >= 10
    const prior = confident({ sr: successRate(1.0) });
    const current = confident({ sr: successRate(0.9) });

    const findings = detectKpiDrift(current, prior, { thresholdPct: 10 });
    expect(findings).toHaveLength(1);
    expect(findings[0].kpi).toBe('sr');
    expect(findings[0].priorValue).toBe(1.0);
    expect(findings[0].currentValue).toBe(0.9);
    expect(findings[0].deltaPct).toBeCloseTo(-10, 5);
  });

  it('reports a regression above the threshold', () => {
    // deltaPct ≈ -22 % → worseningPct 22 > 10
    const prior = confident({ sr: successRate(1.0) });
    const current = confident({ sr: successRate(0.78) });

    const findings = detectKpiDrift(current, prior, { thresholdPct: 10 });
    expect(findings).toHaveLength(1);
    expect(findings[0].kpi).toBe('sr');
  });

  it('does NOT report an improvement for a higher-is-better KPI', () => {
    const prior = confident({ sr: successRate(0.8) });
    const current = confident({ sr: successRate(0.95) });

    expect(detectKpiDrift(current, prior, { thresholdPct: 5 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Polarity flip — lower-is-better KPI (latency)
// ---------------------------------------------------------------------------

describe('detectKpiDrift — threshold boundary (lower-is-better)', () => {
  // Prior value 100 ms; thresholdPct = 10 → an increase to ≥ 110 ms surfaces.

  it('does NOT report a regression just below the threshold', () => {
    // deltaPct ≈ +9.9 % → worseningPct 9.9 < 10
    const prior = confident({ p99: latency(100) });
    const current = confident({ p99: latency(109.9) });

    expect(detectKpiDrift(current, prior, { thresholdPct: 10 })).toEqual([]);
  });

  it('reports a regression exactly at the threshold', () => {
    // deltaPct = +10 % → worseningPct 10 >= 10
    const prior = confident({ p99: latency(100) });
    const current = confident({ p99: latency(110) });

    const findings = detectKpiDrift(current, prior, { thresholdPct: 10 });
    expect(findings).toHaveLength(1);
    expect(findings[0].kpi).toBe('p99');
    expect(findings[0].deltaPct).toBeCloseTo(10, 5);
  });

  it('reports a regression above the threshold', () => {
    const prior = confident({ p99: latency(100) });
    const current = confident({ p99: latency(150) });

    const findings = detectKpiDrift(current, prior, { thresholdPct: 10 });
    expect(findings).toHaveLength(1);
    expect(findings[0].deltaPct).toBeCloseTo(50, 5);
  });

  it('does NOT report an improvement for a lower-is-better KPI', () => {
    const prior = confident({ p99: latency(200) });
    const current = confident({ p99: latency(150) });

    expect(detectKpiDrift(current, prior, { thresholdPct: 5 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Multi-KPI snapshot — multiple findings
// ---------------------------------------------------------------------------

describe('detectKpiDrift — multi-KPI snapshots', () => {
  it('returns one finding per regressed KPI', () => {
    const prior = confident({
      successRate: successRate(0.95),
      p99: latency(100),
      throughput: successRate(1000), // higher-is-better
    });
    const current = confident({
      successRate: successRate(0.80), // regressed ~15.8%
      p99: latency(120),              // regressed 20%
      throughput: successRate(1000),  // unchanged
    });

    const findings = detectKpiDrift(current, prior, { thresholdPct: 10 });
    expect(findings).toHaveLength(2);

    const kpis = findings.map((f) => f.kpi).sort();
    expect(kpis).toEqual(['p99', 'successRate']);
  });

  it('returns [] when all KPIs are within threshold despite changes', () => {
    const prior = confident({
      successRate: successRate(0.95),
      p99: latency(100),
    });
    const current = confident({
      successRate: successRate(0.945), // ~0.5% drop — below threshold
      p99: latency(105),               // 5% rise — below threshold
    });

    expect(detectKpiDrift(current, prior, { thresholdPct: 10 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Vector — cross-KPI context
// ---------------------------------------------------------------------------

describe('detectKpiDrift — vector payload', () => {
  it('attaches the full cross-KPI vector to every finding', () => {
    const prior = confident({
      successRate: successRate(0.9),
      p99: latency(100),
    });
    const current = confident({
      successRate: successRate(0.75), // regressed 16.7%
      p99: latency(110),              // regressed 10%
    });

    const findings = detectKpiDrift(current, prior, { thresholdPct: 10 });
    expect(findings.length).toBeGreaterThanOrEqual(1);

    for (const finding of findings) {
      // Both KPIs must appear in the vector regardless of which one regressed.
      expect(finding.vector).toMatchObject({
        successRate: { prior: 0.9, current: 0.75 },
        p99: { prior: 100, current: 110 },
      });
    }
  });

  it('vector excludes KPIs absent from the prior snapshot', () => {
    const prior = confident({
      successRate: successRate(0.9),
    });
    const current = confident({
      successRate: successRate(0.75),
      newMetric: successRate(0.5), // no counterpart in prior
    });

    const findings = detectKpiDrift(current, prior, { thresholdPct: 10 });
    expect(findings).toHaveLength(1);
    expect(Object.keys(findings[0].vector)).not.toContain('newMetric');
    expect(findings[0].vector.successRate).toBeDefined();
  });
});
