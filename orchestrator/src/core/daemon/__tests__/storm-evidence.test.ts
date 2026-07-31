/**
 * Regression tests for the signature-storm evidence lookup.
 *
 * The live defect: the streak counter tripped on the COARSE form of a
 * signature (`code/uncommitted-changes`, minted by the durable recovery-spawn
 * subscriber, which can only recover `failed_phase` when `failure_reason`
 * holds a whole signature), while the `failure_signature` COLUMN held the
 * STEP-QUALIFIED form the primitive stamped
 * (`code:commit-contract/uncommitted-changes`). The lookup matched with exact
 * equality, so it found only the one padding-only row and the daemon logged
 * "no usable failure output" while kilobytes of real output sat unread — and
 * the Steward was dispatched blind.
 *
 * These tests seed rows in BOTH signature forms and assert the collector
 * returns the usable excerpts. Against the old exact-equality query the first
 * test fails (zero usable excerpts, the step-qualified rows are invisible).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { DbClient } from '../../lib/db.js'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  updateTask: typeof import('../../queue').updateTask
  ensureQueueSchema: typeof import('../../queue').ensureQueueSchema
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
}

interface StormEvidenceModule {
  collectStormEvidence: typeof import('../storm-evidence').collectStormEvidence
}

/** The two granularities ONE commit-contract failure is recorded at. */
const FINE_SIGNATURE = 'code:commit-contract/uncommitted-changes'
const COARSE_SIGNATURE = 'code/uncommitted-changes'

/** Real captured output — long and specific enough to pass assessStormExcerpt. */
const capturedOutput = (taskId: string): string =>
  [
    `task ${taskId} worktree has uncommitted changes after the code step: coder left 2 path(s) uncommitted`,
    '',
    'The coder committed 1 commit(s) onto task/x but did not commit these path(s):',
    '  orchestrator/src/core/daemon/server.ts',
    '  orchestrator/src/core/lib/failure-signature.ts',
    '',
    'Worktree: /tmp/mars/worktrees/' + taskId,
  ].join('\n')

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-storm-evidence-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; se: StormEvidenceModule; client: DbClient }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.ensureQueueSchema()
  const se = (await import('../storm-evidence')) as unknown as StormEvidenceModule
  return { q, se, client: q.resolveQueueClient() }
}

/** Seed one failed task carrying `signature` on both signature columns. */
const seedFailedTask = async (
  q: QueueModule,
  args: { signature: string; error: string | null },
): Promise<string> => {
  const task = await q.enqueueTask('storm evidence fixture', undefined, {
    skipTriage: true,
  })
  await q.updateTask(task.id, {
    status: 'failed',
    error: args.error,
    failedPhase: 'code',
    failureReason: args.signature,
    failureSignature: args.signature,
    failureReasonCode: args.signature,
  })
  return task.id
}

