/**
 * Acceptance tests for the diagnose-verdict store (mars diagnose set/show).
 *
 * Each test exercises the public interface through diagnose-verdict.ts —
 * the same surface the CLI and orchestrator use — so the tests survive any
 * internal refactor of the persistence layer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface VerdictModule {
  setDiagnosis: typeof import('../diagnose-verdict').setDiagnosis
  getDiagnosis: typeof import('../diagnose-verdict').getDiagnosis
  DIAGNOSIS_KINDS: typeof import('../diagnose-verdict').DIAGNOSIS_KINDS
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-diagnose-verdict-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModule = async (repo: string): Promise<VerdictModule> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = await import('../../queue')
  await q.migrateQueueSchema()
  return (await import('../diagnose-verdict')) as unknown as VerdictModule
}

describe('diagnose-verdict set/show', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    delete process.env.MARS_REPO
  })

  // Acceptance: set with root-cause verdict stores evidence, files, fix-direction
  it('set then show round-trips a root-cause-found verdict', async () => {
    const m = await loadModule(repo)
    await m.setDiagnosis('mars-aaaaaaaa', {
      kind: 'root-cause-found',
      evidence: 'foo() throws when bar is null at src/foo.ts:42',
      involvedFiles: ['src/foo.ts', 'src/bar.ts'],
      fixDirection: 'guard bar with optional-chain before calling foo()',
    })
    const got = await m.getDiagnosis('mars-aaaaaaaa')
    expect(got.kind).toBe('root-cause-found')
    if (got.kind !== 'root-cause-found') return
    expect(got.evidence).toContain('src/foo.ts:42')
    expect(got.involvedFiles).toEqual(['src/foo.ts', 'src/bar.ts'])
    expect(got.fixDirection).toContain('optional-chain')
    expect(got.taskId).toBe('mars-aaaaaaaa')
    expect(typeof got.recordedAt).toBe('number')
    expect(got.recordedAt).toBeGreaterThan(0)
  })

  // Acceptance: set with inconclusive verdict stores what-was-checked, why-unscoped
  it('set then show round-trips an inconclusive verdict', async () => {
    const m = await loadModule(repo)
    await m.setDiagnosis('mars-bbbbbbbb', {
      kind: 'inconclusive',
      whatChecked: 'read src/foo.ts, src/bar.ts; no failure pattern found',
      whyUnscoped: 'feature referenced in the task does not exist in the repo',
    })
    const got = await m.getDiagnosis('mars-bbbbbbbb')
    expect(got.kind).toBe('inconclusive')
    if (got.kind !== 'inconclusive') return
    expect(got.whatChecked).toContain('src/foo.ts')
    expect(got.whyUnscoped).toContain('does not exist')
    expect(got.taskId).toBe('mars-bbbbbbbb')
    expect(typeof got.recordedAt).toBe('number')
    expect(got.recordedAt).toBeGreaterThan(0)
  })

  // Acceptance: show for task with no recorded verdict returns explicit no-verdict state
  it('show for an unrecorded task returns no-verdict (not an error)', async () => {
    const m = await loadModule(repo)
    const got = await m.getDiagnosis('mars-cccccccc')
    expect(got.kind).toBe('no-verdict')
    expect(got.taskId).toBe('mars-cccccccc')
    // Must be distinguishable from both verdict kinds
    expect(got.kind).not.toBe('root-cause-found')
    expect(got.kind).not.toBe('inconclusive')
  })

  // Acceptance: unknown verdict kind rejected at set time
  it('rejects a verdict kind other than root-cause-found or inconclusive', async () => {
    const m = await loadModule(repo)
    await expect(
      m.setDiagnosis('mars-dddddddd', {
        kind: 'maybe' as 'root-cause-found',
        evidence: 'x',
        involvedFiles: ['src/x.ts'],
        fixDirection: 'y',
      }),
    ).rejects.toThrow(/kind must be one of/)
    // Nothing persisted
    const got = await m.getDiagnosis('mars-dddddddd')
    expect(got.kind).toBe('no-verdict')
  })

  // Acceptance: recording twice leaves only the latest verdict
  it('second set overwrites the first — only latest verdict is readable', async () => {
    const m = await loadModule(repo)
    await m.setDiagnosis('mars-eeeeeeee', {
      kind: 'inconclusive',
      whatChecked: 'first pass',
      whyUnscoped: 'still unclear after first pass',
    })
    await m.setDiagnosis('mars-eeeeeeee', {
      kind: 'root-cause-found',
      evidence: 'deeper read revealed foo() is the culprit',
      involvedFiles: ['src/foo.ts'],
      fixDirection: 'rewrite foo() with null-guard',
    })
    const got = await m.getDiagnosis('mars-eeeeeeee')
    // Only the second (root-cause) verdict survives
    expect(got.kind).toBe('root-cause-found')
    if (got.kind !== 'root-cause-found') return
    expect(got.evidence).toContain('foo()')
  })

  // Additional guard: DIAGNOSIS_KINDS constant enumerates the two valid kinds
  it('DIAGNOSIS_KINDS contains exactly root-cause-found and inconclusive', async () => {
    const m = await loadModule(repo)
    expect(m.DIAGNOSIS_KINDS).toContain('root-cause-found')
    expect(m.DIAGNOSIS_KINDS).toContain('inconclusive')
    expect(m.DIAGNOSIS_KINDS).toHaveLength(2)
  })
})
