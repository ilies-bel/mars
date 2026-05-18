import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface DiagnoseModule {
  setDiagnosis: typeof import('../diagnose').setDiagnosis
  getDiagnosis: typeof import('../diagnose').getDiagnosis
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-diagnose-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModule = async (repo: string): Promise<DiagnoseModule> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = await import('../../queue')
  await q.initQueue()
  return (await import('../diagnose')) as unknown as DiagnoseModule
}

describe('diagnose verdict store', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    delete process.env.MARS_REPO
  })

  it('round-trips a root-cause verdict', async () => {
    const m = await loadModule(repo)
    await m.setDiagnosis('mars-aaaaaaaa', {
      kind: 'root-cause-found',
      evidence: 'foo() rejects when bar is null at line 42',
      involvedFiles: ['src/foo.ts', 'src/bar.ts'],
      fixDirection: 'guard bar with the optional-chain operator before calling foo',
    })
    const got = await m.getDiagnosis('mars-aaaaaaaa')
    expect(got.kind).toBe('root-cause-found')
    if (got.kind !== 'root-cause-found') return
    expect(got.evidence).toBe('foo() rejects when bar is null at line 42')
    expect(got.involvedFiles).toEqual(['src/foo.ts', 'src/bar.ts'])
    expect(got.fixDirection).toContain('optional-chain')
    expect(got.taskId).toBe('mars-aaaaaaaa')
    expect(got.recordedAt).toMatch(/\d{4}-\d{2}-\d{2}T/)
  })

  it('round-trips an inconclusive verdict', async () => {
    const m = await loadModule(repo)
    await m.setDiagnosis('mars-bbbbbbbb', {
      kind: 'inconclusive',
      whatChecked: 'read foo.ts, bar.ts, baz.ts; no clear failure pattern',
      whyUnscoped: 'task description references a feature that does not exist in the repo',
    })
    const got = await m.getDiagnosis('mars-bbbbbbbb')
    expect(got.kind).toBe('inconclusive')
    if (got.kind !== 'inconclusive') return
    expect(got.whatChecked).toMatch(/foo.ts/)
    expect(got.whyUnscoped).toMatch(/does not exist/)
  })

  it('returns no-verdict for an unrecorded task', async () => {
    const m = await loadModule(repo)
    const got = await m.getDiagnosis('mars-cccccccc')
    expect(got.kind).toBe('no-verdict')
    expect(got.taskId).toBe('mars-cccccccc')
  })

  it('rejects unknown kinds at set time', async () => {
    const m = await loadModule(repo)
    await expect(
      m.setDiagnosis('mars-dddddddd', {
        // deliberate cast: simulate a bad caller
        kind: 'maybe' as 'root-cause-found',
        evidence: 'x',
        involvedFiles: ['y'],
        fixDirection: 'z',
      }),
    ).rejects.toThrow(/kind must be one of/)
    const got = await m.getDiagnosis('mars-dddddddd')
    expect(got.kind).toBe('no-verdict')
  })

  it('rejects a root-cause verdict with missing required fields', async () => {
    const m = await loadModule(repo)
    await expect(
      m.setDiagnosis('mars-eeeeeeee', {
        kind: 'root-cause-found',
        evidence: '',
        involvedFiles: ['src/foo.ts'],
        fixDirection: 'fix it',
      }),
    ).rejects.toThrow(/evidence is required/)
    await expect(
      m.setDiagnosis('mars-eeeeeeee', {
        kind: 'root-cause-found',
        evidence: 'x',
        involvedFiles: [],
        fixDirection: 'y',
      }),
    ).rejects.toThrow(/involved file/)
    const got = await m.getDiagnosis('mars-eeeeeeee')
    expect(got.kind).toBe('no-verdict')
  })

  it('rejects an inconclusive verdict with blank fields', async () => {
    const m = await loadModule(repo)
    await expect(
      m.setDiagnosis('mars-ffffffff', {
        kind: 'inconclusive',
        whatChecked: '   ',
        whyUnscoped: 'task scope is unclear',
      }),
    ).rejects.toThrow(/what-checked is required/)
  })

  it('overwrites a prior verdict when recording a second one', async () => {
    const m = await loadModule(repo)
    await m.setDiagnosis('mars-gggggggg', {
      kind: 'inconclusive',
      whatChecked: 'first pass',
      whyUnscoped: 'still unclear',
    })
    await m.setDiagnosis('mars-gggggggg', {
      kind: 'root-cause-found',
      evidence: 'after deeper read, foo() is the culprit',
      involvedFiles: ['src/foo.ts'],
      fixDirection: 'rewrite foo',
    })
    const got = await m.getDiagnosis('mars-gggggggg')
    expect(got.kind).toBe('root-cause-found')
  })
})
