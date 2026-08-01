import { isAbsolute, relative } from 'node:path'
import type { MonitorDb } from './gate-meta-monitor'
import { recordGateParse, getGateBurnInStatus } from './gate-burn-in'
import type { VerifyScope, VerifyStep, VerifyStepSpec } from './git/verify'
import {
  lookupFailureKind,
  failingStepFromSignature,
  type EncodableFamily,
  type NonEncodableReason,
  type StaticEncodability,
} from './failure-kinds'
import { raiseActionQueueItem } from './action-queue'
import type { RanVerifyStep } from './derive-repro-command'

/**
 * Gate-enrichment registry (PRD 745f33e0): the static verify gate
 * self-enriches — every ENCODABLE failure signature becomes a HUMAN-APPROVED,
 * signature-keyed static check that SHADOW-RUNS before enforcing.
 *
 * Pipeline: failure signature → agent-drafted candidate check → human
 * approval → shadow burn-in → enforcing.
 *
 * WHY the human gate and the burn-in are non-negotiable: the
 * completeness-gate incident (gate d9237119, 2026-07-03T08:15Z) shipped a
 * check that read transcripts headless sessions no longer wrote. It failed
 * CLOSED with the identical verdict for 100% of tasks from its first live
 * minute, and — because verify gates run from daemon code — it blocked its
 * OWN fix from merging (a circular wedge, resolved only by an operator
 * direct-main patch). Self-enrichment without a human approval gate and a
 * shadow burn-in period would industrialise that failure mode; ADR-0002's
 * 2026-05-10 cascade lesson (uncurated auto-escalation fans out
 * exponentially) applies identically to gate content. A candidate check
 * therefore NEVER enters the enforced gate autonomously.
 *
 * Storage: a Mars-owned, signature-keyed table (`gate_enrichment`) in the
 * same DB as `gate_burn_in` / `gate_verdict_monitor` — NOT the user's verify
 * recipe file (no recipe schema change, honouring ADR-0003/ADR-0018). At
 * verify time, shadow+enforcing entries are merged into the scope list AFTER
 * `loadVerifyScopes` and flow through UNCHANGED ADR-0018 selection (path
 * containment + always-on root floor) and unchanged `verifyChanges`
 * execution.
 *
 * Idempotency: the signature IS the primary key. A repeat failure whose
 * signature is already claimed — in ANY status — bumps `seen_count` on the
 * existing record (level-triggered) and never creates a sibling candidate or
 * a duplicate step.
 *
 * Burn-in: a newly-approved check enters shadow mode via the EXISTING
 * gate-burn-in machinery (gate-burn-in.ts), generalised from one hardcoded
 * gate name to per-check `gate_burn_in` rows keyed `enrich:<signature>`.
 * Shadow verdicts never fail verify; auto-promotion to enforcing requires
 * {@link import('./gate-burn-in').SHADOW_BURN_IN_COUNT} clean parses. The
 * existing gate-meta-monitor covers enforcing enriched checks for free,
 * since it keys on `verify:<gate>/<class>` signatures generically.
 */

/** Name prefix for every enrichment-registry verify step. */
export const ENRICH_STEP_PREFIX = 'enrich:'

/**
 * Number of consecutive clean verify-run passes on an ENFORCING enrichment
 * check that triggers the gate-enrichment-stale action-queue row.
 *
 * "Consecutive" means any verify run where the enforcing check FAILS
 * (the failure pattern reappears) resets the counter to zero — only
 * uninterrupted streaks count. Deliberately NOT configurable.
 */
export const ENFORCING_STALE_THRESHOLD = 20

/** Action-queue kind for the "enforcing check may be stale" row. */
export const GATE_ENRICHMENT_STALE_KIND = 'gate-enrichment-stale' as const

/** The verify-step name for an enrichment record: `enrich:<signature>`. */
export const enrichStepName = (signature: string): string =>
  `${ENRICH_STEP_PREFIX}${signature}`

/**
 * Inverse of {@link enrichStepName}: the failure signature behind an
 * enrichment step name, or `null` when the name is not an enrichment step.
 */
export const signatureFromEnrichStepName = (name: string): string | null =>
  name.startsWith(ENRICH_STEP_PREFIX)
    ? name.slice(ENRICH_STEP_PREFIX.length)
    : null

/**
 * Lifecycle of an enrichment record. A signature is claimed forever once a
 * row exists — in ANY of these statuses — so the same failure class can
 * never append the same check twice.
 *
 * - `candidate`     — observed and classified encodable; a Writer-tagged task
 *                     drafts the check; awaiting human approval. NOT run.
 * - `shadow`        — human-approved; runs on every selected verify but can
 *                     never fail it. Clean parses advance the burn-in counter.
 * - `enforcing`     — burn-in complete; runs as a required verify step.
 * - `retired`       — operator judged the check wrong or obsolete. Never run,
 *                     never regenerated (the claim stays). Re-openable only by
 *                     the explicit operator verb, never automatically.
 * - `non-encodable` — observed but explicitly NOT statically encodable
 *                     (semantic / environmental / orchestration /
 *                     prompt-misread / unclassified). Produces NO check;
 *                     recorded so the coverage gap is enumerable, not silent.
 */
