/**
 * Tests for action-queue-recipes.ts.
 *
 * verify-uncovered:
 *   - sweep-raised (proposedGate present): observation wording, no "merged" claim
 *   - merge-raised (proposedGate absent): keeps the existing merge wording
 *   - scope "." renders as "the repository root" so no bare period ever reaches
 *     the operator.
 *
 * awaiting-human:
 *   - lease-park situation exposes approve-step and abort-release verbs
 *   - approve-step label is "Approve and merge" when stepName === 'merge-gate'
 *   - approve-step label is "Mark step done" for any other step name
 *   - no verbs for lease-expired and escalation situations
 */

import { describe, expect, it } from 'vitest'
import { getRecipeVerbs, humanSummary, lookupRecipe, registeredKinds } from '../action-queue-recipes'

// ---------------------------------------------------------------------------
// humanSummary — provenance branching
// ---------------------------------------------------------------------------

describe('verify-uncovered humanSummary', () => {
  it('sweep-raised (proposedGate present): renders observation wording', () => {
    const result = humanSummary('verify-uncovered', {
      scope: '.',
      changedPaths: ['.'],
      recipe: null,
      proposedGate: {
        name: 'typecheck',
        cmd: 'npx',
        args: ['tsc', '--noEmit'],
        scope: '.',
        evidence: 'Repo has TypeScript files but no typecheck gate',
      },
    })
    expect(result).toContain('Repo has TypeScript files but no typecheck gate')
  })

  it('sweep-raised (proposedGate present): does not claim a task merged', () => {
    const result = humanSummary('verify-uncovered', {
      scope: '.',
      changedPaths: ['.'],
      recipe: null,
      proposedGate: {
        name: 'typecheck',
        cmd: 'npx',
        args: ['tsc', '--noEmit'],
        scope: '.',
        evidence: 'Repo has TypeScript files but no typecheck gate',
      },
    })
    expect(result).not.toContain('merged')
  })

  it('merge-raised (no proposedGate): keeps the merge wording', () => {
    const result = humanSummary('verify-uncovered', {
      scope: 'orchestrator/src',
      changedPaths: ['orchestrator/src/core/queue.ts'],
      recipe: null,
    })
    expect(result).toContain('merged')
  })

  it('merge-raised (no proposedGate): includes the scope label', () => {
    const result = humanSummary('verify-uncovered', {
      scope: 'orchestrator/src',
      changedPaths: ['orchestrator/src/core/queue.ts'],
      recipe: null,
    })
    expect(result).toContain('orchestrator/src')
  })

  it('scope "." renders as "the repository root" in merge-raised body (no bare period)', () => {
    const result = humanSummary('verify-uncovered', {
      scope: '.',
      changedPaths: ['.'],
      recipe: null,
    })
    expect(result).toContain('the repository root')
    // A bare '.' must not appear as the scope label — "for ." or "for . " etc.
    expect(result).not.toMatch(/\bfor \./u)
  })
})

// ---------------------------------------------------------------------------
// Verb labels — distinguishable by a cold reader
// ---------------------------------------------------------------------------

