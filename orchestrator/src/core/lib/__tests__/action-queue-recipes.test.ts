/**
 * Tests for the verify-uncovered recipe in action-queue-recipes.ts.
 *
 * Covers both provenances of verify-uncovered rows:
 *   - sweep-raised (proposedGate present): observation wording, no "merged" claim
 *   - merge-raised (proposedGate absent): keeps the existing merge wording
 *
 * Also asserts that a '.' scope renders as "the repository root" so no bare
 * period ever reaches the operator.
 */

import { describe, expect, it } from 'vitest'
import { humanSummary, lookupRecipe } from '../action-queue-recipes'

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