export type EnrichmentStatus =
  | 'candidate'
  | 'shadow'
  | 'enforcing'
  | 'retired'
  | 'non-encodable'

/** One row of the enrichment registry. */
export interface EnrichmentRecord {
  /** The `<failingStep>/<error-class>` failure signature — the PRIMARY KEY. */
  signature: string
  status: EnrichmentStatus
  /** The check family when encodable; `null` on non-encodable rows. */
  encodableFamily: EncodableFamily | null
  /** The explicit reason when non-encodable; `null` on encodable rows. */
  nonEncodableReason: NonEncodableReason | null
  /**
   * The VerifyStepSpec-shaped check. `null` on non-encodable rows and on
   * candidates whose draft has not been landed yet (the Writer lands it via
   * `mars enrich draft`). Approval requires a non-null spec.
   */
  stepSpec: VerifyStepSpec | null
  /** The task whose failure first claimed this signature. */
  originTaskId: string
  /** How many failures carrying this signature have been observed. */
  seenCount: number
  createdAt: number
  updatedAt: number
  approvedBy: string | null
  approvedAt: number | null
  retiredAt: number | null
}

/**
 * The `gate_enrichment` registry table is owned by the canonical schema
 * (pg-schema.ts `ensureSchema`, applied at daemon/init start). This function
 * is retained as the historical call-site seam and is now a no-op.
 */
export const ensureGateEnrichmentSchema = async (
  _client: MonitorDb,
): Promise<void> => {
  // Schema is guaranteed by pg-schema.ts ensureSchema at startup.
}

/**
 * Historical test hook for the removed in-process "schema ensured" latch.
 * No-op since the canonical schema owns the table.
 */
export const resetGateEnrichmentSchemaLatchForTests = (): void => {
  // No latch remains; schema ownership moved to pg-schema.ts.
}

interface EnrichmentRow {
  signature: string
  status: string
  encodable_family: string | null
  non_encodable_reason: string | null
  step_spec: string | null
  origin_task_id: string
  seen_count: number
  created_at: number
  updated_at: number
  approved_by: string | null
  approved_at: number | null
  retired_at: number | null
}

const parseStepSpec = (raw: string | null): VerifyStepSpec | null => {
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const o = parsed as Record<string, unknown>
    if (typeof o.cmd !== 'string' || o.cmd.length === 0) return null
    const args = Array.isArray(o.args)
      ? o.args.filter((a): a is string => typeof a === 'string')
      : []
    return {
      name: typeof o.name === 'string' ? o.name : '',
      cmd: o.cmd,
      args,
      required: o.required !== false,
      dir: typeof o.dir === 'string' && o.dir.length > 0 ? o.dir : '.',
      tier: 'task',
    }
  } catch {
    return null
  }
}

const rowToRecord = (row: EnrichmentRow): EnrichmentRecord => ({
  signature: row.signature,
  status: row.status as EnrichmentStatus,
  encodableFamily: row.encodable_family as EncodableFamily | null,
  nonEncodableReason: row.non_encodable_reason as NonEncodableReason | null,
  stepSpec: parseStepSpec(row.step_spec),
  originTaskId: row.origin_task_id,
  seenCount: row.seen_count,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  approvedBy: row.approved_by,
  approvedAt: row.approved_at,
  retiredAt: row.retired_at,
})

/** Read one enrichment record by signature, or `null` when unclaimed. */
export const getEnrichment = async (
  client: MonitorDb,
  signature: string,
): Promise<EnrichmentRecord | null> => {
  await ensureGateEnrichmentSchema(client)
  const r = await client.execute({
    sql: `SELECT * FROM gate_enrichment WHERE signature = ?`,
    args: [signature],
  })
  if (r.rows.length === 0) return null
  return rowToRecord(r.rows[0] as unknown as EnrichmentRow)
}

/** An {@link EnrichmentRecord} plus its live burn-in progress. */
export interface EnrichmentListEntry extends EnrichmentRecord {
  /** Clean parses recorded so far (shadow rows only advance this). */
  burnInParseCount: number
}

/**
 * List the whole registry with burn-in progress — the maintainer surface
 * (PRD user story 6): signature, status, origin task, seen_count, burn-in
 * progress, plus every signature marked non-encodable so the gate's
 * monotonic-coverage boundary is enumerable instead of silent.
 */
