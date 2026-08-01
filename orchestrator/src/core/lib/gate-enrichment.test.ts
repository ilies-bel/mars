/**
 * Tests for the gate-enrichment registry (gate-enrichment.ts, PRD 745f33e0).
 *
 * Specification under test:
 *  - IDEMPOTENCY — the signature is the primary key: a repeat failure whose
 *    signature is already claimed (in ANY status) bumps seen_count and never
 *    creates a sibling candidate, a duplicate step, or a second Writer spawn.
 *  - A candidate SHADOW-RUNS before enforcing: approval lands in shadow mode
 *    where its verdict can never fail verify; only SHADOW_BURN_IN_COUNT clean
 *    parses (via the generalised gate-burn-in rows keyed `enrich:<signature>`)
 *    promote it to enforcing.
 *  - A NON-encodable signature is recorded as non-encodable (enumerable gap)
 *    and produces NO check — no scope entry, no Writer task, no approval row.
 *  - Approval flips the check along the promotion path: candidate → shadow
 *    (human verb), then shadow → enforcing (burn-in) — never candidate →
 *    enforcing directly.
 *
 * DB setup: per-test in-memory PGlite clients; module-level schema latches
 * reset per test.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type DbClient } from './db.js'
import { ensureSchema } from './pg-schema.js'
import {
  approveEnrichment,
  appendEnrichmentScopes,
  classifyEncodability,
  enrichStepName,
  getEnrichment,
  listEnrichments,
  loadEnrichmentScopes,
  observeFailureForEnrichment,
  observeFailureSignature,
  reopenEnrichment,
  resetGateEnrichmentSchemaLatchForTests,
  retireEnrichment,
  setEnrichmentDraftStep,
  recordEnrichmentShadowRuns,
  signatureFromEnrichStepName,
  ENFORCING_STALE_THRESHOLD,
  type EnrichmentSideEffects,
  type ObserveFailureForEnrichmentInput,
  type ShadowRunEffects,
} from './gate-enrichment'
import {
  SHADOW_BURN_IN_COUNT,
  resetGateBurnInSchemaLatchForTests,
} from './gate-burn-in'
import {
  selectVerifySteps,
  verifyChanges,
  type VerifyStep,
} from './git/verify'

let dbSeq = 0
const makeDb = async (): Promise<DbClient> => {
  const client = openDb(`gate-enrichment-test-${process.pid}-${++dbSeq}`)
  await ensureSchema(client)
  return client
}

/** A registered ENCODABLE signature (FailureKind facet: command family). */
const ENCODABLE_SIG = 'verify:typecheck/typecheck-cannot-find-name'
/** A registered NON-encodable signature (FailureKind facet: environmental). */
const NON_ENCODABLE_SIG = 'setup:install/install-timeout'

const baseObserveInput = (
  db: DbClient,
  signature: string,
): ObserveFailureForEnrichmentInput => ({
  db,
  signature,
  failingStep: signature.slice(0, signature.lastIndexOf('/')),
  originTaskId: 'task-origin-1',
  errorOutput: 'TS2304: Cannot find name x',
  ranVerifySteps: [
    {
      name: 'typecheck',
      cmd: 'npx',
      args: ['tsc', '--noEmit'],
      stepDir: '/wt/orchestrator',
      passed: false,
    },
  ],
  worktreePath: '/wt',
})

