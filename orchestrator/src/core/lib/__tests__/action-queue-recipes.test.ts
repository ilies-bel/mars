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
import { getRecipeVerbs, humanSummary, lookupRecipe } from '../action-queue-recipes'

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