export const listEnrichments = async (
  client: MonitorDb,
): Promise<EnrichmentListEntry[]> => {
  await ensureGateEnrichmentSchema(client)
  const r = await client.execute({
    sql: `SELECT * FROM gate_enrichment ORDER BY created_at ASC`,
    args: [],
  })
  const out: EnrichmentListEntry[] = []
  for (const raw of r.rows) {
    const rec = rowToRecord(raw as unknown as EnrichmentRow)
    const burnIn = await getGateBurnInStatus(
      client,
      enrichStepName(rec.signature),
    ).catch(() => ({ inShadow: true, parseCount: 0 }))
    out.push({ ...rec, burnInParseCount: burnIn.parseCount })
  }
  return out
}

// ---------------------------------------------------------------------------
// Encodability classification
// ---------------------------------------------------------------------------

/**
 * Classify a failure signature's static encodability.
 *
 * The authoritative source is the {@link import('./failure-kinds').FailureKind}
 * record's `staticEncodable` facet (ADR-0042: one signature-keyed record).
 * Signatures with no registered FailureKind fall back to step-family rules so
 * the classification is total — never silent:
 *
 * - `verify:enrich:*`      — an enriched check failing is covered by the
 *                            gate-meta-monitor; enriching the enricher would
 *                            recurse. Non-encodable (orchestration).
 * - `verify:typecheck|test|lint|build/*` — command-reproducible (family (a)).
 * - `setup:* / merge:*`    — orchestration-step failures: recovery-recipe
 *                            territory (ADR-0002).
 * - `code:*`               — agent-run failures (timeouts, budget,
 *                            misreads); not a worktree predicate.
 * - anything else          — explicitly `unclassified`, recorded as a
 *                            non-encodable row so the gap stays visible.
 */
export const classifyEncodability = (signature: string): StaticEncodability => {
  const kind = lookupFailureKind(signature)
  if (kind) return kind.staticEncodable

  const step = failingStepFromSignature(signature)
  if (step.startsWith(`verify:${ENRICH_STEP_PREFIX}`)) {
    return { encodable: false, reason: 'orchestration' }
  }
  if (
    step === 'verify:typecheck' ||
    step === 'verify:test' ||
    step === 'verify:lint' ||
    step === 'verify:build'
  ) {
    return { encodable: true, family: 'command' }
  }
  if (step.startsWith('setup:') || step.startsWith('merge:')) {
    return { encodable: false, reason: 'orchestration' }
  }
  if (step.startsWith('code:')) {
    return { encodable: false, reason: 'prompt-misread' }
  }
  return { encodable: false, reason: 'unclassified' }
}

// ---------------------------------------------------------------------------
// Observation (the failure-chokepoint write path)
// ---------------------------------------------------------------------------

export interface ObserveFailureSignatureInput {
  /** The `<failingStep>/<error-class>` failure signature. */
  signature: string
  /** The failing task whose failure produced this observation. */
  originTaskId: string
  /**
   * Optional mechanically-derived draft check (family (a): the failing
   * command re-run as a scoped step). Stored on a NEW candidate row only;
   * ignored when the signature is already claimed or non-encodable.
   */
  draftStep?: VerifyStepSpec | null
}

export type ObserveFailureSignatureOutcome =
  /** First observation of an encodable signature — the claim row was inserted. */
  | { kind: 'claimed-candidate'; record: EnrichmentRecord }
  /** First observation of a non-encodable signature — recorded, NO check. */
  | { kind: 'recorded-non-encodable'; record: EnrichmentRecord }
  /** Signature already claimed (any status) — seen_count bumped, nothing else. */
  | { kind: 'seen'; record: EnrichmentRecord }

/**
 * Record one failure observation against the registry. Signature-keyed
 * idempotency in one atomic statement: the INSERT claims the signature; a
 * conflict (already claimed, in ANY status) bumps `seen_count` and touches
 * `updated_at`, leaving status/spec/approval untouched. At most one
 * enrichment record per failure signature, ever.
 */
export const observeFailureSignature = async (
  client: MonitorDb,
  input: ObserveFailureSignatureInput,
): Promise<ObserveFailureSignatureOutcome> => {
  await ensureGateEnrichmentSchema(client)
  const now = Date.now()
  const encodability = classifyEncodability(input.signature)

  const status: EnrichmentStatus = encodability.encodable
    ? 'candidate'
    : 'non-encodable'
  const family = encodability.encodable ? encodability.family : null
  const reason = encodability.encodable ? null : encodability.reason
  const stepSpec =
    encodability.encodable && input.draftStep
      ? JSON.stringify({
          ...input.draftStep,
          name: enrichStepName(input.signature),
          required: true,
          tier: 'task',
        })
      : null

  await client.execute({
    sql: `INSERT INTO gate_enrichment
            (signature, status, encodable_family, non_encodable_reason,
             step_spec, origin_task_id, seen_count, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT(signature) DO UPDATE SET
            seen_count = gate_enrichment.seen_count + 1,
            updated_at = excluded.updated_at`,
    args: [
      input.signature,
      status,
      family,
      reason,
      stepSpec,
      input.originTaskId,
      now,
      now,
    ],
  })

  const record = await getEnrichment(client, input.signature)
  if (record === null) {
    throw new Error(
      `gate_enrichment row for ${input.signature} vanished after upsert`,
    )
  }
  if (record.seenCount > 1) return { kind: 'seen', record }
  return record.status === 'non-encodable'
    ? { kind: 'recorded-non-encodable', record }
    : { kind: 'claimed-candidate', record }
}