describe('collectStormEvidence', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('finds step-qualified rows when the storm tripped on the coarse signature', async () => {
    const { q, se } = await loadModules(repo)

    const fineIds = [
      await seedFailedTask(q, { signature: FINE_SIGNATURE, error: capturedOutput('fix-621f767d') }),
      await seedFailedTask(q, { signature: FINE_SIGNATURE, error: capturedOutput('fix-ec2f6c04') }),
      await seedFailedTask(q, { signature: FINE_SIGNATURE, error: capturedOutput('fix-139f327c') }),
    ]
    // The one row the old exact-equality query DID match: its `error` is the
    // derived `recovery_failed:` padding assessStormExcerpt rightly rejects.
    const paddedId = await seedFailedTask(q, {
      signature: COARSE_SIGNATURE,
      error: `recovery_failed:${COARSE_SIGNATURE}: recovery_failed:${COARSE_SIGNATURE}: recovery_failed:${COARSE_SIGNATURE}:`,
    })

    const evidence = await se.collectStormEvidence({
      db: q.resolveQueueClient(),
      signature: COARSE_SIGNATURE,
      lastTaskId: paddedId,
    })

    // The whole point: real evidence reaches the brief.
    expect(evidence.usableEvidenceCount).toBe(3)
    const usable = evidence.failureExcerpts.filter((e) => e.usable)
    expect(usable.map((e) => e.taskId).sort()).toEqual([...fineIds].sort())
    for (const excerpt of usable) {
      expect(excerpt.signature).toBe(FINE_SIGNATURE)
      expect(excerpt.excerpt).toContain('did not commit these path(s)')
    }
    // The padding row is still collected, still flagged unusable — the excerpt
    // assessor's bar is not lowered by this fix.
    const padded = evidence.failureExcerpts.find((e) => e.taskId === paddedId)
    expect(padded?.usable).toBe(false)
    expect(evidence.affectedTaskIds).toContain(paddedId)
  })

  it('finds coarse rows when the storm tripped on the step-qualified signature', async () => {
    const { q, se } = await loadModules(repo)

    const coarseId = await seedFailedTask(q, {
      signature: COARSE_SIGNATURE,
      error: capturedOutput('fix-acf13b06'),
    })

    const evidence = await se.collectStormEvidence({
      db: q.resolveQueueClient(),
      signature: FINE_SIGNATURE,
      lastTaskId: coarseId,
    })

    expect(evidence.usableEvidenceCount).toBe(1)
    expect(evidence.failureExcerpts[0]?.taskId).toBe(coarseId)
    expect(evidence.failureExcerpts[0]?.signature).toBe(COARSE_SIGNATURE)
  })

  it('excludes in-flight rows that have captured no output', async () => {
    const { q, se } = await loadModules(repo)

    // An in-flight sibling: signature stamped, `error` still null. It has no
    // diagnostic byte to contribute and must not spend a LIMIT slot.
    const inFlightId = await seedFailedTask(q, { signature: FINE_SIGNATURE, error: null })
    const withOutput = await seedFailedTask(q, {
      signature: FINE_SIGNATURE,
      error: capturedOutput('fix-621f767d'),
    })

    const evidence = await se.collectStormEvidence({
      db: q.resolveQueueClient(),
      signature: COARSE_SIGNATURE,
      lastTaskId: withOutput,
    })

    expect(evidence.failureExcerpts.map((e) => e.taskId)).toEqual([withOutput])
    expect(evidence.affectedTaskIds).not.toContain(inFlightId)
    expect(evidence.usableEvidenceCount).toBe(1)
  })

  it('does not match a different error class in the same gate', async () => {
    const { q, se } = await loadModules(repo)

    const otherId = await seedFailedTask(q, {
      signature: 'code:coder-exit-nonzero/api-unreachable',
      error: capturedOutput('fix-unrelated'),
    })

    const evidence = await se.collectStormEvidence({
      db: q.resolveQueueClient(),
      signature: COARSE_SIGNATURE,
      lastTaskId: 'fix-storm-origin',
    })

    expect(evidence.failureExcerpts).toHaveLength(0)
    expect(evidence.affectedTaskIds).toEqual(['fix-storm-origin'])
    expect(evidence.affectedTaskIds).not.toContain(otherId)
  })

  it('ranks exact-signature rows ahead of same-family rows', async () => {
    const { q, se } = await loadModules(repo)

    // Seeded oldest → newest, so plain `updated_at DESC` would put the
    // step-qualified row first. The exact match must still lead.
    const exactId = await seedFailedTask(q, {
      signature: COARSE_SIGNATURE,
      error: capturedOutput('fix-exact'),
    })
    await seedFailedTask(q, { signature: FINE_SIGNATURE, error: capturedOutput('fix-family') })

    const evidence = await se.collectStormEvidence({
      db: q.resolveQueueClient(),
      signature: COARSE_SIGNATURE,
      lastTaskId: exactId,
    })

    expect(evidence.failureExcerpts).toHaveLength(2)
    expect(evidence.failureExcerpts[0]?.taskId).toBe(exactId)
  })
})
