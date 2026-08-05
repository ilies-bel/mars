/**
 * End-to-end lifecycle test for gate-enrichment + gate-burn-in consistency.
 *
 * Exercises the full promotion path in one cohesive test:
 *   observe → candidate → draft landing → approve (shadow)
 *   → 10 shadow parses → auto-promote → enforcing step fails verify
 *
 * Uses injected side-effects — no live queue or daemon. Every seam
 * (spawnWriterDraftTask, raiseApprovalRow) is a counting stub.
 *
 * The key invariant checked at each step: gate_burn_in and gate_enrichment
 * stay consistent — shadow-mode parse counts track exactly, the transition
 * to enforcing is atomic, and the enforcing step's required=true causes
 * a real verifyChanges run to fail.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import { type DbClient } from './db.js'
import { getTestDb } from '../../../test/db-fixture.js'
import {
  approveEnrichment,
  appendEnrichmentScopes,
  enrichStepName,
  getEnrichment,
  observeFailureForEnrichment,
  recordEnrichmentShadowRuns,
  resetGateEnrichmentSchemaLatchForTests,
  type EnrichmentSideEffects,
  type ObserveFailureForEnrichmentInput,
} from './gate-enrichment'
import {
  SHADOW_BURN_IN_COUNT,
  getGateBurnInStatus,
  resetGateBurnInSchemaLatchForTests,
} from './gate-burn-in'
import { selectVerifySteps, verifyChanges } from './git/verify'

// ---------------------------------------------------------------------------
// Test DB factory
// ---------------------------------------------------------------------------

const makeDb = (): Promise<DbClient> => getTestDb()

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** An encodable signature from the verify step family. */
const SIGNATURE = 'verify:typecheck/typecheck-cannot-find-name'

/**
 * The burn-in gate name. gate_burn_in rows are keyed by the enrichment step
 * name (`enrich:<signature>`), not by the raw signature.
 */
const GATE_KEY = enrichStepName(SIGNATURE)

/**
 * The worktree path used in the observe input. Setting stepDir === worktreePath
 * causes deriveCommandDraft to compute dir='.' (relative() returns '') so the
 * enrichment step lives in the root scope and selectVerifySteps always selects
 * it regardless of which files changed.
 */
const WORKTREE_PATH = '/tmp/fake-wt'

/** Stub side-effects — no live queue or daemon is touched. */
const makeEffects = (): EnrichmentSideEffects & { spawns: number; raises: number } => {
  const state = {
    spawns: 0,
    raises: 0,
    spawnWriterDraftTask: async () => {
      state.spawns += 1
      return `writer-task-${state.spawns}`
    },
    raiseApprovalRow: async () => {
      state.raises += 1
      return `row-${state.raises}`
    },
  }
  return state
}

const makeObserveInput = (db: DbClient): ObserveFailureForEnrichmentInput => ({
  db,
  signature: SIGNATURE,
  failingStep: 'verify:typecheck',
  originTaskId: 'task-e2e-1',
  errorOutput: 'TS2304: Cannot find name someSymbol',
  /**
   * stepDir === worktreePath → relative() returns '' → dir stays '.'
   * cmd+args produce non-empty output and exit 1 → counts as a clean parse
   * AND fails verify when enforcing.
   */
  ranVerifySteps: [
    {
      name: 'typecheck',
      cmd: 'sh',
      args: ['-c', 'echo regression-reintroduced; exit 1'],
      stepDir: WORKTREE_PATH,
      passed: false,
    },
  ],
  worktreePath: WORKTREE_PATH,
})

// ---------------------------------------------------------------------------
// Schema latch reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetGateEnrichmentSchemaLatchForTests()
  resetGateBurnInSchemaLatchForTests()
})

// ---------------------------------------------------------------------------
// E2E lifecycle test
// ---------------------------------------------------------------------------