// ---------------------------------------------------------------------------
// Lifecycle verbs (operator / Writer entry points)
// ---------------------------------------------------------------------------

const setStatus = async (
  client: MonitorDb,
  signature: string,
  patch: {
    status: EnrichmentStatus
    approvedBy?: string | null
    approvedAt?: number | null
    retiredAt?: number | null
  },
): Promise<EnrichmentRecord> => {
  const now = Date.now()
  await client.execute({
    sql: `UPDATE gate_enrichment SET
            status = ?,
            approved_by = COALESCE(?, approved_by),
            approved_at = COALESCE(?, approved_at),
            retired_at = COALESCE(?, retired_at),
            updated_at = ?
          WHERE signature = ?`,
    args: [
      patch.status,
      patch.approvedBy ?? null,
      patch.approvedAt ?? null,
      patch.retiredAt ?? null,
      now,
      signature,
    ],
  })
  const record = await getEnrichment(client, signature)
  if (record === null) {
    throw new Error(`no gate_enrichment row for signature ${signature}`)
  }
  return record
}

/**
 * Land (or replace) the draft check on a CANDIDATE row — the Writer's
 * landing verb (`mars enrich draft`). Only candidates are mutable; once a
 * check is approved into shadow its spec is frozen (retire + reopen to
 * change it).
 */
export const setEnrichmentDraftStep = async (
  client: MonitorDb,
  signature: string,
  spec: { cmd: string; args?: readonly string[]; dir?: string },
): Promise<EnrichmentRecord> => {
  const existing = await getEnrichment(client, signature)
  if (existing === null) {
    throw new Error(`no gate_enrichment row for signature ${signature}`)
  }
  if (existing.status !== 'candidate') {
    throw new Error(
      `cannot draft: ${signature} is '${existing.status}', only 'candidate' rows accept a draft`,
    )
  }
  if (typeof spec.cmd !== 'string' || spec.cmd.trim().length === 0) {
    throw new Error('draft step requires a non-empty cmd')
  }
  const now = Date.now()
  const stored: VerifyStepSpec = {
    name: enrichStepName(signature),
    cmd: spec.cmd,
    args: [...(spec.args ?? [])],
    required: true,
    dir: spec.dir && spec.dir.length > 0 ? spec.dir : '.',
    tier: 'task',
  }
  await client.execute({
    sql: `UPDATE gate_enrichment SET step_spec = ?, updated_at = ? WHERE signature = ?`,
    args: [JSON.stringify(stored), now, signature],
  })
  const record = await getEnrichment(client, signature)
  if (record === null) {
    throw new Error(`gate_enrichment row for ${signature} vanished`)
  }
  return record
}

/**
 * Human approval: `candidate` → `shadow`. The ONLY transition out of
 * candidate besides retirement, and it lands in SHADOW — never directly in
 * enforcing. The completeness-gate incident (d9237119) is the reason: an
 * unproven check that enforces immediately can fail the whole fleet and
 * block its own fix. Requires a landed step spec.
 */
export const approveEnrichment = async (
  client: MonitorDb,
  signature: string,
  approvedBy: string,
): Promise<EnrichmentRecord> => {
  const existing = await getEnrichment(client, signature)
  if (existing === null) {
    throw new Error(`no gate_enrichment row for signature ${signature}`)
  }
  if (existing.status !== 'candidate') {
    throw new Error(
      `cannot approve: ${signature} is '${existing.status}', only 'candidate' rows are approvable`,
    )
  }
  if (existing.stepSpec === null) {
    throw new Error(
      `cannot approve: ${signature} has no landed draft check (use 'mars enrich draft' first)`,
    )
  }
  return setStatus(client, signature, {
    status: 'shadow',
    approvedBy,
    approvedAt: Date.now(),
  })
}

/**
 * Operator retire verb: flips a wrong or obsolete check to `retired`. The
 * signature stays claimed so no candidate is ever regenerated. Valid from
 * candidate, shadow, or enforcing.
 */
export const retireEnrichment = async (
  client: MonitorDb,
  signature: string,
): Promise<EnrichmentRecord> => {
  const existing = await getEnrichment(client, signature)
  if (existing === null) {
    throw new Error(`no gate_enrichment row for signature ${signature}`)
  }
  if (existing.status === 'retired' || existing.status === 'non-encodable') {
    throw new Error(
      `cannot retire: ${signature} is already '${existing.status}'`,
    )
  }
  return setStatus(client, signature, {
    status: 'retired',
    retiredAt: Date.now(),
  })
}

/**
 * Explicit operator re-open verb: `retired` → `candidate` so a new draft can
 * be landed and re-approved. Never automatic.
 */
