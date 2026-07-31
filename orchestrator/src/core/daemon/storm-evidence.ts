/**
 * Evidence lookup for the signature-storm Steward brief.
 *
 * When the all-gate circuit breaker trips, dispatch is PAUSED and a
 * write-capable Steward is woken with a brief that must carry the actual
 * failure output of the tasks that stormed. A Steward with no evidence cannot
 * fix the storm — it burns a dispatch from its per-signature budget and the
 * breaker escalates — so this lookup is load-bearing, not decorative.
 *
 * It lived inline in `daemon/server.ts` and matched rows with
 * `failure_signature = $sig OR failure_reason_code = $sig`. That exact equality
 * was the bug: the streak counter trips on whichever step granularity the
 * failing call site produced, while the COLUMN holds whichever granularity the
 * primitive stamped. Live trip on `code/uncommitted-changes` matched exactly
 * one of five rows — the one row whose `error` was status padding — so the
 * daemon logged "no usable failure output" while ~2.2 KB of real output sat in
 * the other four rows under `code:commit-contract/uncommitted-changes`.
 *
 * The join now matches on the FAMILY of the signature
 * ({@link failureSignatureFamily}), which is the same rule the streak counter
 * uses to decide two failures are the same — one helper, two call sites, so
 * the two cannot drift apart again.
 */

import type { DbResultSet, DbStatement } from '../lib/db.js'
import { assessStormExcerpt } from '../agents/steward.js'
import {
  failureSignatureFamily,
  failureSignatureFamilySql,
} from '../lib/failure-signature.js'

/** Minimal read seam; satisfied structurally by a `DbClient` and a task store. */
export interface StormEvidenceDb {
  execute(stmt: DbStatement): Promise<DbResultSet>
}

/** One task's contribution to the brief. Mirrors `StormFailureExcerptSchema`. */
export interface StormFailureExcerptRow {
  taskId: string
  signature: string
  excerpt: string
  usable: boolean
}

export interface StormEvidence {
  affectedTaskIds: string[]
  failureExcerpts: StormFailureExcerptRow[]
  /** How many excerpts carry real captured output rather than status padding. */
  usableEvidenceCount: number
}

/** Rows the brief quotes. Small on purpose — the Steward's prompt stays short. */
export const STORM_EVIDENCE_ROW_LIMIT = 5

/** Tail of `error` handed to the excerpt assessor. */
const ERROR_TAIL_CHARS = 2_000

/**
 * Gather the tasks that failed with this signature, best evidence first.
 *
 * Row selection:
 *  - FAMILY match on either `failure_signature` or `failure_reason_code`, so a
 *    trip on the coarse form still finds the step-qualified rows (and vice
 *    versa). Widening is bounded to "same gate, same error class".
 *  - Rows with no captured `error` are EXCLUDED. An in-flight sibling (the task
 *    that is still running when the breaker trips) has `error IS NULL`; it
 *    cannot contribute a single diagnostic byte, and including it spends one of
 *    the {@link STORM_EVIDENCE_ROW_LIMIT} slots that a row with real output
 *    needs. It is still named in the brief when it is the `lastTaskId`.
 *
 * Ordering puts EXACT signature matches ahead of the merely same-family ones,
 * so precision is never traded away — the family match only fills slots the
 * exact match left empty.
 */
export const collectStormEvidence = async (args: {
  db: StormEvidenceDb
  signature: string
  lastTaskId: string
  log?: (message: string) => void
}): Promise<StormEvidence> => {
  const { db, signature, lastTaskId, log } = args
  const family = failureSignatureFamily(signature)
  const affectedTaskIds: string[] = []
  const failureExcerpts: StormFailureExcerptRow[] = []
  let usableEvidenceCount = 0

  try {
    const rows = await db.execute({
      sql: `SELECT id, failure_signature, failure_reason, error
              FROM tasks
             WHERE error IS NOT NULL
               AND error <> ''
               AND (${failureSignatureFamilySql('failure_signature')} = ?
                 OR ${failureSignatureFamilySql('failure_reason_code')} = ?)
             ORDER BY (COALESCE(failure_signature, '') = ?
                    OR COALESCE(failure_reason_code, '') = ?) DESC,
                      updated_at DESC
             LIMIT ${STORM_EVIDENCE_ROW_LIMIT}`,
      args: [family, family, signature, signature],
    })
    for (const raw of rows.rows) {
      const row = raw as unknown as {
        id: string
        failure_signature: string | null
        failure_reason: string | null
        error: string | null
      }
      affectedTaskIds.push(row.id)
      // Guard the brief: `error` is not always captured output. A sweep that
      // re-drives already-failed tasks can overwrite it with a repeated
      // `recovery_failed:<sig>:` chain, and the tail of that is pure padding.
      // Attach the assessment's verdict instead of pretending.
      const assessment = assessStormExcerpt(row.error?.slice(-ERROR_TAIL_CHARS))
      if (assessment.usable) usableEvidenceCount += 1
      failureExcerpts.push({
        taskId: row.id,
        signature: row.failure_signature ?? row.failure_reason ?? signature,
        excerpt: assessment.excerpt,
        usable: assessment.usable,
      })
    }
  } catch (err) {
    log?.(
      `[signature-storm] failure-context lookup failed (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }

  if (!affectedTaskIds.includes(lastTaskId)) affectedTaskIds.unshift(lastTaskId)
  if (failureExcerpts.length > 0 && usableEvidenceCount === 0) {
    log?.(
      `[signature-storm] no usable failure output for "${signature}" — the Steward brief will say so explicitly`,
    )
  }
  return { affectedTaskIds, failureExcerpts, usableEvidenceCount }
}