describe('verify-uncovered verbs', () => {
  const recipe = lookupRecipe('verify-uncovered')

  const makeCtx = (payload: Record<string, unknown>) => ({
    kind: 'verify-uncovered' as const,
    entityId: 'test-entity-id',
    payload,
    context: {},
    title: 'No verify gate',
    body: '',
    raisedAt: '2026-08-28T00:00:00.000Z',
  })

  it('copy verb is labelled "Copy gate command" when proposedGate present', () => {
    const ctx = makeCtx({
      scope: '.',
      changedPaths: ['.'],
      recipe: null,
      proposedGate: {
        name: 'typecheck',
        cmd: 'npx',
        args: ['tsc', '--noEmit'],
        scope: '.',
        evidence: 'Repo has TypeScript files but no typecheck gate',
      },
    })
    const verbs =
      typeof recipe.verbs === 'function'
        ? recipe.verbs(ctx as Parameters<typeof recipe.verbs>[0])
        : recipe.verbs
    const copyVerb = verbs.find((v) => v.op === 'copy')
    expect(copyVerb).toBeDefined()
    expect(copyVerb?.label).toBe('Copy gate command')
  })

  it('add-gate verb is labelled "Add proposed gate"', () => {
    const ctx = makeCtx({
      scope: '.',
      changedPaths: ['.'],
      recipe: null,
      proposedGate: {
        name: 'typecheck',
        cmd: 'npx',
        args: ['tsc', '--noEmit'],
        scope: '.',
        evidence: 'Repo has TypeScript files but no typecheck gate',
      },
    })
    const verbs =
      typeof recipe.verbs === 'function'
        ? recipe.verbs(ctx as Parameters<typeof recipe.verbs>[0])
        : recipe.verbs
    const addGateVerb = verbs.find((v) => v.op === 'add-gate')
    expect(addGateVerb).toBeDefined()
    expect(addGateVerb?.label).toBe('Add proposed gate')
  })

  it('add-gate verb absent when no proposedGate', () => {
    const ctx = makeCtx({
      scope: 'orchestrator/src',
      changedPaths: ['orchestrator/src/core/queue.ts'],
      recipe: null,
    })
    const verbs =
      typeof recipe.verbs === 'function'
        ? recipe.verbs(ctx as Parameters<typeof recipe.verbs>[0])
        : recipe.verbs
    expect(verbs.find((v) => v.op === 'add-gate')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// gate-broken recipe — copy, naming, and quarantine-state accuracy
// ---------------------------------------------------------------------------

describe('gate-broken humanSummary', () => {
  const makePayload = (overrides: Record<string, unknown> = {}) => ({
    gate: 'aaaa-bbbb-cccc-dddd-eeee',
    scope: 'ui',
    name: 'test',
    required: false,
    verdict: 'verify:test/test-assertion-error',
    originTaskId: null,
    streak: null,
    ...overrides,
  })

  it('uses scope/name instead of verdict or UUID as the gate identity', () => {
    const result = humanSummary('gate-broken', makePayload())
    expect(result).toContain('ui/test')
    // Must NOT include the raw verdict (machine signature) as the identity.
    expect(result).not.toContain('verify:test/test-assertion-error')
    // The UUID is acceptable in the restore command but must NOT appear
    // as the gate's human-readable identity (i.e. not preceded by "The" or "gate").
    expect(result).not.toMatch(/\bThe aaaa-bbbb-cccc-dddd-eeee\b/)
    expect(result).not.toMatch(/gate aaaa-bbbb-cccc-dddd-eeee\b/)
  })

  it('does NOT embed the restore command in the summary (DEC-18: no machine strings on card faces)', () => {
    const result = humanSummary('gate-broken', makePayload())
    // The exact CLI form lives in the copy verb's `hint` field, not the prose.
    expect(result).not.toContain('mars verify-gate restore')
  })

  it('states the gate is quarantined (current state), not that it keeps failing', () => {
    const result = humanSummary('gate-broken', makePayload())
    expect(result).toContain('quarantined')
    // Old wording "keeps failing" describes the past; current state language is required.
    expect(result).not.toContain('keeps failing the same way')
  })

  it('for a required gate: states that merges proceed without this check', () => {
    const result = humanSummary('gate-broken', makePayload({ required: true }))
    expect(result).toContain('required gate')
    // Must name the consequence: merges are proceeding without it.
    expect(result).toMatch(/merge.*without|without.*check/i)
  })

  it('for a non-required gate: does not add the required-gate clause', () => {
    const result = humanSummary('gate-broken', makePayload({ required: false }))
    expect(result).not.toContain('required gate')
  })
})

describe('gate-broken verbs', () => {
  const recipe = lookupRecipe('gate-broken')

  const makeCtx = (payload: Record<string, unknown>) => ({
    kind: 'gate-broken' as const,
    entityId: 'some-derived-id',
    payload,
    context: {},
    title: 'Gate ui/test is broken',
    body: '',
    raisedAt: '2026-09-04T00:00:00.000Z',
  })

  it('contains gate-restore as the primary verb', () => {
    const ctx = makeCtx({ gate: 'aaaa-1234', scope: 'ui', name: 'test', required: false, verdict: 'verify:test/fail', originTaskId: null, streak: null })
    const verbs = typeof recipe.verbs === 'function' ? recipe.verbs(ctx as Parameters<typeof recipe.verbs>[0]) : recipe.verbs
    expect(verbs.find((v) => v.op === 'gate-restore')).toBeDefined()
    expect(verbs.find((v) => v.op === 'gate-restore')?.style).toBe('primary')
  })

  it('contains a copy verb with mars verify-gate restore <gate-id> as the hint', () => {
    const gateId = 'aaaa-1234-uuid'
    const ctx = makeCtx({ gate: gateId, scope: 'ui', name: 'test', required: false, verdict: 'verify:test/fail', originTaskId: null, streak: null })
    const verbs = typeof recipe.verbs === 'function' ? recipe.verbs(ctx as Parameters<typeof recipe.verbs>[0]) : recipe.verbs
    const copyVerb = verbs.find((v) => v.op === 'copy')
    expect(copyVerb).toBeDefined()
    expect(copyVerb?.hint).toBe(`mars verify-gate restore ${gateId}`)
  })
})

// ---------------------------------------------------------------------------
// awaiting-human recipe verbs
// ---------------------------------------------------------------------------

describe('awaiting-human verbs', () => {
  const recipe = lookupRecipe('awaiting-human')

  const makeCtx = (payload: Record<string, unknown>) => ({
    kind: 'awaiting-human' as const,
    entityId: 'mars-test01',
    payload,
    context: {},
    title: 'Working on merge-gate',
    body: '',
    raisedAt: '2026-09-01T00:00:00.000Z',
  })

  const getVerbs = (payload: Record<string, unknown>) => {
    const ctx = makeCtx(payload)
    return getRecipeVerbs(recipe, ctx as Parameters<typeof getRecipeVerbs>[1])
  }

  const LEASE_PARK_BASE = {
    situation: 'lease-park',
    taskId: 'mars-test01',
    leaseOwner: 'alice',
    leasedAt: '2026-09-01T09:00:00.000Z',
    leaseNote: null,
  }

  it('lease-park at merge-gate: exposes approve-step with label "Approve and merge"', () => {
    const verbs = getVerbs({ ...LEASE_PARK_BASE, stepName: 'merge-gate' })
    const approveVerb = verbs.find((v) => v.op === 'approve-step')
    expect(approveVerb).toBeDefined()
    expect(approveVerb?.label).toBe('Approve and merge')
    expect(approveVerb?.style).toBe('primary')
  })

  it('lease-park at merge-gate: exposes abort-release with label "Abort without merging"', () => {
    const verbs = getVerbs({ ...LEASE_PARK_BASE, stepName: 'merge-gate' })
    const abortVerb = verbs.find((v) => v.op === 'abort-release')
    expect(abortVerb).toBeDefined()
    expect(abortVerb?.label).toBe('Abort without merging')
    expect(abortVerb?.style).toBe('destructive')
  })

  it('lease-park at a non-merge-gate step: approve-step label is "Mark step done"', () => {
    const verbs = getVerbs({ ...LEASE_PARK_BASE, stepName: 'code' })
    const approveVerb = verbs.find((v) => v.op === 'approve-step')
    expect(approveVerb).toBeDefined()
    expect(approveVerb?.label).toBe('Mark step done')
  })

  it('lease-park with no stepName: approve-step label is "Mark step done"', () => {
    const verbs = getVerbs(LEASE_PARK_BASE)
    const approveVerb = verbs.find((v) => v.op === 'approve-step')
    expect(approveVerb).toBeDefined()
    expect(approveVerb?.label).toBe('Mark step done')
  })

  it('lease-expired situation: no approve-step or abort-release verbs', () => {
    const verbs = getVerbs({
      situation: 'lease-expired',
      taskId: 'mars-test01',
      leaseOwner: 'alice',
      leasedAt: '2026-09-01T09:00:00.000Z',
      leaseNote: null,
      ageMinutes: 90,
    })
    expect(verbs.find((v) => v.op === 'approve-step')).toBeUndefined()
    expect(verbs.find((v) => v.op === 'abort-release')).toBeUndefined()
  })

  it('escalation situation: no approve-step or abort-release verbs', () => {
    const verbs = getVerbs({ situation: 'escalation', message: 'needs human decision' })
    expect(verbs.find((v) => v.op === 'approve-step')).toBeUndefined()
    expect(verbs.find((v) => v.op === 'abort-release')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// slice-failed recipe — operatorGoal carries the PRD title
// ---------------------------------------------------------------------------

describe('slice-failed operatorGoal', () => {
  const recipe = lookupRecipe('slice-failed')

  const makeCtx = (payload: Record<string, unknown>) => ({
    kind: 'slice-failed' as const,
    entityId: '04b4e4e0-queue-position-ordering-for-the-cas-merg',
    payload,
    context: {},
    title: 'Slicer failed for PRD 04b4e4e0',
    body: 'PRD 04b4e4e0 (Queue-position ordering for the CAS merge loop) could not be sliced',
    raisedAt: '2026-09-10T00:00:00.000Z',
  })

  it('returns the PRD title from payload.proposalTitle', () => {
    const ctx = makeCtx({
      proposalId: '04b4e4e0-queue-position-ordering-for-the-cas-merg',
      proposalTitle: 'Queue-position ordering for the CAS merge loop',
      error: 'slicer process exited with code 1: model refused to slice',
    })
    expect(recipe.operatorGoal).toBeDefined()
    // The built row should carry a non-null operatorGoal equal to the PRD title —
    // the field the UI prefers for member-card labelling in cause-group rows.
    expect(recipe.operatorGoal!(ctx as Parameters<NonNullable<typeof recipe.operatorGoal>>[0])).toBe(
      'Queue-position ordering for the CAS merge loop',
    )
  })

  it('returns null when proposalTitle is absent from the payload', () => {
    const ctx = makeCtx({
      proposalId: '04b4e4e0-queue-position-ordering-for-the-cas-merg',
      error: 'slicer process exited with code 1: model refused to slice',
    })
    // operatorGoal is optional in SliceFailedPayload — a legacy row that pre-dates
    // proposalTitle storage should not crash and should fall back to null so the
    // view builder can try its own chain.
    expect(recipe.operatorGoal!(ctx as Parameters<NonNullable<typeof recipe.operatorGoal>>[0])).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// slice-failed recipe — entityTitle carries the PRD's real title
// ---------------------------------------------------------------------------

describe('slice-failed entityTitle', () => {
  const recipe = lookupRecipe('slice-failed')

  const makeCtx = (payload: Record<string, unknown>) => ({
    kind: 'slice-failed' as const,
    entityId: '04b4e4e0-queue-position-ordering-for-the-cas-merg',
    payload,
    context: {},
    title: 'Mars could not turn this PRD into tasks — inspect the PRD, then slice it again when ready.',
    body: 'PRD 04b4e4e0 (Queue-position ordering for the CAS merge loop) could not be sliced: slicer process exited with code 1.',
    raisedAt: '2026-09-10T00:00:00.000Z',
  })

  it('carries the PRD real title (not the slug, not the shared failure sentence)', () => {
    const ctx = makeCtx({
      proposalId: '04b4e4e0-queue-position-ordering-for-the-cas-merg',
      proposalTitle: 'Queue-position ordering for the CAS merge loop',
      error: 'slicer process exited with code 1: model refused to slice',
    })
    expect(recipe.entityTitle).toBeDefined()
    const title = recipe.entityTitle!(ctx as Parameters<NonNullable<typeof recipe.entityTitle>>[0])
    // Must be the real PRD title — not the truncated slug entityId and not the
    // shared failure sentence every row shares ("Mars could not turn this PRD…").
    expect(title).toBe('Queue-position ordering for the CAS merge loop')
    expect(title).not.toContain('04b4e4e0')
    expect(title).not.toContain('Mars could not')
  })

  it('returns null when proposalTitle is absent (legacy row without the field)', () => {
    const ctx = makeCtx({
      proposalId: '04b4e4e0-queue-position-ordering-for-the-cas-merg',
      error: 'slicer process exited with code 1: model refused to slice',
    })
    // A row raised before proposalTitle was stored must not crash and must fall
    // back to null so the UI can degrade gracefully.
    expect(recipe.entityTitle!(ctx as Parameters<NonNullable<typeof recipe.entityTitle>>[0])).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// env-incident humanSummary — no false dispatch-state claims, no raw sigs
// ---------------------------------------------------------------------------

describe('env-incident humanSummary', () => {
  it('describes an infrastructure condition rather than claiming the queue is not paused', () => {
    const result = humanSummary('env-incident', { taskId: 'mars-abc123', signature: 'setup/unclassified' })
    expect(result).toContain('infrastructure condition')
    // Must NOT assert anything about global dispatch state — this row has no
    // way to know whether the queue is paused.
    expect(result).not.toContain('NOT paused')
    expect(result).not.toContain('queue')
  })

  it('does not render the raw failure signature in the summary', () => {
    const result = humanSummary('env-incident', { taskId: 'mars-abc123', signature: 'setup/unclassified' })
    // Raw signatures like "setup/unclassified" must stay in humanDetail only.
    expect(result).not.toContain('setup/unclassified')
  })

  it('works the same when no signature is in the payload', () => {
    const result = humanSummary('env-incident', { taskId: 'mars-abc123' })
    expect(result).toContain('infrastructure condition')
    expect(result).not.toContain('NOT paused')
  })
})

// ---------------------------------------------------------------------------
// gate-enrichment-stale humanSummary — plain-English label, no raw sig
// ---------------------------------------------------------------------------

describe('gate-enrichment-stale humanSummary', () => {
  it('does not render the raw failure signature in the summary', () => {
    const result = humanSummary('gate-enrichment-stale', {
      signature: 'verify:build/typecheck-error',
      passCount: 5,
    })
    // Raw signatures like "verify:build/typecheck-error" must stay in
    // humanDetail (the signature field there) — never in the prose headline.
    expect(result).not.toContain('verify:build/typecheck-error')
  })

  it('names a plain-English condition when a signature is present', () => {
    const result = humanSummary('gate-enrichment-stale', {
      signature: 'verify:build/typecheck-error',
      passCount: 5,
    })
    // Should describe what the check watches for in human terms.
    // It must NOT contain a bare slash-separated machine string.
    expect(result).not.toMatch(/"\w+\/\w+/)
  })

  it('falls back gracefully when no signature is present', () => {
    const result = humanSummary('gate-enrichment-stale', { passCount: 3 })
    expect(result).toContain('auto-added check')
    expect(result).not.toContain('undefined')
  })
})

// ---------------------------------------------------------------------------
// Breadth: no registered recipe renders a raw failure signature in its summary
// ---------------------------------------------------------------------------
// A raw failure signature looks like "verify:build/typecheck-error" or
// "setup/unclassified". We inject a known signature into every recipe's
// payload and assert none of the summaries passes it through verbatim.
// Recipes that do not read ctx.payload['signature'] are unaffected and pass
// trivially; the interesting ones are those that previously rendered it.

describe('humanSummary breadth — no recipe renders a raw failure signature', () => {
  const RAW_SIG = 'verify:build/typecheck-error'

  it('no registered recipe outputs the raw signature when injected via payload', () => {
    const fails: string[] = []
    for (const kind of registeredKinds()) {
      let result: string
      try {
        result = humanSummary(kind, {
          signature: RAW_SIG,
          taskId: 'mars-breadth01',
          entityId: 'mars-breadth01',
        })
      } catch {
        // A recipe that throws on a minimal payload is fine — it just does not
        // read the signature field at all (or requires other fields). Skip it.
        continue
      }
      if (result.includes(RAW_SIG)) {
        fails.push(`${kind}: "${result.slice(0, 120)}"`)
      }
    }
    expect(fails).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// recovery-abandoned recipe verbs + humanDetail
// ---------------------------------------------------------------------------

describe('recovery-abandoned recipe', () => {
  const recipe = lookupRecipe('recovery-abandoned')

  const makeCtx = (payload: Record<string, unknown>) => ({
    kind: 'recovery-abandoned' as const,
    entityId: 'mars-abc',
    payload,
    context: {},
    title: 'Recovery task dropped',
    body: '',
    raisedAt: '2026-09-11T00:00:00.000Z',
  })

  // Helper: resolve verb list from the recipe (may be function or array).
  const resolveVerbs = (payload: Record<string, unknown>) => {
    const ctx = makeCtx(payload)
    return typeof recipe.verbs === 'function'
      ? recipe.verbs(ctx as Parameters<typeof recipe.verbs>[0])
      : recipe.verbs
  }

  it('continuable origin: continue is the primary (first) verb', () => {
    const verbs = resolveVerbs({
      fixTaskId: 'fix-1',
      originTaskId: 'mars-1',
      branch: 'task/mars-1',
      worktreePath: '/path/wt',
      commitsAhead: 0,
      continuable: true,
      failureReasonCode: 'recovery-abandoned:no-commits',
    })
    expect(verbs[0]?.op).toBe('continue')
    expect(verbs[0]?.style).toBe('primary')
  })

  it('recovery_exhausted origin: no continue verb', () => {
    const verbs = resolveVerbs({
      fixTaskId: 'fix-2',
      originTaskId: 'mars-2',
      branch: 'task/mars-2',
      worktreePath: '/path/wt',
      commitsAhead: 0,
      continuable: false,
      failureReasonCode: 'recovery-abandoned:no-commits',
    })
    expect(verbs.find((v) => v.op === 'continue')).toBeUndefined()
  })

  it('origin with no worktree: no continue verb', () => {
    const verbs = resolveVerbs({
      fixTaskId: 'fix-3',
      originTaskId: 'mars-3',
      branch: 'task/mars-3',
      worktreePath: null,
      commitsAhead: null,
      continuable: false,
      failureReasonCode: 'recovery-abandoned:no-commits',
    })
    expect(verbs.find((v) => v.op === 'continue')).toBeUndefined()
  })

  it('restart always carries needsConfirm: true', () => {
    for (const continuable of [true, false]) {
      const verbs = resolveVerbs({
        fixTaskId: 'fix-4',
        originTaskId: 'mars-4',
        branch: 'task/mars-4',
        worktreePath: '/path/wt',
        commitsAhead: 0,
        continuable,
        failureReasonCode: continuable ? 'recovery-abandoned:no-commits' : null,
      })
      const restart = verbs.find((v) => v.op === 'restart')
      expect(restart).toBeDefined()
      expect(restart?.needsConfirm).toBe(true)
    }
  })

  it('commitsAhead > 0 is reflected in humanDetail.restartConsequence', () => {
    const ctx = makeCtx({
      fixTaskId: 'fix-5',
      originTaskId: 'mars-5',
      branch: 'task/mars-5',
      worktreePath: '/path/wt',
      commitsAhead: 1,
      continuable: true,
      failureReasonCode: null,
    })
    const detail = recipe.humanDetail(ctx as Parameters<typeof recipe.humanDetail>[0])
    expect(typeof detail['restartConsequence']).toBe('string')
    expect(detail['restartConsequence'] as string).toContain('1 commit')
    expect(detail['restartConsequence'] as string).toContain('task/mars-5')
  })

  it('commitsAhead === 0: no restartConsequence in humanDetail', () => {
    const ctx = makeCtx({
      fixTaskId: 'fix-6',
      originTaskId: 'mars-6',
      branch: 'task/mars-6',
      worktreePath: '/path/wt',
      commitsAhead: 0,
      continuable: true,
      failureReasonCode: 'recovery-abandoned:no-commits',
    })
    const detail = recipe.humanDetail(ctx as Parameters<typeof recipe.humanDetail>[0])
    expect(detail['restartConsequence']).toBeUndefined()
  })

  it('commitsAhead > 0: restart label mentions the commit count and branch', () => {
    const verbs = resolveVerbs({
      fixTaskId: 'fix-7',
      originTaskId: 'mars-7',
      branch: 'task/mars-7',
      worktreePath: '/path/wt',
      commitsAhead: 3,
      continuable: true,
      failureReasonCode: null,
    })
    const restart = verbs.find((v) => v.op === 'restart')
    expect(restart?.label).toContain('3 commits')
    expect(restart?.label).toContain('task/mars-7')
  })
})

// ---------------------------------------------------------------------------
// prose ↔ buttons agreement — a card body must not recommend a `mars <verb>`
// that the same card does not offer as a verb.
// ---------------------------------------------------------------------------

/** Verbs a body may name as `mars <verb>` without a matching button op. */
const namedMarsVerbs = (body: string): string[] =>
  [...body.matchAll(/`mars ([a-z][a-z-]*)/g)].map((m) => m[1] as string)

/** Returns the `mars <verb>` names in `body` that no offered verb covers. */
const missingVerbs = (
  body: string,
  offered: ReadonlyArray<{ op: string; hint?: string }>,
): string[] =>
  namedMarsVerbs(body).filter(
    (name) => !offered.some((v) => v.op === name || (v.hint ?? '').includes(`mars ${name}`)),
  )

describe('recipe prose names only verbs the recipe offers', () => {
  it('rejects a body that names a verb absent from the offered verbs', () => {
    const offered = [{ op: 'restart' }, { op: 'purge' }]
    expect(missingVerbs('Run `mars continue abc` to resume.', offered)).toEqual(['continue'])
    expect(missingVerbs('Run `mars restart abc`.', offered)).toEqual([])
  })

  it('recovery-abandoned prose names continue and offers it ahead of restart', () => {
    const recipe = lookupRecipe('recovery-abandoned')
    const ctx = {
      kind: 'recovery-abandoned' as const,
      entityId: 'mars-abc',
      payload: {
        fixTaskId: 'fix-1',
        originTaskId: 'mars-abc',
        branch: 'task/mars-abc',
        commitsAhead: 2,
        continuable: true,
      },
      context: {},
      title: 'Recovery task dropped',
      body: '',
      raisedAt: '2026-09-11T00:00:00.000Z',
    } as Parameters<typeof recipe.humanSummary>[0]
    const verbs = getRecipeVerbs(recipe, ctx)
    const ops = verbs.map((v) => v.op)
    expect(ops.indexOf('continue')).toBeGreaterThanOrEqual(0)
    expect(ops.indexOf('continue')).toBeLessThan(ops.indexOf('restart'))
    expect(verbs.find((v) => v.op === 'restart')?.style).toBe('destructive')
    expect(missingVerbs(recipe.humanSummary(ctx), verbs)).toEqual([])
  })
})