export const reopenEnrichment = async (
  client: MonitorDb,
  signature: string,
): Promise<EnrichmentRecord> => {
  const existing = await getEnrichment(client, signature)
  if (existing === null) {
    throw new Error(`no gate_enrichment row for signature ${signature}`)
  }
  if (existing.status !== 'retired') {
    throw new Error(
      `cannot reopen: ${signature} is '${existing.status}', only 'retired' rows reopen`,
    )
  }
  return setStatus(client, signature, { status: 'candidate' })
}

// ---------------------------------------------------------------------------
// Verify-time merge + shadow burn-in accounting
// ---------------------------------------------------------------------------

/**
 * Load the runnable enrichment entries (shadow + enforcing, spec landed) as
 * {@link VerifyScope}s. Shadow steps carry `required: false` so a shadow
 * verdict can NEVER fail verify (`verifyChanges` only fails on required
 * steps); enforcing steps carry `required: true`. Names are normalised to
 * `enrich:<signature>` and tier forced to `'task'`.
 */
export const loadEnrichmentScopes = async (
  client: MonitorDb,
): Promise<VerifyScope[]> => {
  await ensureGateEnrichmentSchema(client)
  const r = await client.execute({
    sql: `SELECT * FROM gate_enrichment
           WHERE status IN ('shadow', 'enforcing') AND step_spec IS NOT NULL
           ORDER BY created_at ASC`,
    args: [],
  })
  const byScope = new Map<string, VerifyStepSpec[]>()
  const order: string[] = []
  for (const raw of r.rows) {
    const rec = rowToRecord(raw as unknown as EnrichmentRow)
    if (rec.stepSpec === null) continue
    const scope = rec.stepSpec.dir ?? '.'
    const step: VerifyStepSpec = {
      ...rec.stepSpec,
      name: enrichStepName(rec.signature),
      required: rec.status === 'enforcing',
      dir: scope,
      tier: 'task',
    }
    let steps = byScope.get(scope)
    if (!steps) {
      steps = []
      byScope.set(scope, steps)
      order.push(scope)
    }
    steps.push(step)
  }
  return order.map((scope) => ({ scope, steps: byScope.get(scope)! }))
}

/**
 * Merge the enrichment scopes into the recipe scopes — the seam sits BEHIND
 * `loadVerifyScopes` so the merged list flows through full-workspace selection
 * and unchanged `verifyChanges` execution, and survives the pending ADR-0003
 * manifest.json→verify.json migration.
 *
 * Never throws: any registry failure yields the recipe scopes untouched —
 * an enrichment DB hiccup must never break the real verify path.
 *
 * Second belt on idempotency: an enrichment step whose name collides with a
 * same-scope recipe step is skipped (mirrors `loadVerifyScopes`' own
 * dedupe-by-name-within-scope).
 */
export const appendEnrichmentScopes = async (
  client: MonitorDb,
  recipeScopes: ReadonlyArray<VerifyScope>,
): Promise<VerifyScope[]> => {
  try {
    const enrichmentScopes = await loadEnrichmentScopes(client)
    if (enrichmentScopes.length === 0) return [...recipeScopes]
    const recipeNamesByScope = new Map<string, Set<string>>()
    for (const sc of recipeScopes) {
      recipeNamesByScope.set(sc.scope, new Set(sc.steps.map((s) => s.name)))
    }
    const merged: VerifyScope[] = [...recipeScopes]
    for (const sc of enrichmentScopes) {
      const taken = recipeNamesByScope.get(sc.scope)
      const steps = taken
        ? sc.steps.filter((s) => !taken.has(s.name))
        : sc.steps
      if (steps.length > 0) merged.push({ scope: sc.scope, steps })
    }
    return merged
  } catch {
    return [...recipeScopes]
  }
}

/**
 * Side-effect seam for {@link recordEnrichmentShadowRuns}: injectable so
 * tests can assert the stale-row raise happened without a live action queue.
 */
export interface ShadowRunEffects {
  /**
   * Raise the `gate-enrichment-stale` action-queue row. Called at most once
   * per signature per consecutive-pass window (level-triggered, idempotent).
   *
   * @param signature - the enrichment record's signature
   * @param passCount - the consecutive-clean-pass count that tripped the threshold
   */
  raiseStaleRow: (signature: string, passCount: number) => Promise<void>
}

/**
 * Default (production) stale-row raiser — calls `raiseActionQueueItem`
 * directly. Wrapped in a best-effort try-catch inside `recordEnrichmentShadowRuns`
 * so a DB hiccup raising the row never breaks the verify path.
 */
