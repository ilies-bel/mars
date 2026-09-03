import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
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

// ---------------------------------------------------------------------------
// 6. runSelfEvolveTrigger — proposal dedup (integration)
//
// These tests verify that the KPI drift raiser is idempotent per
// (metric, comparison window).  Each test gets a fresh git repo + in-memory
// PGlite state so module-level singletons are isolated between tests.
//
// Store seam: everything DB-related is imported inside loadTriggerContext
// (after vi.resetModules) so the test shares openDb's client registry with
// the module under test — the same pattern used by
// reflect-recommended-detector.test.ts.
// ---------------------------------------------------------------------------

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-kpi-dedup-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

interface TriggerContext {
  runSelfEvolveTrigger: typeof import('../self-evolve-trigger.js')['runSelfEvolveTrigger']
  store: import('../../store/task-store.js').DomainTaskStore
  countDraftProposalsForKpi: (kpi: string) => Promise<number>
  getProposalFingerprint: (id: string) => Promise<string | null>
}

const loadTriggerContext = async (repo: string): Promise<TriggerContext> => {
  vi.resetModules()
  process.env.MARS_REPO = repo

  const { resolveStateClient } = await import('../../store/state-client.js')
  const { createTaskStore } = await import('../../store/task-store.js')
  const store = createTaskStore(resolveStateClient())
  const { runSelfEvolveTrigger } = await import('../self-evolve-trigger.js')

  const countDraftProposalsForKpi = async (kpi: string): Promise<number> => {
    const r = await store.query({
      sql: `SELECT COUNT(*) AS n FROM proposals
             WHERE source = 'reflection' AND status = 'draft' AND kpi_tag = ?`,
      args: [kpi],
    })
    const row = r.rows[0] as unknown as { n: number | bigint }
    return typeof row.n === 'bigint' ? Number(row.n) : row.n
  }

  const getProposalFingerprint = async (id: string): Promise<string | null> => {
    const r = await store.query({
      sql: `SELECT fingerprint FROM proposals WHERE id = ?`,
      args: [id],
    })
    if (r.rows.length === 0) return null
    const row = r.rows[0] as unknown as { fingerprint: string | null }
    return row.fingerprint
  }

  return { runSelfEvolveTrigger, store, countDraftProposalsForKpi, getProposalFingerprint }
}

const insertKpiSnapshot = async (
  store: import('../../store/task-store.js').DomainTaskStore,
  id: string,
  takenAt: string,
  failureRate: number,
): Promise<void> => {
  await store.execute({
    sql: `INSERT INTO kpi_snapshots
            (id, taken_at, window_start, window_end,
             cost_per_arc_sample_count, cost_per_arc_low_confidence,
             failure_rate_sample_count, failure_rate_low_confidence,
             autonomous_completion_rate_sample_count, autonomous_completion_rate_low_confidence,
             recovery_success_rate_sample_count, recovery_success_rate_low_confidence,
             cost_per_arc_p50, cost_per_arc_p90,
             failure_rate, autonomous_completion_rate, recovery_success_rate)
          VALUES (?, ?, ?, ?, 0, 1, ?, 0, 0, 1, 0, 1, NULL, NULL, ?, NULL, NULL)`,
    args: [id, takenAt, takenAt, takenAt, 10, failureRate],
  })
}

describe('runSelfEvolveTrigger — proposal dedup', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('sets a non-null fingerprint on the raised KPI drift proposal', async () => {
    const ctx = await loadTriggerContext(repo)

    // prior: failure_rate=0.10, current: 0.25 → +150 % (well above default 10 % threshold)
    await insertKpiSnapshot(ctx.store, 'snap-prior', '2026-01-01T00:00:00Z', 0.10)
    await insertKpiSnapshot(ctx.store, 'snap-current', '2026-01-02T00:00:00Z', 0.25)

    const result = await ctx.runSelfEvolveTrigger({ store: ctx.store })
    expect(result.raised).toHaveLength(1)

    const fingerprint = await ctx.getProposalFingerprint(result.raised[0]!)
    // A fingerprint MUST be set so the ON CONFLICT (source, fingerprint) clause
    // in createProposal can atomically deduplicate concurrent raises.
    expect(fingerprint).not.toBeNull()
    expect(fingerprint).toMatch(/^kpi-drift:failure_rate:snap-current:snap-prior$/)
  })

  it('raising the same metric drift twice in one window yields exactly one proposal', async () => {
    const ctx = await loadTriggerContext(repo)

    // prior: failure_rate=0.10, current: 0.25 → regression
    await insertKpiSnapshot(ctx.store, 'snap-prior', '2026-01-01T00:00:00Z', 0.10)
    await insertKpiSnapshot(ctx.store, 'snap-current', '2026-01-02T00:00:00Z', 0.25)

    // First raise
    const first = await ctx.runSelfEvolveTrigger({ store: ctx.store })
    expect(first.raised).toHaveLength(1)
    expect(await ctx.countDraftProposalsForKpi('failure_rate')).toBe(1)

    // Second raise with identical snapshots — must not create a second proposal.
    // On current code (no fingerprint) a concurrent sweep would produce a
    // second row; with the fingerprint the ON CONFLICT folds them into one.
    const second = await ctx.runSelfEvolveTrigger({ store: ctx.store })
    // The sequential dedup (findOpenReflectionDraftForKpi) catches this case;
    // the fingerprint is the backstop for the concurrent case.
    expect(second.skipped).toContainEqual({ kpi: 'failure_rate', reason: 'duplicate' })

    // Either way: exactly one draft proposal in the DB.
    expect(await ctx.countDraftProposalsForKpi('failure_rate')).toBe(1)
  })
});