/** Counting stub effects so the spawn/raise seams never touch a live queue. */
const makeEffects = (): EnrichmentSideEffects & {
  spawns: number
  raises: number
} => {
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

beforeEach(() => {
  resetGateEnrichmentSchemaLatchForTests()
  resetGateBurnInSchemaLatchForTests()
})

describe('gate-enrichment: signature-keyed idempotency', () => {
  it('the same signature never appends twice — repeat failures bump seen_count on the one record', async () => {
    const db = await makeDb()
    const effects = makeEffects()

    const first = await observeFailureForEnrichment(
      baseObserveInput(db, ENCODABLE_SIG),
      effects,
    )
    expect(first.kind).toBe('claimed-candidate')
    expect(first.record.status).toBe('candidate')
    expect(first.record.seenCount).toBe(1)
    expect(effects.spawns).toBe(1)
    expect(effects.raises).toBe(1)

    const second = await observeFailureForEnrichment(
      { ...baseObserveInput(db, ENCODABLE_SIG), originTaskId: 'task-origin-2' },
      effects,
    )
    expect(second.kind).toBe('seen')
    expect(second.record.seenCount).toBe(2)
    // No sibling candidate, no second Writer spawn, no second approval row.
    expect(effects.spawns).toBe(1)
    expect(effects.raises).toBe(1)
    // Origin stays the FIRST claimant.
    expect(second.record.originTaskId).toBe('task-origin-1')

    const all = await listEnrichments(db)
    expect(all).toHaveLength(1)
  })

  it('a claimed signature in ANY status only bumps seen_count — approval state survives repeat failures', async () => {
    const db = await makeDb()
    const effects = makeEffects()
    await observeFailureForEnrichment(baseObserveInput(db, ENCODABLE_SIG), effects)
    await approveEnrichment(db, ENCODABLE_SIG, 'tester')

    const again = await observeFailureForEnrichment(
      baseObserveInput(db, ENCODABLE_SIG),
      effects,
    )
    expect(again.kind).toBe('seen')
    expect(again.record.status).toBe('shadow')
    expect(again.record.seenCount).toBe(2)
    expect(again.record.approvedBy).toBe('tester')
    expect(effects.spawns).toBe(1)

    // A retired signature stays claimed too: no regeneration.
    await retireEnrichment(db, ENCODABLE_SIG)
    const postRetire = await observeFailureForEnrichment(
      baseObserveInput(db, ENCODABLE_SIG),
      effects,
    )
    expect(postRetire.kind).toBe('seen')
    expect(postRetire.record.status).toBe('retired')
    expect(effects.spawns).toBe(1)
    expect(effects.raises).toBe(1)
  })

  it('duplicate merge is belted at scope level: an enrichment step colliding with a same-scope recipe step name is skipped', async () => {
    const db = await makeDb()
    await observeFailureSignature(db, {
      signature: ENCODABLE_SIG,
      originTaskId: 't1',
      draftStep: {
        name: enrichStepName(ENCODABLE_SIG),
        cmd: 'true',
        args: [],
        required: true,
        dir: '.',
      },
    })
    await approveEnrichment(db, ENCODABLE_SIG, 'tester')

    const recipeScopes = [
      {
        scope: '.',
        steps: [
          {
            name: enrichStepName(ENCODABLE_SIG),
            cmd: 'echo',
            args: ['already-there'],
            required: true,
          },
        ],
      },
    ]
    const merged = await appendEnrichmentScopes(db, recipeScopes)
    const names = merged.flatMap((s) => s.steps.map((st) => st.name))
    expect(
      names.filter((n) => n === enrichStepName(ENCODABLE_SIG)),
    ).toHaveLength(1)
  })
})

describe('gate-enrichment: non-encodable signatures', () => {
  it('a non-encodable signature is recorded as non-encodable and produces NO check', async () => {
    const db = await makeDb()
    const effects = makeEffects()

    const outcome = await observeFailureForEnrichment(
      baseObserveInput(db, NON_ENCODABLE_SIG),
      effects,
    )
    expect(outcome.kind).toBe('recorded-non-encodable')
    expect(outcome.record.status).toBe('non-encodable')
    expect(outcome.record.nonEncodableReason).toBe('environmental')
    expect(outcome.record.stepSpec).toBeNull()

    // Enumerable, never silent: the gap is listed…
    const all = await listEnrichments(db)
    expect(all).toHaveLength(1)
    expect(all[0].status).toBe('non-encodable')

    // …but it produces NO check anywhere.
    expect(await loadEnrichmentScopes(db)).toHaveLength(0)
    expect(effects.spawns).toBe(0)
    expect(effects.raises).toBe(0)
    await expect(
      approveEnrichment(db, NON_ENCODABLE_SIG, 'tester'),
    ).rejects.toThrow(/only 'candidate' rows are approvable/)
  })

  it('classifyEncodability is total: registered facets win, unregistered signatures fall back by step family', () => {
    // Registered on the FailureKind record (ADR-0042 facet).
    expect(classifyEncodability(ENCODABLE_SIG)).toEqual({
      encodable: true,
      family: 'command',
    })
    expect(classifyEncodability(NON_ENCODABLE_SIG)).toEqual({
      encodable: false,
      reason: 'environmental',
    })
    // Unregistered fallbacks.
    expect(classifyEncodability('verify:test/test-assertion-error')).toEqual({
      encodable: true,
      family: 'command',
    })
    expect(classifyEncodability('merge:dirty-target/unclassified')).toEqual({
      encodable: false,
      reason: 'orchestration',
    })
    // An enriched check's own failure never enriches the enricher.
    expect(
      classifyEncodability('verify:enrich:verify:test/x/unclassified'),
    ).toEqual({ encodable: false, reason: 'orchestration' })
    // Anything else is explicitly unclassified — recorded, never silent.
    expect(classifyEncodability('totally:new-step/whatever')).toEqual({
      encodable: false,
      reason: 'unclassified',
    })
  })
})

describe('gate-enrichment: approval and shadow burn-in', () => {
  it('approval flips a check candidate → shadow (human gate), never straight to enforcing', async () => {
    const db = await makeDb()
    await observeFailureForEnrichment(
      baseObserveInput(db, ENCODABLE_SIG),
      makeEffects(),
    )

    const approved = await approveEnrichment(db, ENCODABLE_SIG, 'ilies')
    expect(approved.status).toBe('shadow')
    expect(approved.approvedBy).toBe('ilies')
    expect(approved.approvedAt).not.toBeNull()

    // No double approval, and no path skips shadow.
    await expect(
      approveEnrichment(db, ENCODABLE_SIG, 'ilies'),
    ).rejects.toThrow(/only 'candidate' rows are approvable/)
  })

  it('approval requires a landed draft check', async () => {
    const db = await makeDb()
    // Claim without ranVerifySteps → no mechanically-derived draft.
    await observeFailureSignature(db, {
      signature: ENCODABLE_SIG,
      originTaskId: 't1',
    })
    await expect(
      approveEnrichment(db, ENCODABLE_SIG, 'tester'),
    ).rejects.toThrow(/no landed draft check/)

    await setEnrichmentDraftStep(db, ENCODABLE_SIG, {
      cmd: 'npx',
      args: ['tsc', '--noEmit'],
      dir: 'orchestrator',
    })
    const approved = await approveEnrichment(db, ENCODABLE_SIG, 'tester')
    expect(approved.status).toBe('shadow')
    expect(approved.stepSpec?.dir).toBe('orchestrator')
  })

  it('a candidate shadow-runs before enforcing: a failing shadow verdict can never fail verify', async () => {
    const db = await makeDb()
    await observeFailureSignature(db, {
      signature: ENCODABLE_SIG,
      originTaskId: 't1',
      draftStep: {
        name: enrichStepName(ENCODABLE_SIG),
        cmd: 'sh',
        args: ['-c', 'echo failure-class-detected; exit 1'],
        required: true,
        dir: '.',
      },
    })
    await approveEnrichment(db, ENCODABLE_SIG, 'tester')

    // The merged scope carries the shadow step as NON-required.
    const scopes = await appendEnrichmentScopes(db, [])
    expect(scopes).toHaveLength(1)
    expect(scopes[0].steps[0].required).toBe(false)

    // Run it through unchanged ADR-0018 selection + verifyChanges: the check
    // RUNS, its verdict fails, and verify still passes.
    const cwd = mkdtempSync(join(tmpdir(), 'gate-enrichment-'))
    const steps = selectVerifySteps(scopes)
    const r = await verifyChanges({ cwd, steps })
    expect(r.passed).toBe(true)
    const enriched = r.steps.find(
      (s) => s.name === enrichStepName(ENCODABLE_SIG),
    )
    expect(enriched).toBeDefined()
    expect(enriched!.passed).toBe(false)
    expect(enriched!.output).toContain('failure-class-detected')
  })

  it(`${SHADOW_BURN_IN_COUNT} clean parses promote shadow → enforcing; the enforcing check then fails verify`, async () => {
    const db = await makeDb()
    await observeFailureSignature(db, {
      signature: ENCODABLE_SIG,
      originTaskId: 't1',
      draftStep: {
        name: enrichStepName(ENCODABLE_SIG),
        cmd: 'sh',
        args: ['-c', 'echo regression-reintroduced; exit 1'],
        required: true,
        dir: '.',
      },
    })
    await approveEnrichment(db, ENCODABLE_SIG, 'tester')

    const shadowRun: VerifyStep = {
      name: enrichStepName(ENCODABLE_SIG),
      passed: false,
      output: 'regression-reintroduced',
    }
    for (let i = 0; i < SHADOW_BURN_IN_COUNT - 1; i++) {
      await recordEnrichmentShadowRuns(db, [shadowRun])
      const rec = await getEnrichment(db, ENCODABLE_SIG)
      expect(rec!.status).toBe('shadow')
    }
    await recordEnrichmentShadowRuns(db, [shadowRun])
    const promoted = await getEnrichment(db, ENCODABLE_SIG)
    expect(promoted!.status).toBe('enforcing')

    // Enforcing: the merged step is required and a failing run fails verify.
    const scopes = await appendEnrichmentScopes(db, [])
    expect(scopes[0].steps[0].required).toBe(true)
    const cwd = mkdtempSync(join(tmpdir(), 'gate-enrichment-'))
    const r = await verifyChanges({
      cwd,
      steps: selectVerifySteps(scopes),
    })
    expect(r.passed).toBe(false)
  })

  it('a starved shadow check (failing with EMPTY output) never records a parse and never promotes', async () => {
    const db = await makeDb()
    await observeFailureSignature(db, {
      signature: ENCODABLE_SIG,
      originTaskId: 't1',
      draftStep: {
        name: enrichStepName(ENCODABLE_SIG),
        cmd: 'sh',
        args: ['-c', 'exit 1'],
        required: true,
        dir: '.',
      },
    })
    await approveEnrichment(db, ENCODABLE_SIG, 'tester')

    const starvedRun: VerifyStep = {
      name: enrichStepName(ENCODABLE_SIG),
      passed: false,
      output: '   ',
    }
    for (let i = 0; i < SHADOW_BURN_IN_COUNT * 2; i++) {
      await recordEnrichmentShadowRuns(db, [starvedRun])
    }
    const rec = await getEnrichment(db, ENCODABLE_SIG)
    expect(rec!.status).toBe('shadow')
    const listed = await listEnrichments(db)
    expect(listed[0].burnInParseCount).toBe(0)
  })

  it('retire keeps the signature claimed; reopen is the only way back (explicit verb)', async () => {
    const db = await makeDb()
    const effects = makeEffects()
    await observeFailureForEnrichment(baseObserveInput(db, ENCODABLE_SIG), effects)
    await approveEnrichment(db, ENCODABLE_SIG, 'tester')
    const retired = await retireEnrichment(db, ENCODABLE_SIG)
    expect(retired.status).toBe('retired')
    expect(retired.retiredAt).not.toBeNull()

    // Retired checks never run.
    expect(await loadEnrichmentScopes(db)).toHaveLength(0)

    const reopened = await reopenEnrichment(db, ENCODABLE_SIG)
    expect(reopened.status).toBe('candidate')
  })
})

describe('gate-enrichment: family-(a) draft derivation', () => {
  it('derives the failed verify command re-run, scoped by relativising stepDir against the worktree', async () => {
    const db = await makeDb()
    const outcome = await observeFailureForEnrichment(
      baseObserveInput(db, ENCODABLE_SIG),
      makeEffects(),
    )
    expect(outcome.kind).toBe('claimed-candidate')
    expect(outcome.record.stepSpec).not.toBeNull()
    expect(outcome.record.stepSpec!.cmd).toBe('npx')
    expect(outcome.record.stepSpec!.args).toEqual(['tsc', '--noEmit'])
    expect(outcome.record.stepSpec!.dir).toBe('orchestrator')
    expect(outcome.record.stepSpec!.name).toBe(enrichStepName(ENCODABLE_SIG))
  })
})

// ---------------------------------------------------------------------------
// Focused unit tests for the individual public functions
// ---------------------------------------------------------------------------

describe('gate-enrichment: signatureFromEnrichStepName', () => {
  it('round-trips with enrichStepName: strips the enrich: prefix', () => {
    expect(signatureFromEnrichStepName(enrichStepName(ENCODABLE_SIG))).toBe(ENCODABLE_SIG)
    expect(signatureFromEnrichStepName(enrichStepName(NON_ENCODABLE_SIG))).toBe(NON_ENCODABLE_SIG)
  })

  it('returns null for non-enrichment step names', () => {
    expect(signatureFromEnrichStepName('typecheck')).toBeNull()
    expect(signatureFromEnrichStepName('verify:test/test-assertion-error')).toBeNull()
    expect(signatureFromEnrichStepName('')).toBeNull()
  })
})

describe('gate-enrichment: observeFailureSignature (direct)', () => {
  it('first observation of an encodable signature claims it as candidate with seenCount=1', async () => {
    const db = await makeDb()
    const outcome = await observeFailureSignature(db, {
      signature: ENCODABLE_SIG,
      originTaskId: 'task-direct-1',
    })
    expect(outcome.kind).toBe('claimed-candidate')
    expect(outcome.record.status).toBe('candidate')
    expect(outcome.record.seenCount).toBe(1)
    expect(outcome.record.originTaskId).toBe('task-direct-1')
    expect(outcome.record.stepSpec).toBeNull() // no draftStep provided
    expect(outcome.record.encodableFamily).toBe('command')
    expect(outcome.record.nonEncodableReason).toBeNull()
  })

  it('first observation of a non-encodable signature records it without a check', async () => {
    const db = await makeDb()
    const outcome = await observeFailureSignature(db, {
      signature: NON_ENCODABLE_SIG,
      originTaskId: 'task-direct-2',
    })
    expect(outcome.kind).toBe('recorded-non-encodable')
    expect(outcome.record.status).toBe('non-encodable')
    expect(outcome.record.stepSpec).toBeNull()
    expect(outcome.record.nonEncodableReason).toBe('environmental')
    expect(outcome.record.encodableFamily).toBeNull()
  })

  it('second observation returns seen and bumps seen_count, preserving the first origin', async () => {
    const db = await makeDb()
    await observeFailureSignature(db, { signature: ENCODABLE_SIG, originTaskId: 'first-owner' })
    const second = await observeFailureSignature(db, {
      signature: ENCODABLE_SIG,
      originTaskId: 'late-observer',
    })
    expect(second.kind).toBe('seen')
    expect(second.record.seenCount).toBe(2)
    expect(second.record.status).toBe('candidate')
    // Origin stays the first claimant
    expect(second.record.originTaskId).toBe('first-owner')
  })

  it('stores a draftStep on the new candidate row when provided', async () => {
    const db = await makeDb()
    const outcome = await observeFailureSignature(db, {
      signature: ENCODABLE_SIG,
      originTaskId: 'task-with-draft',
      draftStep: {
        name: enrichStepName(ENCODABLE_SIG),
        cmd: 'npx',
        args: ['tsc', '--noEmit'],
        required: true,
        dir: 'orchestrator',
      },
    })
    expect(outcome.kind).toBe('claimed-candidate')
    expect(outcome.record.stepSpec).not.toBeNull()
    expect(outcome.record.stepSpec!.cmd).toBe('npx')
    expect(outcome.record.stepSpec!.args).toEqual(['tsc', '--noEmit'])
    expect(outcome.record.stepSpec!.dir).toBe('orchestrator')
  })
})

describe('gate-enrichment: appendEnrichmentScopes', () => {
  it('empty registry: returns recipe scopes unchanged', async () => {
    const db = await makeDb()
    const recipeScopes = [
      { scope: '.', steps: [{ name: 'typecheck', cmd: 'npx', args: ['tsc'], required: true }] },
    ]
    const merged = await appendEnrichmentScopes(db, recipeScopes)
    expect(merged).toHaveLength(1)
    expect(merged[0].steps).toHaveLength(1)
    expect(merged[0].steps[0].name).toBe('typecheck')
  })

  it('shadow-only steps: appended with required=false so they cannot fail verify', async () => {
    const db = await makeDb()
    await observeFailureSignature(db, {
      signature: ENCODABLE_SIG,
      originTaskId: 't1',
      draftStep: {
        name: enrichStepName(ENCODABLE_SIG),
        cmd: 'npx',
        args: ['tsc'],
        required: true,
        dir: '.',
      },
    })
    await approveEnrichment(db, ENCODABLE_SIG, 'tester')

    const merged = await appendEnrichmentScopes(db, [])
    expect(merged).toHaveLength(1)
    expect(merged[0].steps[0].required).toBe(false)
    expect(merged[0].steps[0].name).toBe(enrichStepName(ENCODABLE_SIG))
  })

  it('name collision with recipe scope: enrichment step is skipped (deduplication)', async () => {
    const db = await makeDb()
    await observeFailureSignature(db, {
      signature: ENCODABLE_SIG,
      originTaskId: 't1',
      draftStep: {
        name: enrichStepName(ENCODABLE_SIG),
        cmd: 'true',
        args: [],
        required: true,
        dir: '.',
      },
    })
    await approveEnrichment(db, ENCODABLE_SIG, 'tester')

    const recipeScopes = [
      {
        scope: '.',
        steps: [{ name: enrichStepName(ENCODABLE_SIG), cmd: 'echo', args: ['already-there'], required: true }],
      },
    ]
    const merged = await appendEnrichmentScopes(db, recipeScopes)
    const allNames = merged.flatMap((s) => s.steps.map((st) => st.name))
    // The enrichment step must appear exactly once (recipe's copy wins, no duplicate).
    expect(allNames.filter((n) => n === enrichStepName(ENCODABLE_SIG))).toHaveLength(1)
  })

  it('mixed shadow+enforcing: shadow step required=false, enforcing step required=true', async () => {
    const db = await makeDb()
    const SIG_SHADOW = ENCODABLE_SIG
    const SIG_ENFORCING = 'verify:test/test-assertion-error'

    // SIG_SHADOW: approve → stays in shadow (burn-in not complete)
    await observeFailureSignature(db, {
      signature: SIG_SHADOW,
      originTaskId: 't-shadow',
      draftStep: {
        name: enrichStepName(SIG_SHADOW),
        cmd: 'npx',
        args: ['tsc'],
        required: true,
        dir: '.',
      },
    })
    await approveEnrichment(db, SIG_SHADOW, 'tester')

    // SIG_ENFORCING: approve then complete burn-in to promote → enforcing
    await observeFailureSignature(db, {
      signature: SIG_ENFORCING,
      originTaskId: 't-enforce',
      draftStep: {
        name: enrichStepName(SIG_ENFORCING),
        cmd: 'true',
        args: [],
        required: true,
        dir: '.',
      },
    })
    await approveEnrichment(db, SIG_ENFORCING, 'tester')
    for (let i = 0; i < SHADOW_BURN_IN_COUNT; i++) {
      await recordEnrichmentShadowRuns(db, [
        { name: enrichStepName(SIG_ENFORCING), passed: true, output: 'ok' },
      ])
    }

    const merged = await appendEnrichmentScopes(db, [])
    const allSteps = merged.flatMap((s) => s.steps)
    const shadowStep = allSteps.find((s) => s.name === enrichStepName(SIG_SHADOW))
    const enforcingStep = allSteps.find((s) => s.name === enrichStepName(SIG_ENFORCING))
    expect(shadowStep).toBeDefined()
    expect(shadowStep!.required).toBe(false)
    expect(enforcingStep).toBeDefined()
    expect(enforcingStep!.required).toBe(true)
  })
})

describe('gate-enrichment: recordEnrichmentShadowRuns', () => {
  it('non-enrichment step names are silently ignored (no error, no DB write)', async () => {
    const db = await makeDb()
    await expect(
      recordEnrichmentShadowRuns(db, [
        { name: 'typecheck', passed: false, output: 'TS2304 error' },
        { name: 'test', passed: true, output: '' },
      ]),
    ).resolves.toBeUndefined()
    // Nothing was written to the enrichment registry
    expect(await listEnrichments(db)).toHaveLength(0)
  })

  it('a shadow enrichment step with non-empty output advances the burn-in counter', async () => {
    const db = await makeDb()
    await observeFailureSignature(db, {
      signature: ENCODABLE_SIG,
      originTaskId: 't1',
      draftStep: {
        name: enrichStepName(ENCODABLE_SIG),
        cmd: 'echo',
        args: ['hi'],
        required: true,
        dir: '.',
      },
    })
    await approveEnrichment(db, ENCODABLE_SIG, 'tester')

    await recordEnrichmentShadowRuns(db, [
      { name: enrichStepName(ENCODABLE_SIG), passed: false, output: 'some error output' },
    ])
    const listed = await listEnrichments(db)
    expect(listed[0].burnInParseCount).toBe(1)
    // Still shadow: one parse is not enough to promote
    expect(listed[0].status).toBe('shadow')
  })

  it('a shadow step with blank output (starvation) does not advance the burn-in counter', async () => {
    const db = await makeDb()
    await observeFailureSignature(db, {
      signature: ENCODABLE_SIG,
      originTaskId: 't1',
      draftStep: {
        name: enrichStepName(ENCODABLE_SIG),
        cmd: 'sh',
        args: ['-c', 'exit 1'],
        required: true,
        dir: '.',
      },
    })
    await approveEnrichment(db, ENCODABLE_SIG, 'tester')

    await recordEnrichmentShadowRuns(db, [
      { name: enrichStepName(ENCODABLE_SIG), passed: false, output: '   ' },
    ])
    const listed = await listEnrichments(db)
    expect(listed[0].burnInParseCount).toBe(0) // starvation — no clean parse
    expect(listed[0].status).toBe('shadow')
  })
})

// ---------------------------------------------------------------------------
// Enforcing-check staleness tracking
// ---------------------------------------------------------------------------

/** Helper: approve + burn-in a check all the way to enforcing status. */
const promoteToEnforcing = async (db: DbClient, signature: string): Promise<void> => {
  await observeFailureSignature(db, {
    signature,
    originTaskId: 'promote-helper',
    draftStep: {
      name: enrichStepName(signature),
      cmd: 'true',
      args: [],
      required: true,
      dir: '.',
    },
  })
  await approveEnrichment(db, signature, 'tester')
  for (let i = 0; i < SHADOW_BURN_IN_COUNT; i++) {
    await recordEnrichmentShadowRuns(db, [
      { name: enrichStepName(signature), passed: true, output: 'ok' },
    ])
  }
}

/** A minimal stub for ShadowRunEffects stale-row injection. */
const makeStaleEffects = (): ShadowRunEffects & {
  calls: Array<{ signature: string; passCount: number }>
} => {
  const state = {
    calls: [] as Array<{ signature: string; passCount: number }>,
    raiseStaleRow: async (signature: string, passCount: number) => {
      state.calls.push({ signature, passCount })
    },
  }
  return state
}

describe('gate-enrichment: recordEnrichmentShadowRuns — enforcing staleness', () => {
  it(`${ENFORCING_STALE_THRESHOLD} consecutive clean passes on an enforcing check raise the stale row once`, async () => {
    const db = await makeDb()
    await promoteToEnforcing(db, ENCODABLE_SIG)

    const effects = makeStaleEffects()
    const passingRun = { name: enrichStepName(ENCODABLE_SIG), passed: true, output: 'ok' }

    // ENFORCING_STALE_THRESHOLD - 1 passes: no stale row yet
    for (let i = 0; i < ENFORCING_STALE_THRESHOLD - 1; i++) {
      await recordEnrichmentShadowRuns(db, [passingRun], effects)
    }
    expect(effects.calls).toHaveLength(0)

    // The Nth pass: stale row is raised exactly once
    await recordEnrichmentShadowRuns(db, [passingRun], effects)
    expect(effects.calls).toHaveLength(1)
    expect(effects.calls[0].signature).toBe(ENCODABLE_SIG)
    expect(effects.calls[0].passCount).toBe(ENFORCING_STALE_THRESHOLD)
  })

  it('a failing run on an enforcing check resets the consecutive-pass counter', async () => {
    const db = await makeDb()
    await promoteToEnforcing(db, ENCODABLE_SIG)

    const effects = makeStaleEffects()
    const passingRun = { name: enrichStepName(ENCODABLE_SIG), passed: true, output: 'ok' }
    const failingRun = { name: enrichStepName(ENCODABLE_SIG), passed: false, output: 'regression' }

    // Accumulate passes up to threshold - 1
    for (let i = 0; i < ENFORCING_STALE_THRESHOLD - 1; i++) {
      await recordEnrichmentShadowRuns(db, [passingRun], effects)
    }
    expect(effects.calls).toHaveLength(0)

    // A failure resets the counter
    await recordEnrichmentShadowRuns(db, [failingRun], effects)
    expect(effects.calls).toHaveLength(0)

    // Re-accumulate ENFORCING_STALE_THRESHOLD passes from zero — stale row raised again
    for (let i = 0; i < ENFORCING_STALE_THRESHOLD; i++) {
      await recordEnrichmentShadowRuns(db, [passingRun], effects)
    }
    expect(effects.calls).toHaveLength(1)
  })

  it('the stale row is raised exactly once per consecutive-pass window (no duplicates beyond the first)', async () => {
    const db = await makeDb()
    await promoteToEnforcing(db, ENCODABLE_SIG)

    const effects = makeStaleEffects()
    const passingRun = { name: enrichStepName(ENCODABLE_SIG), passed: true, output: 'ok' }

    // Run well past the threshold
    for (let i = 0; i < ENFORCING_STALE_THRESHOLD * 2; i++) {
      await recordEnrichmentShadowRuns(db, [passingRun], effects)
    }
    // Raised exactly once — subsequent passes in the same window don't re-raise
    expect(effects.calls).toHaveLength(1)
  })

  it('enforcing check: failing runs below the threshold never raise a stale row', async () => {
    const db = await makeDb()
    await promoteToEnforcing(db, ENCODABLE_SIG)

    const effects = makeStaleEffects()
    const failingRun = { name: enrichStepName(ENCODABLE_SIG), passed: false, output: 'regression' }

    for (let i = 0; i < ENFORCING_STALE_THRESHOLD * 2; i++) {
      await recordEnrichmentShadowRuns(db, [failingRun], effects)
    }
    expect(effects.calls).toHaveLength(0)
  })

  it('non-enforcing checks (shadow, candidate, retired) do not trigger staleness tracking', async () => {
    const db = await makeDb()
    // Observe but don't approve → stays candidate
    await observeFailureSignature(db, {
      signature: ENCODABLE_SIG,
      originTaskId: 't1',
      draftStep: { name: enrichStepName(ENCODABLE_SIG), cmd: 'true', args: [], required: true, dir: '.' },
    })

    const effects = makeStaleEffects()
    const passingRun = { name: enrichStepName(ENCODABLE_SIG), passed: true, output: 'ok' }

    for (let i = 0; i < ENFORCING_STALE_THRESHOLD * 2; i++) {
      await recordEnrichmentShadowRuns(db, [passingRun], effects)
    }
    // Candidate is not shadow or enforcing: staleness not tracked
    expect(effects.calls).toHaveLength(0)
    // And the record is still a candidate (no mutation)
    const rec = await getEnrichment(db, ENCODABLE_SIG)
    expect(rec!.status).toBe('candidate')
  })

  it('a failure after the stale row was raised resets the window so a new stale row can be raised', async () => {
    const db = await makeDb()
    await promoteToEnforcing(db, ENCODABLE_SIG)

    const effects = makeStaleEffects()
    const passingRun = { name: enrichStepName(ENCODABLE_SIG), passed: true, output: 'ok' }
    const failingRun = { name: enrichStepName(ENCODABLE_SIG), passed: false, output: 'regression' }

    // First window: raise the stale row
    for (let i = 0; i < ENFORCING_STALE_THRESHOLD; i++) {
      await recordEnrichmentShadowRuns(db, [passingRun], effects)
    }
    expect(effects.calls).toHaveLength(1)

    // A failure resets the window
    await recordEnrichmentShadowRuns(db, [failingRun], effects)

    // Second window: stale row raised again
    for (let i = 0; i < ENFORCING_STALE_THRESHOLD; i++) {
      await recordEnrichmentShadowRuns(db, [passingRun], effects)
    }
    expect(effects.calls).toHaveLength(2)
  })
})