const defaultRaiseStaleRow = async (
  signature: string,
  passCount: number,
): Promise<void> => {
  await raiseActionQueueItem({
    kind: GATE_ENRICHMENT_STALE_KIND,
    category: 'orchestrator',
    priority: 'low',
    title: `Enforcing check enrich:${signature} may be stale — ${passCount} consecutive clean verify runs`,
    body: [
      `The enforcing enrichment check \`enrich:${signature}\` has run on ${passCount} consecutive ` +
        `verify passes without the original failure pattern appearing in any task.`,
      `This may mean the regression it was encoding has been permanently resolved.`,
      '',
      'No automatic action has been taken. Operator options:',
      `- Retire the check: \`mars enrich retire '${signature}'\` (if the regression is resolved).`,
      '- Keep it running: dismiss this row — the check continues enforcing as-is.',
      '',
      'The check is NOT automatically retired — operator action only, matching the approval model.',
    ].join('\n'),
    payload: { signature, passCount },
    context: {},
    raisedBy: 'daemon:gate-enrichment',
    signature: `gate-enrichment-stale:${signature}`,
  })
}

/**
 * Key prefix used in `gate_burn_in` for tracking consecutive enforcing-check
 * clean passes. Distinct from the shadow burn-in prefix `enrich:` so the two
 * counters never collide.
 */
const ENFORCING_STALE_KEY_PREFIX = 'enforcing-stale:'

const enforcingStaleKey = (signature: string): string =>
  `${ENFORCING_STALE_KEY_PREFIX}${signature}`

/**
 * Track one enforcing-check verify run for staleness. If the check passed
 * (failure pattern absent), increment the consecutive-pass counter; once it
 * reaches {@link ENFORCING_STALE_THRESHOLD}, call `effects.raiseStaleRow`.
 * If the check failed, reset the counter to zero — the regression is still
 * occurring and the staleness clock starts over.
 *
 * Counter persistence: `gate_burn_in` rows keyed `enforcing-stale:<signature>`.
 * `parse_count` = consecutive passing runs. `promoted_at` = epoch milliseconds
 * written when the stale row was first raised (prevents re-raising within the
 * same consecutive-pass window).
 */
const trackEnforcingStaleness = async (
  client: MonitorDb,
  signature: string,
  passed: boolean,
  raiseStaleRow: (sig: string, count: number) => Promise<void>,
): Promise<void> => {
  const key = enforcingStaleKey(signature)

  if (!passed) {
    // Failure proves the check is still catching the regression; reset the
    // consecutive-pass counter. Clear promoted_at so the next window can
    // raise a fresh stale row.
    await client.execute({
      sql: `INSERT INTO gate_burn_in (gate_name, parse_count, promoted_at)
            VALUES (?, 0, NULL)
            ON CONFLICT(gate_name) DO UPDATE SET
              parse_count = 0,
              promoted_at = NULL`,
      args: [key],
    })
    return
  }

  // Clean pass: increment, but freeze the counter once the stale row has
  // been raised (promoted_at set) so the seen_count bump in raiseActionQueueItem
  // handles subsequent windows rather than re-triggering from here.
  await client.execute({
    sql: `INSERT INTO gate_burn_in (gate_name, parse_count)
          VALUES (?, 1)
          ON CONFLICT(gate_name) DO UPDATE SET
            parse_count = CASE
              WHEN gate_burn_in.promoted_at IS NOT NULL THEN gate_burn_in.parse_count
              ELSE gate_burn_in.parse_count + 1
            END`,
    args: [key],
  })

  const r = await client.execute({
    sql: `SELECT parse_count, promoted_at FROM gate_burn_in WHERE gate_name = ?`,
    args: [key],
  })
  if (r.rows.length === 0) return
  const row = r.rows[0] as unknown as {
    parse_count: number
    promoted_at: number | null
  }
  // Already raised in this window; raiseActionQueueItem's seen_count bump handles it.
  if (row.promoted_at !== null) return

  if (row.parse_count >= ENFORCING_STALE_THRESHOLD) {
    // Mark raised before calling the side-effect so a concurrent verify run
    // that reads this row after the UPDATE but before the raise exits without
    // double-raising.
    await client.execute({
      sql: `UPDATE gate_burn_in SET promoted_at = ? WHERE gate_name = ?`,
      args: [Date.now(), key],
    })
    await raiseStaleRow(signature, row.parse_count)
  }
}

/**
 * Post-verify shadow burn-in accounting AND enforcing-check staleness tracking.
 *
 * For every enrichment step that ran:
 *
 * - **Shadow status**: record one clean parse against the per-check
 *   `gate_burn_in` row (keyed `enrich:<signature>`). On the parse that crosses
 *   {@link import('./gate-burn-in').SHADOW_BURN_IN_COUNT}, the record
 *   auto-promotes `shadow` → `enforcing`. Clean-parse rule: the check
 *   demonstrably SAW its input (passed OR non-empty output). A step that
 *   fails with EMPTY output is the starvation signature and never advances the
 *   counter, so a starved check can never promote.
 *
 * - **Enforcing status**: track consecutive clean passes in a `gate_burn_in`
 *   row keyed `enforcing-stale:<signature>`. Any failing run (the failure
 *   pattern reappears) resets the counter. Once the counter reaches
 *   {@link ENFORCING_STALE_THRESHOLD} the check is flagged stale via
 *   `effects.raiseStaleRow`. No automatic retirement — operator-only.
 *
 * Best-effort per step: any DB or side-effect hiccup never breaks verify.
 */
