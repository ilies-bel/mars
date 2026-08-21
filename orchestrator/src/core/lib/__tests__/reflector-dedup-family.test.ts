/**
 * Slice 5 of the "align self-improvement loops with weakest-valid-hypothesis
 * induction" PRD: two reflection suggestions whose root cause is the same
 * gate/error-class family must collapse into one open draft even when the
 * model echoed the underlying failure signature with a differently-worded
 * step-kind segment (e.g. `verify:has-diff/...` vs `verify:typecheck/...`).
 *
 * Mirrors the store-boundary integration style of reflector-persist.test.ts:
 * exercises persistSuggestions through the real proposals store rather than
 * mocking internal collaborators.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-reflect-dedup-family-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const countProposals = async (): Promise<number> => {
  const { listProposals } = await import('../../proposals')
  return (await listProposals()).length
}

const fingerprintOf = (rootCauseKey: string): string =>
  createHash('sha256').update(`reflection:${rootCauseKey}:`).digest('hex').slice(0, 32)

describe('reflector persist dedup — signature family normalization', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  const baseOutcome = {
    type: 'leverGap' as const,
    leverGap: {
      proposedLeverId: 'verify.typecheck-flags',
      family: 'verify',
      whatItWouldControl: 'typecheck strictness flags',
    },
  }

  it('same-family, differently-worded signature rootCauseKeys merge into one draft', async () => {
    const { persistSuggestions } = await import('../reflector')
    const { failureSignatureFamily, isSameFailureFamily } = await import('../failure-signature')

    // Same gate + error class, different step-kind segment — same family.
    const sigA = 'verify:has-diff/no-commits-ahead'
    const sigB = 'verify:typecheck/no-commits-ahead'
    expect(isSameFailureFamily(sigA, sigB)).toBe(true)
    expect(sigA).not.toBe(sigB)

    await persistSuggestions(
      [
        {
          title: 'Investigate recurring no-commits-ahead failures',
          prompt: `Investigate ${sigA}. Save your work.`,
          rationale: 'task-a failed with this signature',
          rootCauseKey: sigA,
          affectedTaskIds: ['task-a'],
          frequency: 1,
          confidence: 0,
          kind: 'mechanical' as const,
          outcome: baseOutcome,
        },
      ],
      'source-task-1',
    )
    expect(await countProposals()).toBe(1)

    await persistSuggestions(
      [
        {
          title: 'Investigate recurring no-commits-ahead failures',
          prompt: `Investigate ${sigB}. Save your work.`,
          rationale: 'task-b also failed, same family, worded differently',
          rootCauseKey: sigB,
          affectedTaskIds: ['task-b'],
          frequency: 1,
          confidence: 0,
          kind: 'mechanical' as const,
          outcome: baseOutcome,
        },
      ],
      'source-task-2',
    )

    // Still exactly one proposal — the two signatures share a fingerprint
    // once normalised through failureSignatureFamily.
    expect(await countProposals()).toBe(1)

    const { findOpenReflectionDraftByFingerprint } = await import('../../proposals')
    const family = failureSignatureFamily(sigA)
    expect(family).toBe(failureSignatureFamily(sigB))
    const draft = await findOpenReflectionDraftByFingerprint(fingerprintOf(family))
    expect(draft).not.toBeNull()
    // Second run appended evidence to the existing draft instead of forking.
    expect(draft?.notes).toMatch(/task-b/)
  })

  it('non-signature rootCauseKey hashes unchanged (no behaviour change)', async () => {
    const { persistSuggestions } = await import('../reflector')

    await persistSuggestions(
      [
        {
          title: 'Fix typecheck failures',
          prompt: 'Fix the typecheck errors. Save your work.',
          rationale: 'tasks task-a, task-b both failed with TS2345',
          rootCauseKey: 'typecheck_failure',
          affectedTaskIds: ['task-a', 'task-b'],
          frequency: 2,
          confidence: 0,
          kind: 'mechanical' as const,
          outcome: baseOutcome,
        },
      ],
      'source-task-1',
    )

    expect(await countProposals()).toBe(1)

    const { findOpenReflectionDraftByFingerprint } = await import('../../proposals')
    // Same fingerprint formula as before this change: the plain slug is
    // hashed verbatim, with no family normalization applied.
    const draft = await findOpenReflectionDraftByFingerprint(fingerprintOf('typecheck_failure'))
    expect(draft).not.toBeNull()
  })
})