describe('gate-enrichment e2e: full promotion lifecycle', () => {
  it(
    'observe → candidate → approve (shadow) → 10 shadow parses → auto-promote → enforcing step fails verify',
    async () => {
      const db = await makeDb()
      const effects = makeEffects()

      // ── 1. Observe failure → claim as candidate ───────────────────────────
      const outcome = await observeFailureForEnrichment(makeObserveInput(db), effects)

      expect(outcome.kind).toBe('claimed-candidate')
      expect(outcome.record.status).toBe('candidate')
      // Draft step is derived mechanically (family-a): the failed step, scoped
      // with dir='.' because stepDir === worktreePath.
      expect(outcome.record.stepSpec).not.toBeNull()
      expect(outcome.record.stepSpec!.dir).toBe('.')

      // Exactly one Writer spawn and one approval-row raise — no extras.
      expect(effects.spawns).toBe(1)
      expect(effects.raises).toBe(1)

      // gate_burn_in consistency: no entry yet — parseCount=0, still in shadow.
      const burnInAtCandidate = await getGateBurnInStatus(db, GATE_KEY)
      expect(burnInAtCandidate.inShadow).toBe(true)
      expect(burnInAtCandidate.parseCount).toBe(0)

      // ── 2. Approve → shadow (human gate, never skips to enforcing) ────────
      const approved = await approveEnrichment(db, SIGNATURE, 'e2e-tester')
      expect(approved.status).toBe('shadow')
      expect(approved.approvedBy).toBe('e2e-tester')
      expect(approved.approvedAt).not.toBeNull()

      // gate_burn_in still pristine immediately after human approval.
      const burnInAtShadow = await getGateBurnInStatus(db, GATE_KEY)
      expect(burnInAtShadow.inShadow).toBe(true)
      expect(burnInAtShadow.parseCount).toBe(0)

      // The merged scope carries the step as NON-required (shadow: never fails verify).
      const shadowScopes = await appendEnrichmentScopes(db, [])
      expect(shadowScopes).toHaveLength(1)
      expect(shadowScopes[0].scope).toBe('.')
      expect(shadowScopes[0].steps[0].required).toBe(false)
      expect(shadowScopes[0].steps[0].name).toBe(GATE_KEY)

      // ── 3. Shadow parses 1–9: gate stays in shadow, counts increment ──────
      // The step ran and produced non-empty output → clean parse → counter advances.
      const shadowRun = {
        name: GATE_KEY,
        passed: false,
        output: 'regression-reintroduced',
      }

      for (let i = 1; i < SHADOW_BURN_IN_COUNT; i++) {
        await recordEnrichmentShadowRuns(db, [shadowRun])

        // Both tables must agree at every intermediate step.
        const rec = await getEnrichment(db, SIGNATURE)
        const burnIn = await getGateBurnInStatus(db, GATE_KEY)

        expect(rec!.status).toBe('shadow')
        expect(burnIn.parseCount).toBe(i)
        expect(burnIn.inShadow).toBe(true)
      }

      // ── 4. 10th parse → auto-promotes to enforcing ────────────────────────
      await recordEnrichmentShadowRuns(db, [shadowRun])

      const promoted = await getEnrichment(db, SIGNATURE)
      expect(promoted!.status).toBe('enforcing')

      // gate_burn_in must be in sync: promoted_at written, inShadow=false.
      const burnInAfterPromotion = await getGateBurnInStatus(db, GATE_KEY)
      expect(burnInAfterPromotion.parseCount).toBe(SHADOW_BURN_IN_COUNT)
      expect(burnInAfterPromotion.inShadow).toBe(false)

      // ── 5. Enforcing step is required; a failing run now fails verify ──────
      const enforcingScopes = await appendEnrichmentScopes(db, [])
      expect(enforcingScopes).toHaveLength(1)
      expect(enforcingScopes[0].steps[0].required).toBe(true)

      // Use a real temp directory as the verify cwd (no git repo needed —
      // branch/integrationBranch are omitted so the has-diff gate is skipped).
      const cwd = mkdtempSync(join(tmpdir(), 'gate-enrichment-e2e-'))
      const steps = selectVerifySteps(enforcingScopes, ['changed.ts'])
      expect(steps).toHaveLength(1)

      const result = await verifyChanges({ cwd, steps })

      expect(result.passed).toBe(false)
      const enforcedStep = result.steps.find((s) => s.name === GATE_KEY)
      expect(enforcedStep).toBeDefined()
      expect(enforcedStep!.passed).toBe(false)
      expect(enforcedStep!.output).toContain('regression-reintroduced')
    },
  )
})