export const recordEnrichmentShadowRuns = async (
  client: MonitorDb,
  steps: ReadonlyArray<VerifyStep>,
  effects?: Partial<ShadowRunEffects>,
): Promise<void> => {
  const raiseStale = effects?.raiseStaleRow ?? defaultRaiseStaleRow
  for (const step of steps) {
    const signature = signatureFromEnrichStepName(step.name)
    if (signature === null) continue
    try {
      const rec = await getEnrichment(client, signature)
      if (rec === null) continue

      if (rec.status === 'shadow') {
        const cleanParse = step.passed || step.output.trim().length > 0
        if (!cleanParse) continue
        const result = await recordGateParse(client, step.name)
        if (result.promoted) {
          // Re-read to avoid double-flipping on concurrent verify runs.
          const fresh = await getEnrichment(client, signature)
          if (fresh !== null && fresh.status === 'shadow') {
            await setStatus(client, signature, { status: 'enforcing' })
          }
        }
      } else if (rec.status === 'enforcing') {
        await trackEnforcingStaleness(client, signature, step.passed, raiseStale)
      }
    } catch {
      // Best-effort: shadow/stale accounting must never fail the verify step.
    }
  }
}

// ---------------------------------------------------------------------------
// Failure-chokepoint entry point (candidate generation)
// ---------------------------------------------------------------------------

export interface ObserveFailureForEnrichmentInput {
  db: MonitorDb
  /** The computed `<failingStep>/<error-class>` failure signature. */
  signature: string
  failingStep: string
  /** The failing task id (becomes the record's origin_task_id). */
  originTaskId: string
  /** Raw error output — quoted as reproduce evidence in the Writer prompt. */
  errorOutput: string
  /** The verify steps that actually ran, for family-(a) draft derivation. */
  ranVerifySteps?: readonly RanVerifyStep[]
  /** The failing task's worktree, to relativise `stepDir` into a scope. */
  worktreePath?: string | null
}

/**
 * Side-effect seams for {@link observeFailureForEnrichment}, injectable so
 * tests can assert spawn/raise happened exactly once without a live queue.
 */
export interface EnrichmentSideEffects {
  /** Enqueue the detached Writer-tagged draft task; returns its task id. */
  spawnWriterDraftTask: (
    record: EnrichmentRecord,
    input: ObserveFailureForEnrichmentInput,
  ) => Promise<string>
  /** Raise the one approval action-queue row; returns the row id. */
  raiseApprovalRow: (
    record: EnrichmentRecord,
    input: ObserveFailureForEnrichmentInput,
    writerTaskId: string,
  ) => Promise<string>
}

/**
 * The prompt for the detached Writer-tagged candidate-drafting task. The
 * Writer produces ONE candidate check and lands it with `mars enrich draft`;
 * it never approves, never enforces — the human does that via the action
 * queue (ADR-0048), and burn-in gates enforcement after that.
 */
export const buildEnrichmentDraftPrompt = (
  record: EnrichmentRecord,
  input: ObserveFailureForEnrichmentInput,
): string => {
  const family = record.encodableFamily ?? 'command'
  const evidence = input.errorOutput.slice(0, 2000)
  const draftLine = record.stepSpec
    ? `A mechanically-derived draft already exists (re-run of the failing command): ${JSON.stringify(
        { cmd: record.stepSpec.cmd, args: record.stepSpec.args, dir: record.stepSpec.dir },
      )}. Refine or replace it if a sharper deterministic check exists.`
    : 'No draft exists yet — derive one from the evidence below.'
  return [
    `Draft ONE candidate static verify check for the failure signature \`${record.signature}\` (gate-enrichment pipeline, PRD 745f33e0).`,
    '',
    `Origin task: ${input.originTaskId}. Failing step: ${input.failingStep}. Check family: ${family}.`,
    '',
    'The check must be a deterministic, command-shaped predicate over the worktree/diff:',
    '- family "command": the failing typecheck/lint/test command narrowed to the scope that failed;',
    '- family "pattern": a deterministic scan for the forbidden construct (e.g. grep over the diff);',
    '- family "regression-test": a committed regression test plus a scoped step that runs it.',
    '',
    draftLine,
    '',
    'Reproduce evidence (tail-truncated failing output):',
    '```',
    evidence,
    '```',
    '',
    `Land your single candidate with: mars enrich draft '${record.signature}' '<json>' — where <json> is {"cmd": "...", "args": [...], "dir": "<repo-relative scope or .>"}. The command must exit 0 when the worktree is clean of this failure class and non-zero when it reproduces.`,
    '',
    'Do NOT approve, promote, or enforce the check yourself — a human approves it via the action queue, and it must survive a shadow burn-in before it may enforce. Never touch the verify recipe file.',
    '',
    'Save your work.',
  ].join('\n')
}

