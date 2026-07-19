/**
 * Benchmark harness for tool-promotion attempts.
 *
 * Takes a ledger attempt id, replays each motivating arc twice — once in
 * 'baseline' mode (helper absent from PATH) and once in 'treatment' mode
 * (helper present on PATH) — aggregates the per-arc metrics, and persists
 * the results into the `benchmark_before` / `benchmark_after` columns of
 * `tool_promotion_attempts`.
 *
 * The `arcReplayer` is injectable so callers can stub it in tests. The CLI
 * bench subcommand supplies a real replayer; tests use a closure stub.
 *
 * Idempotent: if the attempt is already `'benchmarked'`, the existing data
 * is returned without touching the database again.
 */

import type { Client } from '@libsql/client'
import {
  getAttempt,
  updateAttemptStatus,
} from '../store/tool-promotion-store'

// ── Public types ──────────────────────────────────────────────────────────────

/** Metrics captured from a single arc run. */
export interface ArcRunResult {
  tokensIn: number
  tokensOut: number
  wallMs: number
  exitOk: boolean
}

/**
 * Injectable arc-replayer function.
 * Replays a single motivating arc in the given mode and returns its metrics.
 */
export type ArcReplayer = (
  arcId: string,
  mode: 'baseline' | 'treatment',
) => Promise<ArcRunResult>

export interface BenchmarkOptions {
  arcReplayer: ArcReplayer
}

/** Return value of `runBenchmark`: the two JSON blobs that were persisted. */
export interface BenchmarkResult {
  /** JSON-serialized baseline (helper absent) data. */
  before: string
  /** JSON-serialized treatment (helper present) data. */
  after: string
}

// ── Internal shape stored in the DB columns ───────────────────────────────────

interface ArcBenchmark extends ArcRunResult {
  arcId: string
}

// ── Core function ─────────────────────────────────────────────────────────────

/**
 * Run the benchmark for `attemptId` and persist the results.
 *
 * @throws if no attempt with `attemptId` exists in the database.
 *
 * Idempotent: calling this a second time on an already-benchmarked row
 * returns the existing data without issuing another UPDATE.
 */
export async function runBenchmark(
  db: Client,
  attemptId: string,
  opts: BenchmarkOptions,
): Promise<BenchmarkResult> {
  const attempt = await getAttempt(db, attemptId)
  if (!attempt) {
    throw new Error(`tool-benchmark: attempt not found: ${attemptId}`)
  }

  // Idempotent guard — return persisted data, no double-write.
  if (attempt.status === 'benchmarked') {
    return {
      before: attempt.benchmarkBefore!,
      after: attempt.benchmarkAfter!,
    }
  }

  const baselineArcs: ArcBenchmark[] = []
  const treatmentArcs: ArcBenchmark[] = []

  for (const arcId of attempt.motivatingArcIds) {
    const baselineRun = await opts.arcReplayer(arcId, 'baseline')
    baselineArcs.push({ arcId, ...baselineRun })

    const treatmentRun = await opts.arcReplayer(arcId, 'treatment')
    treatmentArcs.push({ arcId, ...treatmentRun })
  }

  const benchmarkBefore = JSON.stringify(baselineArcs)
  const benchmarkAfter = JSON.stringify(treatmentArcs)

  await updateAttemptStatus(db, attemptId, 'benchmarked', {
    benchmarkBefore,
    benchmarkAfter,
    // decidedAt is intentionally not set — the decided_at column is reserved
    // for the promote/retire verdict step, not the benchmark step.
  })

  return { before: benchmarkBefore, after: benchmarkAfter }
}