const defaultSpawnWriterDraftTask = async (
  record: EnrichmentRecord,
  input: ObserveFailureForEnrichmentInput,
): Promise<string> => {
  // Dynamic import: queue.ts pulls the Arc aggregate; a static edge here
  // would risk an import cycle through queue-fix-tasks → gate-enrichment.
  const { enqueueTask } = await import('../queue')
  const task = await enqueueTask(
    buildEnrichmentDraftPrompt(record, input),
    undefined,
    {
      skipTriage: true,
      // Detached, Writer-tagged (never a recovery/fix task): a failed draft
      // must never consume the origin's one recovery slot (ADR-0040).
      tags: ['writer'],
      author: { kind: 'agent', name: 'gate-enrichment' },
      intent: `Draft candidate check enrich:${record.signature}`,
    },
  )
  return task.id
}

const defaultRaiseApprovalRow = async (
  record: EnrichmentRecord,
  input: ObserveFailureForEnrichmentInput,
  writerTaskId: string,
): Promise<string> => {
  return raiseActionQueueItem({
    kind: 'gate-enrichment',
    category: 'orchestrator',
    priority: 'normal',
    title: `Approve or retire candidate check enrich:${record.signature}`,
    body: [
      `Failure signature \`${record.signature}\` (first seen on task ${input.originTaskId}) is classified statically encodable (family: ${record.encodableFamily ?? 'command'}).`,
      `A detached Writer task (${writerTaskId}) is drafting ONE candidate check. Once the draft is landed, approve it into SHADOW mode with \`mars enrich approve '${record.signature}'\` or retire the signature with \`mars enrich retire '${record.signature}'\`.`,
      '',
      'Approval only enters SHADOW mode — the check cannot fail verify until it has recorded a full burn-in of clean parses. It never enforces autonomously: the completeness-gate incident (d9237119, 2026-07-03) failed 100% of tasks and blocked its own fix from merging.',
      '',
      'Reproduce evidence (tail-truncated):',
      '```',
      input.errorOutput.slice(0, 1200),
      '```',
    ].join('\n'),
    payload: {
      signature: record.signature,
      encodableFamily: record.encodableFamily,
      originTaskId: input.originTaskId,
      failingStep: input.failingStep,
      writerTaskId,
      stepSpec: record.stepSpec,
    },
    context: {},
    raisedBy: 'daemon:gate-enrichment',
    signature: `gate-enrichment:${record.signature}`,
  })
}

/**
 * Derive the family-(a) draft: the first FAILED ran verify step, re-run as a
 * scoped step. `stepDir` is absolute; relativise against the worktree to get
 * the ADR-0018 scope key, falling back to the root scope when it does not
 * resolve inside the worktree.
 */
const deriveCommandDraft = (
  input: ObserveFailureForEnrichmentInput,
): VerifyStepSpec | null => {
  const failed = input.ranVerifySteps?.find((s) => !s.passed)
  if (!failed) return null
  let dir = '.'
  if (input.worktreePath && isAbsolute(failed.stepDir)) {
    const rel = relative(input.worktreePath, failed.stepDir)
    if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) {
      dir = rel.replace(/\\/g, '/')
    }
  }
  return {
    name: enrichStepName(input.signature),
    cmd: failed.cmd,
    args: [...failed.args],
    required: true,
    dir,
    tier: 'task',
  }
}

/**
 * The failure-chokepoint entry point (called from
 * `handleTaskFailureWithFixTask` for origin-task failures). Exactly one of:
 *
 * - signature already claimed (ANY status) → seen_count bump, nothing else;
 * - non-encodable → recorded as such (enumerable gap), NO check, no task,
 *   no action-queue row;
 * - encodable and unclaimed → claim the signature as a candidate, spawn ONE
 *   detached Writer-tagged draft task, raise ONE approval action-queue row.
 *
 * The enforced gate is never touched from here — candidate → shadow requires
 * a human (`approveEnrichment`), and shadow → enforcing requires burn-in.
 */
export const observeFailureForEnrichment = async (
  input: ObserveFailureForEnrichmentInput,
  effects?: Partial<EnrichmentSideEffects>,
): Promise<ObserveFailureSignatureOutcome> => {
  const outcome = await observeFailureSignature(input.db, {
    signature: input.signature,
    originTaskId: input.originTaskId,
    draftStep: deriveCommandDraft(input),
  })
  if (outcome.kind !== 'claimed-candidate') return outcome

  const spawn = effects?.spawnWriterDraftTask ?? defaultSpawnWriterDraftTask
  const raise = effects?.raiseApprovalRow ?? defaultRaiseApprovalRow
  const writerTaskId = await spawn(outcome.record, input)
  await raise(outcome.record, input, writerTaskId)
  return outcome
}
